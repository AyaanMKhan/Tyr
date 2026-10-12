// Git history for incremental work: what changed since Tyr last indexed the
// repo, and which commits landed since a reference point (typically what a
// Claude Code session committed).
//
// Same contract as git.ts: everything goes through `runGit` (argv-only,
// time-limited), every export is *total*, and nothing here throws or prints.
// A missing repo, an unborn HEAD, or a recorded commit that a rebase / reset /
// force-push / shallow clone has made unreachable or deleted are all normal
// inputs that resolve to documented values. Paths are always read from
// NUL-delimited (`-z`) output, so spaces, quotes, newlines and non-ASCII names
// come through verbatim with no unquoting step.

import { COMMIT_FORMAT, FIELD_DELIM, runGit } from "./git-exec.js";
import type { GitCommit } from "./types.js";

// History walks and tree diffs scale with repo size and distance from the
// base, so they get more room than the default single-snapshot calls.
const HISTORY_TIMEOUT_MS = 15_000;

// Same strategy as git.ts: a status that blows its limit is retried once,
// longer and without the untracked-file walk.
const STATUS_TIMEOUT_MS = 5000;
const STATUS_RETRY_TIMEOUT_MS = 30_000;

// An unbounded `git log` on a large repo is never what a caller wants, so a
// log without an explicit limit is still capped.
export const DEFAULT_COMMIT_LIMIT = 100;

// Marks the start of each commit record in `git log -z` output. Records and
// file entries share the NUL separator, so this is what tells a commit header
// apart from a path. Built from control codes, like FIELD_DELIM.
const RECORD_MARKER = "\u001d\u001e";
const RECORD_FORMAT = `%x1d%x1e${COMMIT_FORMAT}`;

/* -------------------------------------------------------------------------
 * Types
 * ---------------------------------------------------------------------- */

/**
 * git's `--name-status` letter: Added, Copied, Deleted, Modified, Renamed,
 * Type change (e.g. file <-> symlink), Unmerged, unknown (X).
 */
export type FileChangeStatus = "A" | "C" | "D" | "M" | "R" | "T" | "U" | "X";

export interface ChangedFile {
    status: FileChangeStatus;
    /** The path after the change (the destination for renames and copies). */
    path: string;
    /** The source path for renames and copies; null otherwise. */
    oldPath: string | null;
    /** Rename/copy similarity percentage (0-100); null otherwise. */
    similarity: number | null;
}

export interface WorkingTreeChange {
    /** Path in the working tree (the destination for a staged rename). */
    path: string;
    /** Source path of a staged rename or copy; null otherwise. */
    oldPath: string | null;
    /** Porcelain v1 index (staged) code, e.g. "M", "A", "R", " ", "?". */
    index: string;
    /** Porcelain v1 worktree code, e.g. "M", "D", " ", "?". */
    worktree: string;
    untracked: boolean;
}

export interface CommitWithFiles extends GitCommit {
    /**
     * Files the commit changed relative to its first parent. Only present when
     * requested via `includeFiles`. Empty for a merge on a git too old to
     * support `--diff-merges=first-parent`.
     */
    files?: ChangedFile[];
}

export interface ChangeDetection {
    /** False for a plain directory or bare repo; every other field is then empty. */
    isRepo: boolean;
    /**
     * The base the caller passed (normally `state.lastIndexedCommit`), expanded
     * to the full hash when it still resolves to a commit.
     */
    baseCommit: string | null;
    /** True when `baseCommit` still names a commit object in this repo. */
    baseExists: boolean;
    /** Full hash of HEAD; null when HEAD is unborn (no commits yet). */
    headCommit: string | null;
    /** True when HEAD names a branch with no commits yet. */
    headUnborn: boolean;
    /** True when HEAD is not the base commit (including base/HEAD missing on one side). */
    headMoved: boolean;
    /**
     * True when the base is an ancestor of (or equal to) HEAD — history only
     * moved forward. False after a rebase, reset to an older commit,
     * force-push, branch switch, or when the base no longer exists.
     */
    baseReachable: boolean;
    /** Commits on HEAD that are not on the base (`base..HEAD`); null when not computable. */
    commitsSince: number | null;
    /**
     * Commits on the base that are no longer on HEAD (`HEAD..base`): non-zero
     * after a rewrite or reset. Null when not computable.
     */
    commitsDropped: number | null;
    /** Tree-level changes from the base commit to HEAD, renames detected. */
    changedFiles: ChangedFile[];
    /** True when there are staged, unstaged, untracked or conflicted changes; null when status failed. */
    workingTreeDirty: boolean | null;
    workingTreeChanges: WorkingTreeChange[];
    /** True when status only finished by skipping the untracked-file walk. */
    untrackedSkipped: boolean;
    /**
     * True when `changedFiles` cannot describe what changed since the base, so
     * the caller must re-index from scratch: never indexed, base commit gone,
     * HEAD unborn, or the diff itself failed / was cut off.
     */
    fullRescan: boolean;
}

