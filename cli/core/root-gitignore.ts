// Root `.gitignore` handling: decides whether the project's own `.gitignore`
// already keeps `.tyr/` out of git, and appends an entry when asked to.
//
// Like scaffold.ts this module never prints. `tyr init` owns the flags, the
// prompt and the output; everything here is either pure string work or a
// single read/atomic write of `<root>/.gitignore`.
//
// Which entry: the whole directory, `/.tyr/`. The obvious alternative is to
// commit `tyr.json` and ignore only the runtime output, but tyr.json is not
// portable today: `project.root` is an absolute, machine-specific path, and
// `git.headCommit`, `project.fileCount` and `initializedAt` change on every
// re-init. A committed copy goes stale on the next commit, and a teammate who
// clones it is refused by `tyr init` ("already initialized") until they pass
// `--force`. Runtime output under state/, logs/ and reports/ is already
// covered by the generated `.tyr/.gitignore`, so a narrower entry would add
// nothing. Teams that do want to share one tyr.json can simply decline (or
// pass `--no-gitignore`) and commit it alongside `.tyr/.gitignore`.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TYR_DIR_NAME, writeFileAtomic } from "./scaffold.js";

/** The line Tyr offers to add. Anchored so a nested `.tyr/` is untouched. */
export const TYR_GITIGNORE_ENTRY = `/${TYR_DIR_NAME}/`;

/** Comment written on the line above the entry. */
export const TYR_GITIGNORE_COMMENT = "# Tyr";

/**
 * Spellings that already ignore the whole directory at the root. `.tyr` and
 * `.tyr/` are unanchored and also match deeper down, which is a superset of
 * what we want, so they count.
 */
const COVERING_LINES = new Set([
    ".tyr",
    ".tyr/",
    "/.tyr",
    "/.tyr/",
    ".tyr/*",
    "/.tyr/*",
    ".tyr/**",
    "/.tyr/**",
]);

/** What `tyr init` ended up doing about the root `.gitignore`. */
export type GitignoreOutcome = "added" | "present" | "skipped" | "declined";

export function rootGitignorePath(root: string): string {
    return path.join(path.resolve(root), ".gitignore");
}

/** Contents of `<root>/.gitignore`, or null when it does not exist. */
export async function readRootGitignore(root: string): Promise<string | null> {
    try {
        return await fs.readFile(rootGitignorePath(root), "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
}

/**
 * True when some line already ignores `.tyr/` (exact match against the
 * spellings above). Trailing whitespace is dropped, as git itself does, and
 * CRLF files split cleanly because `\r` is whitespace. Comments and
 * negations never match.
 */
export function isTyrIgnored(contents: string | null): boolean {
    if (contents === null) return false;
    return contents.split("\n").some((line) => COVERING_LINES.has(line.trimEnd()));
}

/**
 * `contents` with the Tyr block appended. Keeps the file's line-ending style
 * (CRLF if it already uses any), terminates an unterminated last line first,
 * and separates the block from existing rules with a blank line.
 */
export function appendTyrEntry(contents: string | null): string {
    const existing = contents ?? "";
    const eol = existing.includes("\r\n") ? "\r\n" : "\n";
    const block = `${TYR_GITIGNORE_COMMENT}${eol}${TYR_GITIGNORE_ENTRY}${eol}`;

    if (existing === "") return block;

    let prefix = existing;
    if (!prefix.endsWith("\n")) prefix += eol;
    // One blank line between the user's last rule and ours, unless there is one already.
    if (!prefix.endsWith(`${eol}${eol}`) && prefix !== eol) prefix += eol;
    return prefix + block;
}

/**
 * Make sure the root `.gitignore` ignores `.tyr/`, creating the file if
 * needed. Idempotent: an already-covered file is left byte-for-byte alone.
 */
export async function ensureTyrIgnored(root: string): Promise<"added" | "present"> {
    const contents = await readRootGitignore(root);
    if (isTyrIgnored(contents)) return "present";
    await writeFileAtomic(rootGitignorePath(root), appendTyrEntry(contents));
    return "added";
}

export interface GitignorePolicy {
    /** `true` for `--gitignore`, `false` for `--no-gitignore`, undefined otherwise. */
    flag: boolean | undefined;
    /** Whether the project root is inside a git work tree. */
    isRepo: boolean;
    /** Whether someone can answer a prompt (see `canPrompt`). */
    interactive: boolean;
    /** Asks the user; only called when the entry is missing and prompting is allowed. */
    ask: () => Promise<boolean>;
}

export interface GitignoreDecision {
    outcome: GitignoreOutcome;
    /**
     * Set when nothing was done only because nobody could be asked, so the
     * caller can point at `--gitignore`.
     */
    suggestFlag: boolean;
}

/**
 * Applies the `init` policy: `--no-gitignore` never touches or reads the
 * file, `--gitignore` adds the entry unconditionally, and with neither flag
 * the user is asked, but only inside a git repo and only when they can answer.
 */
export async function applyGitignorePolicy(root: string, policy: GitignorePolicy): Promise<GitignoreDecision> {
    if (policy.flag === false) return { outcome: "skipped", suggestFlag: false };
    if (policy.flag === true) return { outcome: await ensureTyrIgnored(root), suggestFlag: false };

    if (isTyrIgnored(await readRootGitignore(root))) return { outcome: "present", suggestFlag: false };
    // Outside git there is nothing for a .gitignore to do, so stay quiet.
    if (!policy.isRepo) return { outcome: "skipped", suggestFlag: false };
    if (!policy.interactive) return { outcome: "skipped", suggestFlag: true };

    if (!(await policy.ask())) return { outcome: "declined", suggestFlag: false };
    return { outcome: await ensureTyrIgnored(root), suggestFlag: false };
}
