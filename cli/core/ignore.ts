// User-configurable ignore patterns: a small, dependency-free matcher for a
// practical subset of gitignore syntax, plus the loader for `.tyrignore`.
//
// Patterns come from two places and are evaluated as one ordered list:
//   1. `scan.extraIgnore` in `.tyr/tyr.json` (string array)
//   2. `.tyrignore` at the project root (one pattern per line)
// They only *add* to the scanner's built-in IGNORED_DIRS / IGNORED_EXTENSIONS;
// a negation here can un-ignore something an earlier user pattern ignored, but
// it can never resurrect `node_modules`, `.git`, `.tyr`, and friends.
//
// Supported syntax (a subset of gitignore):
//   - Blank lines and lines starting with `#` are ignored. Use `\#` for a
//     pattern that really starts with `#`, and `\!` for one starting with `!`.
//   - Trailing whitespace is trimmed.
//   - `*` matches any run of characters except `/`.
//   - `?` matches exactly one character except `/`.
//   - `**` as a whole path segment matches across directories:
//       `**/foo`   foo at any depth (including the root)
//       `a/**/b`   b anywhere under a, including `a/b`
//       `a/**`     everything inside a
//     A `**` that is not a whole segment behaves like `*`.
//   - A trailing `/` restricts the pattern to directories.
//   - A leading `/`, or a `/` anywhere but the end, anchors the pattern to the
//     project root. Otherwise it matches the entry's basename at any depth.
//   - A leading `!` negates: a matching path is un-ignored. The last matching
//     pattern wins.
//   - `\` escapes the next character, so `\*` is a literal asterisk.
//
// Not supported: character classes (`[abc]` is matched literally), nested
// `.tyrignore` files in subdirectories, and per-file `.gitignore` reading.
//
// Like gitignore, a file cannot be re-included once its parent directory is
// ignored: the scanner prunes ignored directories and never looks inside, so
// `build-output/` followed by `!build-output/keep.txt` still skips keep.txt.
//
// The matching half of this module is deliberately silent and synchronous;
// only `readTyrIgnore` touches the filesystem.

import * as fs from "node:fs/promises";
import * as path from "node:path";

/** File name of the project-level ignore file, read from the project root. */
export const TYR_IGNORE_FILE = ".tyrignore";

/** One compiled pattern line. */
interface IgnoreRule {
    /** The original line, kept for debugging. */
    source: string;
    /** True for `!pattern`: a match un-ignores instead of ignoring. */
    negate: boolean;
    /** True for `pattern/`: only directories can match. */
    dirOnly: boolean;
    /** Tested against the root-relative POSIX path of the entry. */
    regex: RegExp;
}

export interface IgnoreMatcher {
    /** How many usable patterns were compiled (comments and blanks excluded). */
    readonly size: number;
    /**
     * Decide whether one walk entry is ignored. `relPath` is relative to the
     * project root and uses `/` separators, with no leading `./` or `/`.
     */
    ignores(relPath: string, isDirectory: boolean): boolean;
}

/** Characters with special meaning in a RegExp that must be escaped literally. */
function escapeRegexChar(char: string): string {
    return /[.*+?^${}()|[\]\\/]/.test(char) ? `\\${char}` : char;
}

/**
 * Translate the glob body of one pattern (negation and trailing `/` already
 * removed, no leading `/`) into a regex source string anchored at both ends.
 */
function globToRegexSource(glob: string): string {
    const segments = glob.split("/");
    let out = "";

    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const isFirst = i === 0;
        const isLast = i === segments.length - 1;

        if (segment === "**") {
            if (isLast) {
                // `a/**` — everything inside a. The preceding `/` was already
                // emitted, so match one or more characters of anything.
                out += isFirst ? ".*" : ".+";
            } else {
                // `**/b` or `a/**/b` — zero or more whole directories. Folding
                // the following `/` in here is what lets `a/**/b` match `a/b`.
                out += "(?:.*/)?";
            }
            continue;
        }

        out += segmentToRegexSource(segment);
        if (!isLast) {
            out += "/";
        }
    }

    return `^${out}$`;
}