export interface CommitLogOptions {
    /** Maximum commits to return (newest first). Defaults to DEFAULT_COMMIT_LIMIT. */
    limit?: number;
    /** Also list each commit's changed files (one extra pass in the same git call). */
    includeFiles?: boolean;
}

export interface CommitLog {
    commits: CommitWithFiles[];
    /** False when `ref` was given but does not resolve to a commit. */
    refResolved: boolean;
    /** True when more commits exist beyond `limit`. */
    hasMore: boolean;
}

/* -------------------------------------------------------------------------
 * Commit resolution
 * ---------------------------------------------------------------------- */

/**
 * Resolve a revision to a full commit hash, or null when it names nothing (an
 * unborn HEAD, a garbage-collected hash, a deleted branch). Anything that
 * looks like an option is refused rather than handed to git.
 */
export async function resolveCommit(root: string, ref: string): Promise<string | null> {
    const value = ref.trim();
    if (value.length === 0 || value.startsWith("-") || /[\s\0]/.test(value)) {
        return null;
    }

    // `^{commit}` makes a tag peel to its commit and a tree/blob hash fail.
    const result = await runGit(root, ["rev-parse", "-q", "--verify", `${value}^{commit}`]);
    const hash = result.stdout.trim();
    return result.ok && /^[0-9a-f]{40,64}$/.test(hash) ? hash : null;
}

async function isAncestor(root: string, ancestor: string, descendant: string): Promise<boolean> {
    // Exit 0 means yes, 1 means no; anything else (missing object, timeout) is
    // also "no", which is the safe answer for change detection.
    const result = await runGit(root, ["merge-base", "--is-ancestor", ancestor, descendant], {
        timeoutMs: HISTORY_TIMEOUT_MS,
    });
    return result.ok;
}

async function countCommits(root: string, range: string): Promise<number | null> {
    const result = await runGit(root, ["rev-list", "--count", range], { timeoutMs: HISTORY_TIMEOUT_MS });
    const count = Number(result.stdout.trim());
    return result.ok && Number.isInteger(count) ? count : null;
}

/* -------------------------------------------------------------------------
 * Change detection
 * ---------------------------------------------------------------------- */

/**
 * Compare HEAD and the working tree against the last indexed commit (usually
 * `state.lastIndexedCommit`). Pass null when the repo was never indexed.
 */
export async function detectChanges(root: string, baseCommit: string | null): Promise<ChangeDetection> {
    const base = baseCommit === null || baseCommit.trim().length === 0 ? null : baseCommit.trim();
    const empty: ChangeDetection = {
        isRepo: false,
        baseCommit: base,
        baseExists: false,
        headCommit: null,
        headUnborn: false,
        headMoved: false,
        baseReachable: false,
        commitsSince: null,
        commitsDropped: null,
        changedFiles: [],
        workingTreeDirty: null,
        workingTreeChanges: [],
        untrackedSkipped: false,
        fullRescan: true,
    };

    const inside = await runGit(root, ["rev-parse", "--is-inside-work-tree"]);
    if (!inside.ok || inside.stdout.trim() !== "true") {
        return empty;
    }

    // HEAD, the base and the working tree are independent lookups.
    const [headCommit, resolvedBase, status] = await Promise.all([
        resolveCommit(root, "HEAD"),
        base === null ? Promise.resolve(null) : resolveCommit(root, base),
        getWorkingTreeChanges(root),
    ]);

    const result: ChangeDetection = {
        ...empty,
        isRepo: true,
        baseCommit: resolvedBase ?? base,
        baseExists: resolvedBase !== null,
        headCommit,
        // Inside a work tree, a HEAD that does not resolve can only be unborn.
        headUnborn: headCommit === null,
        headMoved: (resolvedBase ?? base) !== headCommit,
        workingTreeDirty: status.changes === null ? null : status.changes.length > 0,
        workingTreeChanges: status.changes ?? [],
        untrackedSkipped: status.untrackedSkipped,
    };

    if (resolvedBase === null || headCommit === null) {
        // Never indexed, base gone (gc'd, shallow, other clone), or nothing
        // committed on this branch: there is no tree-to-tree diff to offer.
        return result;
    }

    if (resolvedBase === headCommit) {
        return {
            ...result,
            baseReachable: true,
            commitsSince: 0,
            commitsDropped: 0,
            fullRescan: false,
        };
    }

    const [reachable, since, dropped, diff] = await Promise.all([
        isAncestor(root, resolvedBase, headCommit),
        countCommits(root, `${resolvedBase}..${headCommit}`),
        countCommits(root, `${headCommit}..${resolvedBase}`),
        diffCommits(root, resolvedBase, headCommit),
    ]);

    // A tree diff is valid even when history was rewritten: it compares the
    // snapshot that was indexed with the snapshot now checked out.
    return {
        ...result,
        baseReachable: reachable,
        commitsSince: since,
        commitsDropped: dropped,
        changedFiles: diff ?? [],
        fullRescan: diff === null,
    };
}

