// Live file-change batches for long-running Tyr processes (the daemon).
//
// Watches the project tree with one recursive `fs.watch` and reports what
// changed in debounced batches of root-relative POSIX paths:
//
//     { added: ["src/new.ts"], modified: ["src/a.ts"], removed: [], total: 2, truncated: false }
//
// Like git-watch.ts, file-system events are only *hints*. Their event types
// ("rename" vs "change") and even their granularity differ per platform —
// macOS coalesces, Linux reports a directory move as one entry, Windows
// sometimes reports only the parent — so nothing is classified from them.
// Instead each burst's paths are stat'ed at flush time and compared with a
// baseline of size + mtime fingerprints (the same ones scan-diff.ts uses),
// taken by a full scan at startup. That is what lets a batch say "added" vs
// "modified" correctly, and what drops the noise:
//   - a file created and deleted inside one burst never existed as far as
//     the baseline is concerned, so it is not reported at all;
//   - an event that leaves size and mtime unchanged (chmod, an atime update,
//     a duplicate notification after the file was already reported) is
//     dropped;
//   - a bare `touch` *is* reported as modified: telling it apart from a real
//     edit would mean hashing contents, i.e. reading every changed file and
//     keeping a hash of every file in the baseline. That is not cheap, and
//     erring towards "modified" matches scan-diff.ts.
//
// Ignore rules are discovery's, applied through the same helpers:
//   - built-in IGNORED_DIRS / IGNORED_FILES / IGNORED_EXTENSIONS and `.tyr`
//     (createPathIgnoreFilter in discovery.ts);
//   - `scan.extraIgnore` from tyr.json plus `.tyrignore`, re-read when either
//     changes: files they newly ignore leave the baseline silently, and a
//     rescan reports files they un-ignore as added;
//   - git's own ignore rules when the root is inside a work tree, matching
//     scanProject's default. New paths are checked with one
//     `git check-ignore --stdin` per batch; paths already in the baseline
//     passed `git ls-files` at scan time and are not re-checked.
// `.git/` is always ignored on top of that (git-watch.ts has its own watcher),
// and so is `.tyr/` — the daemon writes its log and journal there, and
// reporting those writes would feed back into itself.
//
// Nested repositories — any directory below the root holding a `.git` entry,
// e.g. the worktrees Claude Code creates under `.claude/worktrees/` — are
// skipped whole, by the same rule as the scanner (hasNestedRepoMarker in
// discovery.ts). The set of them comes from each full scan; between scans a
// notification for `<dir>/.git` itself (a `git init`, `git worktree add` or
// `rm -rf <dir>/.git`) is probed at flush time and, when it changes the set,
// resolved by a rescan. Files that enter a nested repository leave the
// baseline silently (they were not edited, they changed owner), and files of
// one that stops being a repository come back as added. A directory walk or
// a newly seen file also checks its ancestors for a `.git` entry, in case the
// platform reported the files but not the marker.
//
// Storm guards (`npm install` into a directory nothing ignores, a big
// checkout): a burst touching more than `maxPendingPaths` paths stops
// collecting individual paths and is resolved by one full rescan instead,
// and each list in a batch is capped at `maxBatchPaths` with `total`
// carrying the real count.
//
// Polling fallback: if recursive `fs.watch` is unavailable or its watcher
// errors (EMFILE, ENOSPC from inotify limits, the root vanishing), the
// watcher degrades to a full rescan every `pollIntervalMs` and diffs it
// against the baseline. Same batches, just coarser and costlier.
//
// Like git-watch.ts, everything here is total: nothing throws and nothing
// prints.

import * as fs from "node:fs";
import * as path from "node:path";
import {
    createPathIgnoreFilter,
    hasNestedRepoMarker,
    isInsideNestedRepo,
    NESTED_REPO_MARKER,
    scanProject,
    type PathIgnoreFilter,
} from "./discovery.js";
import { runGit } from "./git-exec.js";
import { describeError } from "./git-watch.js";
import { loadUserIgnorePatterns, TYR_IGNORE_FILE } from "./ignore.js";
import { buildScanManifest } from "./scan-diff.js";
import type { FileFingerprint } from "./types.js";

