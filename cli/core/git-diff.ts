// Diffs for review: what changed, file by file, and the patch itself.
//
// Like git.ts, every export is *total*: not a repo, an unknown ref, or a repo
// with no commits resolve to the documented null/empty value. Nothing here
// throws and nothing prints. All git calls go through `runGit` (argv-only,
// time-limited, output-bounded).
//
// Paths in results are always relative to the repository top level, whatever
// subdirectory `root` points at. Untracked files never appear in `git diff`
// output; ask for them with `includeUntracked` and they come back as a
// separate list rather than as fake "added" entries.

import { GIT_MAX_BUFFER, GIT_TIMEOUT_MS, runGit } from "./git-exec.js";

// The empty tree, per object format. A staged diff on a repo with no commits
// is "everything in the index versus nothing".
const EMPTY_TREE: Record<string, string> = {
    sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
};

// Default cap on patch text. Large enough for a real review, small enough
// that a vendored-dependency commit cannot balloon memory.
export const DEFAULT_MAX_PATCH_BYTES = 4 * 1024 * 1024;

// Flags shared by every diff call, so user config can't change the output
// shape: no colour, no external diff driver or textconv filter, standard
// a/ b/ prefixes, and paths from the top level even with diff.relative set.
const CONFIG_OVERRIDES = ["-c", "diff.relative=false", "-c", "diff.noprefix=false", "-c", "core.quotePath=false"];
const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/"];

/* -------------------------------------------------------------------------
 * Types
 * ---------------------------------------------------------------------- */

/**
 * What to compare.
 * - `staged`: index vs HEAD (what `git commit` would record). On a repo with
 *   no commits, index vs the empty tree.
 * - `unstaged`: working tree vs index (tracked files only).
 * - `since`: changes since `ref`. With `until: "worktree"` (the default) that
 *   is `ref` vs the working tree — committed, staged and unstaged changes to
 *   tracked files together. With `until: "head"` it is `ref` vs HEAD, i.e.
 *   only what was committed (`ref..HEAD`).
 */
export type DiffScope =
    | { kind: "staged" }
    | { kind: "unstaged" }
    | { kind: "since"; ref: string; until?: "worktree" | "head" };

/** Git's single-letter change status (`--name-status`). */
export type DiffStatus = "A" | "C" | "D" | "M" | "R" | "T" | "U" | "X";

export interface DiffFileStat {
    /** Path after the change (for a deletion, the deleted path). */
    path: string;
    /** Source path of a rename or copy. */
    oldPath?: string;
    status: DiffStatus;
    /** Rename/copy similarity, 0-100, when git reports one. */
    similarity?: number;
    /** Lines added; 0 for binary files. */
    additions: number;
    /** Lines removed; 0 for binary files. */
    deletions: number;
    binary: boolean;
}

export interface DiffTotals {
    files: number;
    additions: number;
    deletions: number;
}

export interface DiffStat {
    files: DiffFileStat[];
    totals: DiffTotals;
    /**
     * Untracked, non-ignored files, only when `includeUntracked` was asked for
     * and the scope involves the working tree (`unstaged`, or `since` up to
     * the working tree); otherwise null.
     */
    untracked: string[] | null;
}

export interface DiffResult extends DiffStat {
    /** Unified diff text, cut at a line boundary when `truncated`. */
    patch: string;
    /** True when the patch exceeded `maxPatchBytes` and was cut short. */
    truncated: boolean;
}

export interface DiffOptions {
    /** Limit to these pathspecs (interpreted relative to `root`). */
    pathspec?: string[];
    /** Lines of context around each hunk (git's default is 3). */
    contextLines?: number;
    /** Cap on patch text; beyond it the patch is cut and `truncated` set. */
    maxPatchBytes?: number;
    /** Detect renames (default true). */
    findRenames?: boolean;
    /** Also list untracked files (see `DiffStat.untracked`). */
    includeUntracked?: boolean;
    /** Time limit per git call, in milliseconds. */
    timeoutMs?: number;
}

export type DiffStatOptions = Omit<DiffOptions, "contextLines" | "maxPatchBytes">;

/* -------------------------------------------------------------------------
 * Public API
 * ---------------------------------------------------------------------- */

/**
 * Per-file stats (status, rename source, added/removed lines, binary) plus
 * totals. Null when `root` is not in a work tree, a ref doesn't resolve, or
 * git fails.
 */