/**
 * Files that differ between two commits, with rename detection. Null when
 * the diff failed or its output was cut off (callers must not trust a
 * partial list).
 */
export async function diffCommits(root: string, from: string, to: string): Promise<ChangedFile[] | null> {
    const fromHash = await resolveCommit(root, from);
    const toHash = await resolveCommit(root, to);
    if (fromHash === null || toHash === null) {
        return null;
    }

    // `-M` explicitly, so a user's `diff.renames=false` cannot change results.
    const result = await runGit(
        root,
        ["diff", "--name-status", "-z", "-M", "--no-ext-diff", "--no-color", fromHash, toHash],
        { timeoutMs: HISTORY_TIMEOUT_MS },
    );
    if (!result.ok) {
        return null;
    }

    const tokens = result.stdout.split("\0");
    const files: ChangedFile[] = [];
    let i = 0;
    while (i < tokens.length) {
        const parsed = readChangedFile(tokens, i);
        if (parsed === null) {
            i += 1;
            continue;
        }
        files.push(parsed.file);
        i = parsed.next;
    }
    return files;
}

/**
 * Read one `--name-status -z` entry starting at `tokens[i]`: a status token,
 * then one path (or source + destination for renames and copies). Returns
 * null when `tokens[i]` is not a status token.
 */
function readChangedFile(tokens: string[], i: number): { file: ChangedFile; next: number } | null {
    const match = /^([ACDMRTUX])(\d*)$/.exec(tokens[i]);
    if (match === null) {
        return null;
    }

    const status = match[1] as FileChangeStatus;
    const score = match[2].length > 0 ? Number(match[2]) : null;
    if (status === "R" || status === "C") {
        const oldPath = tokens[i + 1];
        const newPath = tokens[i + 2];
        if (oldPath === undefined || newPath === undefined) {
            return null;
        }
        return { file: { status, path: newPath, oldPath, similarity: score }, next: i + 3 };
    }

    const filePath = tokens[i + 1];
    if (filePath === undefined) {
        return null;
    }
    return { file: { status, path: filePath, oldPath: null, similarity: null }, next: i + 2 };
}

async function getWorkingTreeChanges(
    root: string,
): Promise<{ changes: WorkingTreeChange[] | null; untrackedSkipped: boolean }> {
    const base = ["status", "--porcelain=v1", "-z"];
    const full = await runGit(root, [...base, "--untracked-files=all"], { timeoutMs: STATUS_TIMEOUT_MS });
    if (full.ok) {
        return { changes: parseStatusZ(full.stdout), untrackedSkipped: false };
    }
    if (!full.timedOut) {
        return { changes: null, untrackedSkipped: false };
    }

    const fallback = await runGit(root, [...base, "--untracked-files=no"], { timeoutMs: STATUS_RETRY_TIMEOUT_MS });
    return fallback.ok
        ? { changes: parseStatusZ(fallback.stdout), untrackedSkipped: true }
        : { changes: null, untrackedSkipped: false };
}

function parseStatusZ(stdout: string): WorkingTreeChange[] {
    // With -z each entry is `XY path\0`; a rename or copy is followed by its
    // source path as an extra token (`XY new\0old\0`). Nothing is quoted.
    const tokens = stdout.split("\0");
    const changes: WorkingTreeChange[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const entry = tokens[i];
        if (entry.length < 4) {
            continue;
        }

        const index = entry[0];
        const worktree = entry[1];
        const filePath = entry.slice(3);
        if (index === "!") {
            continue; // Ignored files; only ever present with --ignored.
        }

        let oldPath: string | null = null;
        if (index === "R" || index === "C" || worktree === "R" || worktree === "C") {
            oldPath = tokens[i + 1] ?? null;
            i += 1;
        }
        changes.push({ path: filePath, oldPath, index, worktree, untracked: index === "?" });
    }
    return changes;
}

/* -------------------------------------------------------------------------
 * Commit log
 * ---------------------------------------------------------------------- */