/* -------------------------------------------------------------------------
 * Public types
 * ---------------------------------------------------------------------- */

/** One debounced burst of verified file changes. Paths are root-relative, `/`-separated, sorted. */
export interface FileChangeBatch {
    added: string[];
    modified: string[];
    removed: string[];
    /** Real number of changed files, including any cut from the lists above. */
    total: number;
    /** True when at least one list was capped at `maxBatchPaths`. */
    truncated: boolean;
}

export interface WatchFilesOptions {
    /** Called once per non-empty batch. Exceptions are swallowed. */
    onBatch: (batch: FileChangeBatch) => void;
    /** Quiet period that ends a burst of file-system events. Default 300ms. */
    debounceMs?: number;
    /** Upper bound on how long a continuous burst can postpone a batch. Default 2000ms. */
    maxWaitMs?: number;
    /** Interval between full rescans in polling mode. Default 5000ms. */
    pollIntervalMs?: number;
    /** Skip `fs.watch` entirely and poll. Mostly for tests and odd filesystems. */
    forcePolling?: boolean;
    /**
     * Whether the watcher keeps the Node process alive. Default true, which
     * suits the daemon; pass false when watching is incidental.
     */
    persistent?: boolean;
    /**
     * User ignore patterns (gitignore subset, see ignore.ts). Default: read
     * from tyr.json's `scan.extraIgnore` and `.tyrignore`, and re-read when
     * either changes. Passing a list pins it.
     */
    extraIgnore?: readonly string[];
    /** Apply git's ignore rules inside a work tree, like scanProject. Default true. */
    respectGitignore?: boolean;
    /** Cap on each of added/modified/removed in one batch. Default 1000. */
    maxBatchPaths?: number;
    /**
     * Paths one burst may collect before it is resolved by a full rescan
     * instead of path by path. Default 10000.
     */
    maxPendingPaths?: number;
    /**
     * Called once if the watcher falls back from fs.watch to polling, at
     * startup (recursive watch unavailable) or later (a watcher error), with
     * a short reason. Not called for `forcePolling`. Exceptions are swallowed.
     */
    onFallback?: (reason: string) => void;
    /**
     * Epoch ms from which changes count as observed. Files the baseline scan
     * finds with an mtime at or after it are reported in a first batch
     * instead of being silently absorbed into the baseline (see the startup
     * note in watchFiles). The daemon passes the time it started, so a file
     * written right after `tyr start` returns is reported however long the
     * scan takes. Default: none, the baseline is taken as found — callers
     * that create files and start watching in the same breath (tests) would
     * otherwise see their own setup reported.
     */
    since?: number;
}

export interface FileWatcher {
    /** "watch" while fs.watch is live; "poll" once (or if) it fell back. */
    readonly mode: "watch" | "poll";
    /** Stop watching. Idempotent; no batches are delivered afterwards. */
    close(): void;
}

/* -------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------- */

const DEFAULT_DEBOUNCE_MS = 300;
const DEFAULT_MAX_WAIT_MS = 2000;
// Each poll is a full scan plus a stat per file, so it is slower than
// git-watch's (which only asks git a few questions).
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_MAX_BATCH_PATHS = 1000;
const DEFAULT_MAX_PENDING_PATHS = 10000;

/** Never reported, whatever the user's patterns say. */
const ALWAYS_IGNORED_SEGMENTS: ReadonlySet<string> = new Set([".git", ".tyr"]);

/** tyr.json as seen from the root; its `scan.extraIgnore` feeds the rules. */
const TYR_CONFIG_PATH = ".tyr/tyr.json";

/** How far past "now" a baseline mtime may lie and still count as a startup change. */
const FUTURE_MTIME_SLACK_MS = 2000;
/** How far an mtime may lag Date.now() for the same instant (see the startup note). */
const COARSE_CLOCK_SLACK_MS = 20;

/** Paths per `git check-ignore` call, so one stuck batch cannot hit the output cap. */
const CHECK_IGNORE_CHUNK = 2000;

