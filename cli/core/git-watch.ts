// Live git events for long-running Tyr processes (`tyr watch`).
//
// Watches the repository's git directory with `fs.watch` rather than
// installing hooks, so the user's repo is never modified. File-system events
// are only *hints*: bursts are debounced, then the real state is re-read
// through git and an event is emitted only when that state actually changed.
// That makes the output immune to the noise git produces while working
// (lockfiles, `git status` refreshing the index's stat cache, reflog writes).
//
// Like git.ts, everything here is total: nothing throws and nothing prints.
// A path that is not a repository resolves to `null`, and a watcher that dies
// (directory removed, platform limits) degrades to polling instead of
// surfacing an error.

import * as fs from "node:fs";
import * as path from "node:path";
import { runGit, type RunGitOptions } from "./git-exec.js";
import { getCurrentBranch } from "./git.js";

/* -------------------------------------------------------------------------
 * Public types
 * ---------------------------------------------------------------------- */

export type GitWatchKind = "head" | "index" | "refs" | "merge-state";

export interface GitHeadState {
    /** Full commit hash HEAD points at; null on an unborn branch. */
    commit: string | null;
    /** Branch name, or a tag/short-hash label when detached (see getCurrentBranch). */
    branch: string | null;
    detached: boolean;
}

export interface GitRefChange {
    /** Full ref name, e.g. "refs/heads/main" or "refs/tags/v1.0". */
    ref: string;
    /** Object the ref pointed at before; null when the ref was created. */
    previous: string | null;
    /** Object the ref points at now; null when the ref was deleted. */
    current: string | null;
}

export interface GitOperationState {
    merging: boolean;
    /** Interactive/merge rebase, or `git am`/apply-style rebase. */
    rebasing: boolean;
    cherryPicking: boolean;
    reverting: boolean;
    bisecting: boolean;
}

export type GitWatchEvent =
    | {
        kind: "head";
        previous: GitHeadState;
        current: GitHeadState;
        /** HEAD moved to a different commit (commit, reset, pull, checkout). */
        commitChanged: boolean;
        /** HEAD now names a different branch (checkout/switch, detach). */
        branchChanged: boolean;
    }
    | {
        kind: "index";
        /** Paths that differ between the index and HEAD after the change. */
        staged: string[];
    }
    | { kind: "refs"; changes: GitRefChange[] }
    | { kind: "merge-state"; previous: GitOperationState; current: GitOperationState };

export interface WatchGitOptions {
    /** Called once per debounced, verified change. Exceptions are swallowed. */
    onEvent: (event: GitWatchEvent) => void;
    /** Quiet period that ends a burst of file-system events. Default 150ms. */
    debounceMs?: number;
    /**
     * Upper bound on how long a continuous burst (e.g. a long rebase) can
     * postpone a check. Default 1000ms.
     */
    maxWaitMs?: number;
    /** Interval for the polling fallback. Default 2000ms. */
    pollIntervalMs?: number;
    /** Skip `fs.watch` entirely and poll. Mostly for tests and odd filesystems. */
    forcePolling?: boolean;
    /**
     * Whether the watcher keeps the Node process alive. Default true, which
     * suits a `tyr watch` daemon whose whole job is to wait for events; pass
     * false when watching is incidental to some other work.
     */
    persistent?: boolean;
}

export interface GitWatcher {
    /** Absolute per-worktree git dir (holds HEAD and index). */
    gitDir: string;
    /** Absolute common git dir (holds refs/ and packed-refs). */
    commonDir: string;
    /** "watch" while fs.watch is live; "poll" once (or if) it fell back. */
    readonly mode: "watch" | "poll";
    /** Stop watching. Idempotent; no events are delivered afterwards. */
    close(): void;
}

/* -------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------- */

const DEFAULT_DEBOUNCE_MS = 150;
const DEFAULT_MAX_WAIT_MS = 1000;
const DEFAULT_POLL_INTERVAL_MS = 2000;

const ALL_KINDS: readonly GitWatchKind[] = ["head", "index", "refs", "merge-state"];

// Reads must never write. Without this, `git diff --cached` may refresh and
// rewrite the index, which would fire our own watcher in a loop.
const READ_ONLY: RunGitOptions = { env: { GIT_OPTIONAL_LOCKS: "0" } };

// Marker files/dirs in the per-worktree git dir that signal an in-progress
// operation, mapped to the GitOperationState flag they set.
const OPERATION_MARKERS: Record<string, keyof GitOperationState> = {
    MERGE_HEAD: "merging",
    "rebase-merge": "rebasing",
    "rebase-apply": "rebasing",
    CHERRY_PICK_HEAD: "cherryPicking",
    REVERT_HEAD: "reverting",
    BISECT_LOG: "bisecting",
};