/**
 * Commits reachable from HEAD but not from `ref`, newest first — e.g. what a
 * Claude Code session committed since it started. A null or empty `ref` means
 * "all of HEAD's history", still capped by `limit`. An unresolvable ref or an
 * unborn HEAD yields `[]`; use `getCommitLog` to tell those apart.
 */
export async function getCommitsSince(
    root: string,
    ref: string | null,
    options: CommitLogOptions = {},
): Promise<CommitWithFiles[]> {
    return (await getCommitLog(root, ref, options)).commits;
}

/** Like `getCommitsSince`, but also says whether `ref` resolved and whether the list was capped. */
export async function getCommitLog(
    root: string,
    ref: string | null,
    options: CommitLogOptions = {},
): Promise<CommitLog> {
    const limit = Math.max(0, Math.floor(options.limit ?? DEFAULT_COMMIT_LIMIT));
    const wanted = ref === null ? "" : ref.trim();

    const [head, from] = await Promise.all([
        resolveCommit(root, "HEAD"),
        wanted.length === 0 ? Promise.resolve(null) : resolveCommit(root, wanted),
    ]);
    const refResolved = wanted.length === 0 || from !== null;
    if (head === null || !refResolved || limit === 0) {
        return { commits: [], refResolved, hasMore: false };
    }

    // Ask for one extra commit so "exactly `limit`" and "more" are distinct.
    const range = from === null ? head : `${from}..${head}`;
    const baseArgs = [
        "log",
        `--max-count=${limit + 1}`,
        "-z",
        `--pretty=format:${RECORD_FORMAT}`,
        // A user's `log.showSignature=true` would splice gpg output into ours.
        "--no-show-signature",
        "--no-color",
    ];
    const fileArgs = ["--name-status", "-M", "--no-ext-diff"];

    let result = options.includeFiles === true
        ? await runGit(root, [...baseArgs, ...fileArgs, "--diff-merges=first-parent", range], {
            timeoutMs: HISTORY_TIMEOUT_MS,
        })
        : await runGit(root, [...baseArgs, range], { timeoutMs: HISTORY_TIMEOUT_MS });
    if (!result.ok && options.includeFiles === true && !result.timedOut) {
        // git < 2.31 has no --diff-merges; merges then just list no files.
        result = await runGit(root, [...baseArgs, ...fileArgs, range], { timeoutMs: HISTORY_TIMEOUT_MS });
    }
    if (!result.ok) {
        return { commits: [], refResolved, hasMore: false };
    }

    const commits = parseLog(result.stdout, options.includeFiles === true);
    return { commits: commits.slice(0, limit), refResolved, hasMore: commits.length > limit };
}

/**
 * Parse `git log -z` output. Every record begins with RECORD_MARKER; with
 * `--name-status` the header is followed by a newline and the first status
 * token, then `status\0path\0` entries (two paths for renames and copies).
 * File entries are consumed by count, so a path can never be mistaken for a
 * commit header no matter what bytes it contains.
 */
function parseLog(stdout: string, includeFiles: boolean): CommitWithFiles[] {
    const tokens = stdout.split("\0");
    const commits: CommitWithFiles[] = [];
    let current: CommitWithFiles | null = null;

    let i = 0;
    while (i < tokens.length) {
        const token = tokens[i];
        if (token.startsWith(RECORD_MARKER)) {
            const body = token.slice(RECORD_MARKER.length);
            const newline = body.indexOf("\n");
            const header = newline === -1 ? body : body.slice(0, newline);
            current = parseCommitHeader(header);
            if (current !== null) {
                if (includeFiles) {
                    current.files = [];
                }
                commits.push(current);
            }
            if (newline === -1) {
                i += 1;
                continue;
            }
            // The first status token rides on the header token after "\n".
            tokens[i] = body.slice(newline + 1);
            continue;
        }

        const parsed = readChangedFile(tokens, i);
        if (parsed === null) {
            i += 1; // The empty token between commits, or noise.
            continue;
        }
        current?.files?.push(parsed.file);
        i = parsed.next;
    }
    return commits;
}

function parseCommitHeader(header: string): CommitWithFiles | null {
    const parts = header.split(FIELD_DELIM);
    if (parts.length < 5) {
        return null;
    }

    // Read from both ends, as in git.ts, so a subject containing the delimiter
    // rejoins instead of shifting author/date out of position.
    const hash = parts[0].trim();
    const shortHash = parts[1].trim();
    const subject = parts.slice(2, parts.length - 2).join(FIELD_DELIM);
    const author = parts[parts.length - 2];
    const date = parts[parts.length - 1].trim();
    if (hash.length === 0) {
        return null;
    }
    return { hash, shortHash, subject, author, date };
}