interface Changes {
    added: string[];
    modified: string[];
    removed: string[];
}

/* -------------------------------------------------------------------------
 * Entry point
 * ---------------------------------------------------------------------- */

/**
 * Start watching the project at `root`. Resolves once the baseline scan has
 * finished, so every later batch is relative to it. Never rejects: a baseline
 * that cannot be read starts empty, and a watcher that cannot start polls.
 */
export async function watchFiles(root: string, options: WatchFilesOptions): Promise<FileWatcher> {
    const since = options.since;
    const absRoot = path.resolve(root);
    const debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    const maxWaitMs = Math.max(debounceMs, options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
    const pollIntervalMs = Math.max(50, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    const persistent = options.persistent ?? true;
    const respectGitignore = options.respectGitignore ?? true;
    const maxBatchPaths = Math.max(1, options.maxBatchPaths ?? DEFAULT_MAX_BATCH_PATHS);
    const maxPendingPaths = Math.max(1, options.maxPendingPaths ?? DEFAULT_MAX_PENDING_PATHS);
    const pinnedPatterns = options.extraIgnore !== undefined;

    let patterns: readonly string[] = options.extraIgnore ?? [];
    let filter: PathIgnoreFilter = createPathIgnoreFilter(patterns);
    let gitAware = false;
    /** Baseline: every reportable file and its fingerprint. Null until the first scan. */
    let known: Map<string, FileFingerprint> | null = null;
    /** Root-relative nested repositories, skipped whole (see the header). */
    let nestedRepos = new Set<string>();
    /** Directories whose `.git` entry was touched; checked at the next flush. */
    const nestedProbes = new Set<string>();

    let watcher: fs.FSWatcher | null = null;
    const dirty = new Set<string>();
    let needsRescan = false;
    let reloadPatterns = false;
    let closed = false;
    let flushing = false;
    let mode: "watch" | "poll" = "watch";
    let debounceTimer: NodeJS.Timeout | null = null;
    let pollTimer: NodeJS.Timeout | null = null;
    let burstStartedAt: number | null = null;

    const emit = (changes: Changes): void => {
        if (closed) {
            return;
        }
        const total = changes.added.length + changes.modified.length + changes.removed.length;
        if (total === 0) {
            return;
        }
        const cap = (list: string[]): string[] => list.sort(compareStrings).slice(0, maxBatchPaths);
        const truncated = Math.max(changes.added.length, changes.modified.length, changes.removed.length) > maxBatchPaths;
        try {
            options.onBatch({
                added: cap(changes.added),
                modified: cap(changes.modified),
                removed: cap(changes.removed),
                total,
                truncated,
            });
        } catch {
            // A buggy consumer must not take the watcher (or the process) down.
        }
    };

    const dropNestedFromBaseline = (): void => {
        if (known === null || nestedRepos.size === 0) {
            return;
        }
        for (const rel of [...known.keys()]) {
            if (isInsideNestedRepo(rel, nestedRepos)) {
                known.delete(rel);
            }
        }
    };

    /** Full scan diffed against the baseline, which it then replaces. */
    const rescan = async (): Promise<Changes> => {
        const changes: Changes = { added: [], modified: [], removed: [] };
        try {
            const scan = await scanProject(absRoot, { extraIgnore: patterns, respectGitignore });
            const manifest = await buildScanManifest(absRoot, scan.files);
            nestedRepos = new Set(scan.nestedRepos);
            // Files now inside a nested repository changed owner, not
            // content: dropped silently rather than reported as removed.
            dropNestedFromBaseline();
            const next = new Map<string, FileFingerprint>();
            for (const [rel, fingerprint] of Object.entries(manifest.files)) {
                if (isAlwaysIgnored(rel)) {
                    continue; // `.git` as a *file* (linked worktree) is not caught by the dir rules.
                }
                next.set(rel, fingerprint);
                const before = known?.get(rel);
                if (before === undefined) {
                    changes.added.push(rel);
                } else if (!sameFingerprint(before, fingerprint)) {
                    changes.modified.push(rel);
                }
            }
            for (const rel of known?.keys() ?? []) {
                if (!next.has(rel)) {
                    changes.removed.push(rel);
                }
            }
            known = next;
        } catch {
            // scanProject and buildScanManifest are best-effort already; keep
            // the old baseline rather than report phantom removals.
        }
        return changes;
    };

    /** Resolve one burst's paths against the baseline, updating it in place. */
    const classify = async (paths: string[], baseline: Map<string, FileFingerprint>): Promise<Changes | "rescan"> => {
        const changes: Changes = { added: [], modified: [], removed: [] };
        const candidates = new Set<string>();
        // Directories that were created, moved in, moved out or deleted. Some
        // platforms report only the directory, so the files below it are
        // resolved from the disk (what is there now) and the baseline (what
        // was there before).
        const dirs = new Set<string>();

        const nestedBefore = nestedRepos.size;
        for (const rel of paths) {
            if (isInsideNestedRepo(rel, nestedRepos)) {
                continue; // Became nested since the event was queued.
            }
            candidates.add(rel);
            const stats = await lstatOrNull(path.join(absRoot, rel));
            if (stats?.isDirectory()) {
                if (filter.ignores(rel, true)) {
                    continue;
                }
                dirs.add(rel);
                if (!(await walkDirectory(absRoot, rel, filter, nestedRepos, candidates, maxPendingPaths))) {
                    return "rescan";
                }
            } else if (stats === null && !baseline.has(rel)) {
                dirs.add(rel); // Gone, and not a file we knew: maybe a directory.
            }
        }

        if (dirs.size > 0) {
            // One pass over the baseline, checking each file's ancestors,
            // rather than one prefix scan of the baseline per directory.
            for (const rel of baseline.keys()) {
                for (let slash = rel.indexOf("/"); slash > 0; slash = rel.indexOf("/", slash + 1)) {
                    if (dirs.has(rel.slice(0, slash))) {
                        candidates.add(rel);
                        break;
                    }
                }
            }
        }

        if (candidates.size > maxPendingPaths) {
            return "rescan";
        }

        // Skips non-regular files (symlinks included, as the scanner does)
        // and anything that vanished before its stat.
        const fresh = (await buildScanManifest(absRoot, [...candidates])).files;

        // Files the baseline already knows passed every ignore rule when they
        // were scanned; only newcomers need checking.
        let newcomers = Object.keys(fresh).filter(
            (rel) => !baseline.has(rel) && !isAlwaysIgnored(rel) && !filter.ignores(rel, false),
        );
        // A newcomer may sit in a repository whose `.git` the platform never
        // reported (macOS coalescing, a clone moved in whole). One check per
        // distinct ancestor directory, so a big burst stays cheap.
        if (newcomers.length > 0 && (await findNestedAncestors(absRoot, newcomers, nestedRepos))) {
            newcomers = newcomers.filter((rel) => !isInsideNestedRepo(rel, nestedRepos));
        }
        if (nestedRepos.size !== nestedBefore) {
            // New nested repositories: their files leave quietly (see rescan).
            for (const rel of [...candidates]) {
                if (isInsideNestedRepo(rel, nestedRepos)) {
                    candidates.delete(rel);
                    baseline.delete(rel);
                }
            }
            dropNestedFromBaseline();
        }
        const gitIgnored = gitAware && newcomers.length > 0 ? await checkGitIgnored(absRoot, newcomers) : new Set<string>();
        const admitted = new Set(newcomers.filter((rel) => !gitIgnored.has(rel)));

        for (const rel of candidates) {
            const before = baseline.get(rel);
            const after = Object.hasOwn(fresh, rel) && (before !== undefined || admitted.has(rel)) ? fresh[rel] : undefined;
            if (after !== undefined) {
                if (before === undefined) {
                    changes.added.push(rel);
                } else if (!sameFingerprint(before, after)) {
                    changes.modified.push(rel);
                }
                baseline.set(rel, after);
            } else if (before !== undefined) {
                changes.removed.push(rel);
                baseline.delete(rel);
            }
        }
        return changes;
    };

    const flush = async (): Promise<void> => {
        if (closed || flushing || known === null) {
            return;
        }
        flushing = true;
        try {
            // Events that land while we are working re-dirty paths; loop until
            // a full pass finds nothing new. Each pass is its own batch.
            while ((needsRescan || dirty.size > 0 || reloadPatterns || nestedProbes.size > 0) && !closed) {
                if (reloadPatterns) {
                    reloadPatterns = false;
                    await refreshPatterns();
                    needsRescan = true;
                }
                if (nestedProbes.size > 0 && !needsRescan) {
                    const probes = [...nestedProbes];
                    nestedProbes.clear();
                    for (const dir of probes) {
                        // Only a change to the set needs the (costly) rescan;
                        // churn inside an existing nested repo does not.
                        const isRepo = await hasGitEntry(path.join(absRoot, dir));
                        if (isRepo !== nestedRepos.has(dir)) {
                            needsRescan = true;
                            break;
                        }
                    }
                }
                nestedProbes.clear();
                let changes: Changes | "rescan" = "rescan";
                const baseline = known;
                if (!needsRescan && baseline !== null) {
                    const paths = [...dirty];
                    dirty.clear();
                    changes = await classify(paths, baseline);
                }
                if (changes === "rescan") {
                    needsRescan = false;
                    dirty.clear();
                    changes = await rescan();
                }
                emit(changes);
            }
        } catch {
            // Everything above is total; stay defensive so a flush never rejects.
        } finally {
            flushing = false;
        }
    };

    /**
     * Re-read tyr.json + .tyrignore and drop baseline files they now ignore.
     * The caller follows up with a rescan, which reports files the new rules
     * un-ignore as added (they just entered the watched set).
     */
    const refreshPatterns = async (): Promise<void> => {
        patterns = (await loadUserIgnorePatterns(absRoot)).patterns;
        filter = createPathIgnoreFilter(patterns);
        // Dropped silently: the files did not change, the rules did. Without
        // this the rescan would report every one of them as removed.
        for (const rel of [...(known?.keys() ?? [])]) {
            if (filter.ignores(rel, false)) {
                known?.delete(rel);
            }
        }
    };

    const schedule = (): void => {
        if (closed) {
            return;
        }
        // Trailing debounce, capped so a never-ending burst still flushes.
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

    const onFsEvent = (filename: string | null): void => {
        if (closed || mode === "poll") {
            return;
        }
        if (filename === null || filename.length === 0) {
            // The platform could not say what changed; only a rescan can.
            needsRescan = true;
            schedule();
            return;
        }
        const rel = filename.split(path.sep).join("/");
        if (!pinnedPatterns && (rel === TYR_IGNORE_FILE || rel === TYR_CONFIG_PATH)) {
            reloadPatterns = true;
            schedule();
            return;
        }
        // Cheap pruning so a busy ignored directory (node_modules, .git, the
        // daemon's own .tyr/logs, a nested worktree) never fills the dirty
        // set. Only ancestors are judged here: whether the entry itself is a
        // file or a directory is not known until it is stat'ed at flush time.
        const parent = path.posix.dirname(rel);
        if (isInsideNestedRepo(rel, nestedRepos)) {
            return;
        }
        if (path.posix.basename(rel) === NESTED_REPO_MARKER && parent !== ".") {
            // `<dir>/.git` itself appeared or vanished: <dir> may have
            // become (or stopped being) a nested repository.
            if (!isAlwaysIgnored(parent) && !filter.ignores(parent, true)) {
                nestedProbes.add(parent);
                schedule();
            }
            return;
        }
        if (isAlwaysIgnored(rel) || (parent !== "." && filter.ignores(parent, true))) {
            return;
        }
        if (needsRescan) {
            return; // A rescan will see this anyway.
        }
        if (dirty.size >= maxPendingPaths) {
            needsRescan = true;
            dirty.clear();
        } else {
            dirty.add(rel);
        }
        schedule();
    };

    /** `reason` is undefined for forcePolling, which is a choice, not a fallback. */
    const startPolling = (reason?: string): void => {
        if (closed || pollTimer !== null) {
            return;
        }
        mode = "poll";
        if (reason !== undefined && options.onFallback !== undefined) {
            try {
                options.onFallback(reason);
            } catch {
                // Reporting the fallback must not prevent it.
            }
        }
        if (watcher !== null) {
            closeQuietly(watcher);
            watcher = null;
        }
        pollTimer = setInterval(() => {
            needsRescan = true;
            void flush();
        }, pollIntervalMs);
        if (!persistent) {
            pollTimer.unref();
        }
    };

    // The watcher goes up first — before the ignore rules are loaded and
    // before the baseline scan — so that nothing slips through the gap;
    // anything it catches meanwhile waits in `dirty` for the baseline (and
    // is judged by the real rules at flush time).
    if (options.forcePolling === true) {
        startPolling();
    } else {
        try {
            watcher = fs.watch(absRoot, { persistent, recursive: true }, (_event, filename) => {
                onFsEvent(filename === null ? null : filename.toString());
            });
            // Any watcher error degrades to polling rather than leaving a
            // silent blind spot.
            watcher.on("error", (error) => startPolling(`fs.watch failed: ${describeError(error)}`));
        } catch (error) {
            // ERR_FEATURE_UNAVAILABLE_ON_PLATFORM (recursive watch on an old
            // Node), EMFILE/ENOSPC, or a root that does not exist.
            startPolling(`fs.watch could not start: ${describeError(error)}`);
        }
    }

    if (!pinnedPatterns) {
        patterns = (await loadUserIgnorePatterns(absRoot)).patterns;
        filter = createPathIgnoreFilter(patterns);
    }
    if (respectGitignore) {
        const inside = await runGit(absRoot, ["rev-parse", "--is-inside-work-tree"]);
        gitAware = inside.ok && inside.stdout.trim() === "true";
    }

    await rescan();
    known ??= new Map();

    // A file written while the baseline scan runs is a race: if the walk
    // lists it after the write, the write is folded into the baseline, and
    // its fs.watch event then classifies as "unchanged" and is dropped. The
    // same happens to a write between `since` (e.g. the daemon reporting
    // itself running) and the watcher attaching. So, by definition, every
    // baseline file whose mtime is at or after `since` changed while we were
    // watching and is reported in a first batch: as added when it was born
    // after `since` too (where the platform records a birth time), else as
    // modified. Its fs.watch event, if any, then finds it unchanged. What
    // this cannot recover is a *removal* in that window (there was no
    // earlier baseline to miss it from).
    if (since !== undefined) {
        // File-system timestamps can come from a coarser clock than
        // Date.now() (Linux stamps with the kernel tick), so a write just
        // after `since` may carry an mtime a few ms before it.
        emit(await changedSince(absRoot, known, since - COARSE_CLOCK_SLACK_MS, Date.now() + FUTURE_MTIME_SLACK_MS));
    }

    if (needsRescan || dirty.size > 0 || reloadPatterns) {
        schedule();
    }

    return {
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
            if (watcher !== null) {
                closeQuietly(watcher);
                watcher = null;
            }
        },
    };
}

/* -------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------- */

/** Any segment is `.git` or `.tyr`, whether it is a file or a directory. */
function isAlwaysIgnored(rel: string): boolean {
    return rel.split("/").some((segment) => ALWAYS_IGNORED_SEGMENTS.has(segment));
}

/**
 * Add every reportable file below `relDir` to `out`, applying the same rules
 * as the scanner (ignore filter, symlinks skipped, nested repositories
 * skipped and added to `nestedRepos`). Returns false once `out` grows past
 * `limit`, which the caller turns into a full rescan.
 */
async function walkDirectory(
    absRoot: string,
    relDir: string,
    filter: PathIgnoreFilter,
    nestedRepos: Set<string>,
    out: Set<string>,
    limit: number,
): Promise<boolean> {
    const stack = [relDir];
    while (stack.length > 0) {
        const dir = stack.pop() as string;
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(path.join(absRoot, dir), { withFileTypes: true });
        } catch {
            continue; // Vanished or unreadable: nothing to add from it.
        }
        if (hasNestedRepoMarker(entries.map((entry) => entry.name))) {
            nestedRepos.add(dir);
            continue;
        }
        for (const entry of entries) {
            const rel = `${dir}/${entry.name}`;
            if (entry.isSymbolicLink() || isAlwaysIgnored(rel)) {
                continue;
            }
            if (entry.isDirectory()) {
                if (!filter.ignores(rel, true)) {
                    stack.push(rel);
                }
            } else if (entry.isFile() && !filter.ignores(rel, false)) {
                out.add(rel);
                if (out.size > limit) {
                    return false;
                }
            }
        }
    }
    return true;
}

/**
 * Which of `paths` git ignores. Tracked files are never reported (git's own
 * rule), matching `ls-files --cached --others --exclude-standard`. Fails
 * open: if git errors (e.g. a path inside a submodule), that chunk counts
 * as not ignored, so a change is over-reported rather than lost.
 */
async function checkGitIgnored(absRoot: string, paths: readonly string[]): Promise<Set<string>> {
    const ignored = new Set<string>();
    for (let start = 0; start < paths.length; start += CHECK_IGNORE_CHUNK) {
        const chunk = paths.slice(start, start + CHECK_IGNORE_CHUNK);
        // Exit status 1 means "none ignored" and still leaves stdout empty,
        // so stdout is read regardless of `ok`.
        const result = await runGit(absRoot, ["check-ignore", "-z", "--stdin"], {
            input: `${chunk.join("\0")}\0`,
        });
        for (const rel of result.stdout.split("\0")) {
            if (rel.length > 0) {
                ignored.add(rel);
            }
        }
    }
    return ignored;
}

/**
 * Baseline files with `since <= mtime <= until`, split into added (born at
 * or after `since`, where the platform keeps a birth time) and modified.
 * `until` guards against files with mtimes in the future (an archive
 * extracted with bogus dates), which would otherwise show up on every start.
 */
async function changedSince(
    absRoot: string,
    baseline: Map<string, FileFingerprint>,
    since: number,
    until: number,
): Promise<Changes> {
    const changes: Changes = { added: [], modified: [], removed: [] };
    for (const [rel, fingerprint] of baseline) {
        if (fingerprint.mtimeMs < since || fingerprint.mtimeMs > until) {
            continue;
        }
        const stats = await lstatOrNull(path.join(absRoot, rel));
        // Linux without statx reports a birth time of 0, i.e. "modified".
        if (stats !== null && stats.birthtimeMs >= since) {
            changes.added.push(rel);
        } else {
            changes.modified.push(rel);
        }
    }
    return changes;
}

/** True when `absDir` holds a `.git` entry (directory or file). */
async function hasGitEntry(absDir: string): Promise<boolean> {
    return (await lstatOrNull(path.join(absDir, NESTED_REPO_MARKER))) !== null;
}

/**
 * Add to `nestedRepos` every ancestor directory of `paths` (below the root)
 * that holds a `.git` entry. Returns true when any was added.
 */
async function findNestedAncestors(absRoot: string, paths: readonly string[], nestedRepos: Set<string>): Promise<boolean> {
    const checked = new Set<string>();
    let found = false;
    for (const rel of paths) {
        for (let slash = rel.indexOf("/"); slash > 0; slash = rel.indexOf("/", slash + 1)) {
            const dir = rel.slice(0, slash);
            if (checked.has(dir)) {
                continue;
            }
            checked.add(dir);
            if (!nestedRepos.has(dir) && (await hasGitEntry(path.join(absRoot, dir)))) {
                nestedRepos.add(dir);
                found = true;
            }
        }
    }
    return found;
}

async function lstatOrNull(target: string): Promise<fs.Stats | null> {
    try {
        return await fs.promises.lstat(target);
    } catch {
        return null;
    }
}

function sameFingerprint(a: FileFingerprint, b: FileFingerprint): boolean {
    return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function closeQuietly(watcher: fs.FSWatcher): void {
    try {
        watcher.close();
    } catch {
        // Already closed or the handle is gone; nothing left to release.
    }
}

/** Plain code-unit order, the same order scan-diff.ts sorts manifests in. */
function compareStrings(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}