/* -------------------------------------------------------------------------
 * Entry point
 * ---------------------------------------------------------------------- */

interface Snapshot {
    head: GitHeadState;
    index: { fingerprint: string; staged: string[] };
    refs: Map<string, string>;
    "merge-state": GitOperationState;
}

/**
 * Start watching the repository containing `root`. Resolves once the baseline
 * state has been read, so every later change is reported relative to it.
 * Resolves to null when `root` is not inside a git repository.
 */
export async function watchGit(root: string, options: WatchGitOptions): Promise<GitWatcher | null> {
    const dirs = await resolveGitDirs(root);
    if (dirs === null) {
        return null;
    }

    const debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    const maxWaitMs = Math.max(debounceMs, options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
    const pollIntervalMs = Math.max(50, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    const persistent = options.persistent ?? true;

    const watchers: fs.FSWatcher[] = [];
    const dirty = new Set<GitWatchKind>();
    let snapshot: Snapshot | null = null;
    let closed = false;
    let flushing = false;
    let mode: "watch" | "poll" = "watch";
    let debounceTimer: NodeJS.Timeout | null = null;
    let pollTimer: NodeJS.Timeout | null = null;
    let burstStartedAt: number | null = null;

    const emit = (event: GitWatchEvent): void => {
        if (closed) {
            return;
        }
        try {
            options.onEvent(event);
        } catch {
            // A buggy consumer must not take the watcher (or the process) down.
        }
    };

    const flush = async (): Promise<void> => {
        if (closed || flushing || snapshot === null) {
            return;
        }
        flushing = true;
        try {
            // Events that land while we are reading re-dirty a kind; loop
            // until a full pass finds nothing new.
            while (dirty.size > 0 && !closed) {
                const kinds = new Set(dirty);
                dirty.clear();
                await checkKinds(root, dirs.gitDir, kinds, snapshot, emit);
            }
        } catch {
            // checkKinds is total, but stay defensive: a flush never rejects.
        } finally {
            flushing = false;
        }
    };

    const schedule = (kinds: Iterable<GitWatchKind>): void => {
        if (closed) {
            return;
        }
        for (const kind of kinds) {
            dirty.add(kind);
        }
        // Trailing debounce, capped so a never-ending burst still gets checked.
        const now = Date.now();
        burstStartedAt ??= now;
        const delay = Math.min(debounceMs, Math.max(0, maxWaitMs - (now - burstStartedAt)));
        if (debounceTimer !== null) {
            clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(() => {
            debounceTimer = null;
            burstStartedAt = null;
            void flush();
        }, delay);
        if (!persistent) {
            debounceTimer.unref();
        }
    };

    const startPolling = (): void => {
        if (closed || pollTimer !== null) {
            return;
        }
        mode = "poll";
        for (const watcher of watchers.splice(0)) {
            closeQuietly(watcher);
        }
        pollTimer = setInterval(() => {
            for (const kind of ALL_KINDS) {
                dirty.add(kind);
            }
            void flush();
        }, pollIntervalMs);
        if (!persistent) {
            pollTimer.unref();
        }
    };

    // Watchers go up before the baseline read so that nothing slips through
    // the gap; anything they catch meanwhile waits for the baseline.
    if (options.forcePolling === true || !startWatchers(dirs, persistent, watchers, schedule, startPolling)) {
        startPolling();
    }

    snapshot = await readSnapshot(root, dirs.gitDir);
    if (dirty.size > 0 && debounceTimer === null) {
        schedule([]);
    }

    return {
        gitDir: dirs.gitDir,
        commonDir: dirs.commonDir,
        get mode() {
            return mode;
        },
        close(): void {
            if (closed) {
                return;
            }
            closed = true;
            if (debounceTimer !== null) {
                clearTimeout(debounceTimer);
                debounceTimer = null;
            }
            if (pollTimer !== null) {
                clearInterval(pollTimer);
                pollTimer = null;
            }
            for (const watcher of watchers.splice(0)) {
                closeQuietly(watcher);
            }
        },
    };
}

/* -------------------------------------------------------------------------
 * Locating the git directories
 * ---------------------------------------------------------------------- */

async function resolveGitDirs(root: string): Promise<{ gitDir: string; commonDir: string } | null> {
    // In a linked worktree or submodule `.git` is a *file*, HEAD and index
    // live in the per-worktree dir, and refs live in the shared common dir.
    // `--path-format=absolute` needs git >= 2.31; older gits print the common
    // dir relative to the working directory, which we resolve ourselves.
    let result = await runGit(root, ["rev-parse", "--path-format=absolute", "--absolute-git-dir", "--git-common-dir"]);
    if (!result.ok) {
        result = await runGit(root, ["rev-parse", "--absolute-git-dir", "--git-common-dir"]);
    }
    if (!result.ok) {
        return null;
    }

    const lines = result.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    if (lines.length < 2) {
        return null;
    }
    return { gitDir: lines[0], commonDir: path.resolve(root, lines[1]) };
}

/* -------------------------------------------------------------------------
 * File-system watchers
 * ---------------------------------------------------------------------- */

/**
 * Map a file name inside the per-worktree git dir to the kinds it may affect.
 * `.lock` names are treated like their target: git writes `index.lock` and
 * renames it over `index`, and some platforms only report one of the two
 * names. Over-reporting is harmless because every kind is re-verified.
 */
function kindsForGitDirEntry(name: string, includePackedRefs: boolean): GitWatchKind[] {
    const base = name.endsWith(".lock") ? name.slice(0, -".lock".length) : name;
    if (base === "HEAD") {
        return ["head"];
    }
    if (base === "index") {
        return ["index"];
    }
    if (base in OPERATION_MARKERS) {
        return ["merge-state"];
    }
    if (includePackedRefs && base === "packed-refs") {
        return ["refs", "head"];
    }
    // ORIG_HEAD, FETCH_HEAD, COMMIT_EDITMSG, config, logs/, objects/ … are noise.
    return [];
}

function startWatchers(
    dirs: { gitDir: string; commonDir: string },
    persistent: boolean,
    watchers: fs.FSWatcher[],
    schedule: (kinds: Iterable<GitWatchKind>) => void,
    fallBack: () => void,
): boolean {
    const shared = dirs.gitDir === dirs.commonDir;

    // Any watcher error (the directory vanished, too many watches) degrades
    // the whole thing to polling rather than leaving a silent blind spot.
    const add = (target: string, recursive: boolean, onName: (name: string | null) => void): boolean => {
        try {
            const watcher = fs.watch(target, { persistent, recursive }, (_event, filename) => {
                onName(filename === null ? null : filename.toString());
            });
            watcher.on("error", () => fallBack());
            watchers.push(watcher);
            return true;
        } catch {
            // Includes ERR_FEATURE_UNAVAILABLE_ON_PLATFORM for recursive watch
            // on platforms/Node versions without it (Linux before Node 20).
            return false;
        }
    };

    const ok =
        add(dirs.gitDir, false, (name) => {
            // A null name means the platform could not tell us; check everything.
            schedule(name === null ? ALL_KINDS : kindsForGitDirEntry(name, shared));
        }) &&
        (shared ||
            add(dirs.commonDir, false, (name) => {
                const base = name?.replace(/\.lock$/, "") ?? null;
                if (base === null || base === "packed-refs") {
                    schedule(["refs", "head"]);
                }
            })) &&
        // Anything under refs/ can move the current branch, so it also
        // re-checks HEAD. objects/ and logs/ are never watched at all.
        add(path.join(dirs.commonDir, "refs"), true, () => schedule(["refs", "head"]));

    if (!ok) {
        for (const watcher of watchers.splice(0)) {
            closeQuietly(watcher);
        }
    }
    return ok;
}

function closeQuietly(watcher: fs.FSWatcher): void {
    try {
        watcher.close();
    } catch {
        // Already closed or the handle is gone; nothing left to release.
    }
}

/* -------------------------------------------------------------------------
 * State reads and comparison
 * ---------------------------------------------------------------------- */

async function readSnapshot(root: string, gitDir: string): Promise<Snapshot> {
    const [head, index, refs, operations] = await Promise.all([
        readHead(root),
        readIndex(root),
        readRefs(root),
        readOperations(gitDir),
    ]);
    // A failed baseline read (e.g. a timeout) falls back to "empty" so the
    // watcher still starts; the next successful read reports the difference.
    return {
        head: head ?? { commit: null, branch: null, detached: false },
        index: index ?? { fingerprint: "", staged: [] },
        refs: refs ?? new Map(),
        "merge-state": operations,
    };
}

async function checkKinds(
    root: string,
    gitDir: string,
    kinds: Set<GitWatchKind>,
    snapshot: Snapshot,
    emit: (event: GitWatchEvent) => void,
): Promise<void> {
    // Reads run together; emission order is fixed (head, index, refs,
    // merge-state) so consumers see a commit as "head moved" first.
    const [head, index, refs, operations] = await Promise.all([
        kinds.has("head") ? readHead(root) : null,
        kinds.has("index") ? readIndex(root) : null,
        kinds.has("refs") ? readRefs(root) : null,
        kinds.has("merge-state") ? readOperations(gitDir) : null,
    ]);

    // A null read means git failed (timeout, transient lock); keep the old
    // state rather than reporting a phantom change.
    if (head !== null) {
        const previous = snapshot.head;
        const commitChanged = previous.commit !== head.commit;
        const branchChanged = previous.branch !== head.branch || previous.detached !== head.detached;
        if (commitChanged || branchChanged) {
            snapshot.head = head;
            emit({ kind: "head", previous, current: head, commitChanged, branchChanged });
        }
    }

    if (index !== null && index.fingerprint !== snapshot.index.fingerprint) {
        snapshot.index = index;
        emit({ kind: "index", staged: [...index.staged] });
    }

    if (refs !== null) {
        const changes = diffRefs(snapshot.refs, refs);
        if (changes.length > 0) {
            snapshot.refs = refs;
            emit({ kind: "refs", changes });
        }
    }

    if (operations !== null) {
        const previous = snapshot["merge-state"];
        const changed = (Object.keys(operations) as (keyof GitOperationState)[]).some(
            (key) => previous[key] !== operations[key],
        );
        if (changed) {
            snapshot["merge-state"] = operations;
            emit({ kind: "merge-state", previous, current: operations });
        }
    }
}

async function readHead(root: string): Promise<GitHeadState | null> {
    const [commit, branchInfo] = await Promise.all([
        runGit(root, ["rev-parse", "-q", "--verify", "HEAD^{commit}"], READ_ONLY),
        getCurrentBranch(root),
    ]);
    if (commit.timedOut) {
        return null;
    }
    // `--verify -q` fails silently on an unborn branch; that is "no commit".
    const hash = commit.ok ? commit.stdout.trim() : "";
    return {
        commit: hash.length > 0 ? hash : null,
        branch: branchInfo.branch,
        detached: branchInfo.detached,
    };
}

async function readIndex(root: string): Promise<{ fingerprint: string; staged: string[] } | null> {
    // The index's *content* is HEAD's tree plus the staged delta, so the raw
    // staged diff (blob hashes included) fingerprints it exactly while
    // ignoring the stat-cache rewrites that make the file churn. On an unborn
    // branch `--cached` compares against the empty tree.
    const result = await runGit(root, ["diff", "--cached", "--raw", "--no-renames", "-z"], READ_ONLY);
    if (!result.ok) {
        return null;
    }

    // -z raw records are ":<modes> <hashes> <status>\0<path>\0".
    const staged = new Set<string>();
    const fields = result.stdout.split("\0");
    for (let i = 0; i + 1 < fields.length; i += 2) {
        if (fields[i].startsWith(":") && fields[i + 1].length > 0) {
            staged.add(fields[i + 1]);
        }
    }
    return { fingerprint: result.stdout, staged: [...staged] };
}

async function readRefs(root: string): Promise<Map<string, string> | null> {
    const result = await runGit(root, ["for-each-ref", "--format=%(objectname) %(refname)"], READ_ONLY);
    if (!result.ok) {
        return null;
    }

    const refs = new Map<string, string>();
    for (const line of result.stdout.split("\n")) {
        const space = line.indexOf(" ");
        if (space > 0) {
            refs.set(line.slice(space + 1), line.slice(0, space));
        }
    }
    return refs;
}

function diffRefs(previous: Map<string, string>, current: Map<string, string>): GitRefChange[] {
    const changes: GitRefChange[] = [];
    for (const [ref, hash] of current) {
        const before = previous.get(ref) ?? null;
        if (before !== hash) {
            changes.push({ ref, previous: before, current: hash });
        }
    }
    for (const [ref, hash] of previous) {
        if (!current.has(ref)) {
            changes.push({ ref, previous: hash, current: null });
        }
    }
    return changes.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
}

async function readOperations(gitDir: string): Promise<GitOperationState> {
    const state: GitOperationState = {
        merging: false,
        rebasing: false,
        cherryPicking: false,
        reverting: false,
        bisecting: false,
    };
    await Promise.all(
        Object.entries(OPERATION_MARKERS).map(async ([marker, flag]) => {
            try {
                await fs.promises.access(path.join(gitDir, marker));
                state[flag] = true;
            } catch {
                // Absent marker: that operation is not in progress.
            }
        }),
    );
    return state;
}