export async function getDiffStat(
    root: string,
    scope: DiffScope,
    options: DiffStatOptions = {},
): Promise<DiffStat | null> {
    const range = await resolveRange(root, scope, options.timeoutMs);
    if (range === null) {
        return null;
    }

    const [stat, untracked] = await Promise.all([
        runGit(
            root,
            [
                ...CONFIG_OVERRIDES,
                "diff",
                ...DIFF_FLAGS,
                ...renameFlags(options),
                "--raw",
                "--numstat",
                "-z",
                ...range,
                "--",
                ...(options.pathspec ?? []),
            ],
            { timeoutMs: options.timeoutMs ?? GIT_TIMEOUT_MS },
        ),
        listUntracked(root, scope, options),
    ]);
    if (!stat.ok || untracked === undefined) {
        return null;
    }

    const files = parseRawNumstat(stat.stdout);
    return { files, totals: totalsOf(files), untracked };
}

/**
 * The unified patch plus the same stats as `getDiffStat`. A patch larger than
 * `maxPatchBytes` is not an error: it comes back cut at the last whole line
 * with `truncated: true`, while `files`/`totals` still describe everything.
 */
export async function getDiff(
    root: string,
    scope: DiffScope,
    options: DiffOptions = {},
): Promise<DiffResult | null> {
    const range = await resolveRange(root, scope, options.timeoutMs);
    if (range === null) {
        return null;
    }

    const maxBytes = Math.max(1, Math.floor(options.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES));
    const context =
        options.contextLines === undefined ? [] : [`--unified=${Math.max(0, Math.floor(options.contextLines))}`];

    const [stat, patch] = await Promise.all([
        getDiffStat(root, scope, options),
        runGit(
            root,
            [
                ...CONFIG_OVERRIDES,
                "diff",
                ...DIFF_FLAGS,
                ...renameFlags(options),
                ...context,
                ...range,
                "--",
                ...(options.pathspec ?? []),
            ],
            // One byte over the cap is enough to know the patch didn't fit.
            { timeoutMs: options.timeoutMs ?? GIT_TIMEOUT_MS, maxBuffer: maxBytes + 1 },
        ),
    ]);
    if (stat === null) {
        return null;
    }
    if (!patch.ok && !patch.truncated) {
        return null;
    }

    const bytes = Buffer.from(patch.stdout, "utf8");
    const truncated = patch.truncated || bytes.length > maxBytes;
    return { ...stat, patch: truncated ? cutAtLine(bytes, maxBytes) : patch.stdout, truncated };
}

/* -------------------------------------------------------------------------
 * Scope resolution
 * ---------------------------------------------------------------------- */

/**
 * Turn a scope into the revision arguments for `git diff`. Refs are resolved
 * to full hashes first, so a ref that looks like an option ("--output=x")
 * never reaches the diff argv, and an unknown ref is caught here as null.
 */
async function resolveRange(root: string, scope: DiffScope, timeoutMs?: number): Promise<string[] | null> {
    const inside = await runGit(root, ["rev-parse", "--is-inside-work-tree"], { timeoutMs });
    if (!inside.ok || inside.stdout.trim() !== "true") {
        return null;
    }

    switch (scope.kind) {
        case "unstaged":
            return [];
        case "staged": {
            const head = await resolveCommit(root, "HEAD", timeoutMs);
            return ["--cached", head ?? (await emptyTree(root, timeoutMs))];
        }
        case "since": {
            const from = await resolveCommit(root, scope.ref, timeoutMs);
            if (from === null) {
                return null;
            }
            if (scope.until === "head") {
                const head = await resolveCommit(root, "HEAD", timeoutMs);
                return head === null ? null : [from, head];
            }
            return [from];
        }
        default:
            return null;
    }
}

async function resolveCommit(root: string, ref: string, timeoutMs?: number): Promise<string | null> {
    // A leading dash would be parsed as an option, never as a ref.
    if (typeof ref !== "string" || ref.length === 0 || ref.startsWith("-")) {
        return null;
    }
    const result = await runGit(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { timeoutMs });
    const hash = result.stdout.trim();
    return result.ok && /^[0-9a-f]{40,64}$/.test(hash) ? hash : null;
}

async function emptyTree(root: string, timeoutMs?: number): Promise<string> {
    // SHA-256 repositories have a different empty tree; older git without
    // `--show-object-format` is always SHA-1.
    const format = await runGit(root, ["rev-parse", "--show-object-format"], { timeoutMs });
    return EMPTY_TREE[format.stdout.trim()] ?? EMPTY_TREE.sha1;
}

function renameFlags(options: DiffStatOptions): string[] {
    return options.findRenames === false ? ["--no-renames"] : ["--find-renames"];
}

/**
 * Untracked files, for scopes that look at the working tree. `undefined`
 * means git failed (the caller turns that into null); `null` means "not
 * requested / not applicable".
 */