/** Translate a single path segment: `*`, `?`, and `\` escapes; all else literal. */
function segmentToRegexSource(segment: string): string {
    let out = "";

    for (let i = 0; i < segment.length; i++) {
        const char = segment[i];

        if (char === "\\" && i + 1 < segment.length) {
            // Escaped character: always literal.
            out += escapeRegexChar(segment[i + 1]);
            i++;
        } else if (char === "*") {
            // Collapse runs like `**` inside a segment (`foo**bar`) into one `*`,
            // matching git's treatment of non-segment double stars.
            while (segment[i + 1] === "*") {
                i++;
            }
            out += "[^/]*";
        } else if (char === "?") {
            out += "[^/]";
        } else {
            out += escapeRegexChar(char);
        }
    }

    return out;
}

/** Compile one raw line into a rule, or null for blanks, comments, and no-ops. */
function compileRule(line: string): IgnoreRule | null {
    // gitignore trims trailing spaces (unless escaped); leading ones are kept,
    // but a stray CR from a Windows-edited file must go too.
    let pattern = line.replace(/\r$/, "").replace(/(?<!\\)\s+$/, "");

    if (pattern === "" || pattern.startsWith("#")) {
        return null;
    }

    let negate = false;
    if (pattern.startsWith("!")) {
        negate = true;
        pattern = pattern.slice(1);
    } else if (pattern.startsWith("\\!") || pattern.startsWith("\\#")) {
        // Escaped leading `!`/`#`: drop the backslash, keep the character.
        pattern = pattern.slice(1);
    }

    let dirOnly = false;
    if (pattern.endsWith("/")) {
        dirOnly = true;
        pattern = pattern.replace(/\/+$/, "");
    }

    // Any remaining `/` (leading or in the middle) anchors to the root;
    // otherwise the pattern may match at any depth, i.e. behaves like `**/pat`.
    const anchored = pattern.includes("/");
    pattern = pattern.replace(/^\/+/, "");

    if (pattern === "") {
        // `/`, `!`, `!/` and similar have nothing left to match.
        return null;
    }

    const glob = anchored ? pattern : `**/${pattern}`;
    return {
        source: line,
        negate,
        dirOnly,
        regex: new RegExp(globToRegexSource(glob)),
    };
}

/**
 * Compile an ordered list of pattern lines into a matcher. Later patterns take
 * precedence over earlier ones, so callers should pass lower-priority sources
 * (tyr.json) before higher-priority ones (.tyrignore).
 */
export function compileIgnore(patterns: readonly string[]): IgnoreMatcher {
    const rules: IgnoreRule[] = [];
    for (const line of patterns) {
        const rule = compileRule(line);
        if (rule !== null) {
            rules.push(rule);
        }
    }

    return {
        size: rules.length,
        ignores(relPath: string, isDirectory: boolean): boolean {
            let ignored = false;
            // Walk every rule rather than stopping early: the last match wins.
            for (const rule of rules) {
                if (rule.dirOnly && !isDirectory) {
                    continue;
                }
                if (rule.regex.test(relPath)) {
                    ignored = !rule.negate;
                }
            }
            return ignored;
        },
    };
}

/** Count the lines that would compile into a rule, for user-facing summaries. */
export function countPatterns(patterns: readonly string[]): number {
    return patterns.reduce((count, line) => (compileRule(line) === null ? count : count + 1), 0);
}

/**
 * Read `.tyrignore` from the project root as raw lines. Returns null when the
 * file is absent or unreadable — a missing ignore file is normal, not an error.
 */
export async function readTyrIgnore(root: string): Promise<string[] | null> {
    try {
        const raw = await fs.readFile(path.join(path.resolve(root), TYR_IGNORE_FILE), "utf8");
        return raw.split("\n");
    } catch {
        return null;
    }
}