async function listUntracked(
    root: string,
    scope: DiffScope,
    options: DiffStatOptions,
): Promise<string[] | null | undefined> {
    const touchesWorktree = scope.kind === "unstaged" || (scope.kind === "since" && scope.until !== "head");
    if (options.includeUntracked !== true || !touchesWorktree) {
        return null;
    }

    // `--full-name` keeps paths top-level-relative like the diff output.
    const result = await runGit(
        root,
        ["ls-files", "--others", "--exclude-standard", "--full-name", "-z", "--", ...(options.pathspec ?? [])],
        { timeoutMs: options.timeoutMs ?? GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
    );
    if (!result.ok) {
        return undefined;
    }
    return result.stdout.split("\0").filter((entry) => entry.length > 0);
}

/* -------------------------------------------------------------------------
 * Parsing
 * ---------------------------------------------------------------------- */

/**
 * Parse `git diff --raw --numstat -z`. Git prints every raw record first,
 * then every numstat record, NUL-separated, with paths verbatim (no quoting):
 *
 *   raw:      `:<modes> <shas> <status>\0<path>\0` — renames and copies
 *             (`R<score>` / `C<score>`) carry `\0<src>\0<dst>\0`.
 *   numstat:  `<add>\t<del>\t<path>\0`, or for a rename/copy
 *             `<add>\t<del>\t\0<src>\0<dst>\0`; binary files print `-\t-`.
 */
function parseRawNumstat(stdout: string): DiffFileStat[] {
    const tokens = stdout.split("\0");
    const files: DiffFileStat[] = [];
    const byPath = new Map<string, DiffFileStat>();
    const counts = new Map<string, { additions: number; deletions: number; binary: boolean }>();

    let i = 0;
    while (i < tokens.length) {
        const token = tokens[i];
        if (token.length === 0) {
            i += 1;
            continue;
        }

        if (token.startsWith(":")) {
            const statusField = token.split(" ").pop() ?? "";
            const letter = statusField.charAt(0);
            const score = statusField.slice(1);
            const paired = letter === "R" || letter === "C";
            const first = tokens[i + 1] ?? "";
            const second = paired ? tokens[i + 2] ?? "" : undefined;
            i += paired ? 3 : 2;

            const status: DiffStatus = isDiffStatus(letter) ? letter : "X";
            const filePath = second ?? first;
            if (filePath.length === 0) {
                continue;
            }

            // An unmerged path can be reported twice (the "U" record plus a
            // stage diff); keep one entry, and keep the U.
            const existing = byPath.get(filePath);
            if (existing !== undefined) {
                if (status === "U") {
                    existing.status = "U";
                }
                continue;
            }

            const entry: DiffFileStat = { path: filePath, status, additions: 0, deletions: 0, binary: false };
            if (second !== undefined) {
                entry.oldPath = first;
            }
            if (/^\d+$/.test(score)) {
                entry.similarity = Number(score);
            }
            files.push(entry);
            byPath.set(filePath, entry);
            continue;
        }

        // numstat record.
        const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(token);
        if (match === null) {
            i += 1;
            continue;
        }
        let filePath = match[3];
        i += 1;
        if (filePath.length === 0) {
            // Rename/copy: source and destination follow as their own tokens.
            filePath = tokens[i + 1] ?? "";
            i += 2;
        }
        const binary = match[1] === "-" && match[2] === "-";
        counts.set(filePath, {
            additions: binary ? 0 : Number(match[1]),
            deletions: binary ? 0 : Number(match[2]),
            binary,
        });
    }

    for (const entry of files) {
        const count = counts.get(entry.path);
        if (count !== undefined) {
            entry.additions = count.additions;
            entry.deletions = count.deletions;
            entry.binary = count.binary;
        }
    }
    return files;
}

function isDiffStatus(letter: string): letter is DiffStatus {
    return "ACDMRTUX".includes(letter) && letter.length === 1;
}

function totalsOf(files: DiffFileStat[]): DiffTotals {
    let additions = 0;
    let deletions = 0;
    for (const file of files) {
        additions += file.additions;
        deletions += file.deletions;
    }
    return { files: files.length, additions, deletions };
}

/**
 * Cut `bytes` to at most `maxBytes`, backing up to the last newline so the
 * patch never ends mid-line (or mid-UTF-8 character). A single giant line
 * with no newline in range falls back to a hard cut.
 */
function cutAtLine(bytes: Buffer, maxBytes: number): string {
    const window = bytes.subarray(0, Math.min(bytes.length, maxBytes));
    const newline = window.lastIndexOf(0x0a);
    const end = newline === -1 ? window.length : newline + 1;
    // A hard cut can split a multi-byte character; the decoder turns that
    // tail into U+FFFD, which we drop.
    return window.subarray(0, end).toString("utf8").replace(/�+$/, "");
}
