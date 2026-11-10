// Joins the daemon's two watchers into one coherent journal: git events from
// git-watch.ts and file-change batches from fs-watch.ts.
//
// The problem: a checkout, rebase, merge, pull, stash or hard reset rewrites
// working-tree files, so one `git switch main` would otherwise journal a
// git.head event *and* one or more fs.changed batches that look exactly like
// hand edits. Whoever reads the journal (`tyr watch`, a reviewer) would see
// "14 files changed" with no hint that nobody typed them.
//
// The choice: merge, not suppress. The git-driven batches become ONE
// fs.changed event with `data.cause = "git"`, `data.gitKind` and
// `data.gitEventId` (the id of the git event it is attributed to) and a
// message like "14 files changed by switching to main". Suppressing them
// would lose which files the operation touched, which is exactly what a
// reviewer wants after a merge or a pull; and the data contract
// (`added/modified/removed/total/truncated`) stays intact, only optional
// fields are added, so a consumer that ignores `cause` still renders it.
//
// The attribution rule:
//   1. *Git activity* is either a hint — git-watch's onActivity, fired the
//      moment fs.watch sees HEAD, the index, refs, an operation marker or
//      their `.lock` files change, i.e. while git is still writing — or a
//      verified git event of an *attributing* kind: git.head, git.index,
//      git.merge-state, or git.refs touching `refs/stash`. Other ref updates
//      (a fetch moving remote branches, a new tag) never rewrite files.
//   2. An fs batch that arrives within `windowMs` (default 2500ms) of the
//      latest git activity, or while a group is already open, is held in the
//      group. Any other batch is a hand edit and is journaled at once, so
//      ordinary editing pays no latency.
//   3. A group closes once `windowMs` has passed since both the latest git
//      activity and the latest batch it took in (or `maxHoldMs`, default 15s,
//      after it opened, so a long rebase still reports). The window is wider
//      than fs-watch's own burst cap (2s) plus its debounce, so the batches
//      of one long checkout chain into one group.
//   4. On close, if an attributing git event happened while the group was
//      open or within `windowMs` before it opened, the group becomes one
//      merged fs.changed event linked to the most telling such event
//      (merge-state > head > stash > index; the latest among equals).
//      Otherwise — the activity was only hints, e.g. an editor's background
//      `git status` refreshing the index stat cache — every held batch is
//      journaled unchanged, as the hand edit it was. Hints alone delay, they
//      never attribute.
//
// Deliberately NOT a rule: "an operation is in progress". During a conflicted
// merge or rebase the user resolves conflicts by hand, and those edits must
// read as hand edits. The steps of a rebase move HEAD and the index, so they
// are attributed through rule 1 anyway.
//
// Known limits, all erring towards "git did it" only near real git events:
//   - a hand edit saved within the window of a checkout is attributed to it;
//   - `git restore <file>` / `git checkout -- <file>` change neither HEAD nor
//     the index, so their rewrites read as hand edits;
//   - when git-watch is polling there are no hints and its events arrive up
//     to a poll interval late, so every batch is held for `idleHoldMs` (the
//     daemon sets it from the poll interval); a commit made within that hold
//     after an edit claims the edit.
//
// Like the watchers, nothing here throws or prints; the sink is the only
// output, and the clock and id source are injectable for tests.

import { randomUUID } from "node:crypto";
import type { FileChangeBatch } from "./fs-watch.js";
import type { GitOperationState, GitWatchEvent } from "./git-watch.js";
import { fsBatchToTyrEvent, gitEventToTyrEvent, type TyrEventInput } from "./events.js";

/* -------------------------------------------------------------------------
 * Public types
 * ---------------------------------------------------------------------- */

/** The bits of a timer API the observer needs; Node's by default. */
export interface ObserverClock {
    now(): number;
    setTimer(callback: () => void, ms: number): unknown;
    clearTimer(handle: unknown): void;
}

export interface ObserverOptions {
    /** Journal sink, called once per event to append. Exceptions are swallowed. */
    emit: (event: TyrEventInput) => void;
    /** See rule 2 in the header. Default 2500ms. */
    windowMs?: number;
    /** Hold every batch at least this long, for a polling git watcher. Default 0. */
    idleHoldMs?: number;
    /** Upper bound on how long one group can stay open. Default 15000ms. */
    maxHoldMs?: number;
    clock?: ObserverClock;
    /** Id source for git events, so fs.changed can link to them. Default randomUUID. */
    newId?: () => string;
    /** Whether timers keep the process alive. Default true (they are short anyway). */
    persistent?: boolean;
}

export interface Observer {
    /** Git-watch's onActivity hint: git is touching its state right now. */
    gitActivity(): void;
    /** A verified git event: journaled at once, and remembered for attribution. */
    gitEvent(event: GitWatchEvent): void;
    /** An fs-watch batch: journaled at once, or held per the attribution rule. */
    fsBatch(batch: FileChangeBatch): void;
    /** Retune at runtime, e.g. when a watcher falls back to polling. */
    configure(options: { windowMs?: number; idleHoldMs?: number }): void;
    /** Journal whatever is held right now (shutdown). The observer stays usable. */
    flush(): void;
    /** flush(), then ignore everything. Idempotent. */
    close(): void;
}

/** What a git-attributed fs.changed adds to the usual fs.changed data. */
export interface GitCauseData {
    cause: "git";
    /** Kind of the git event the change is attributed to, e.g. "git.head". */
    gitKind: string;
    /** Journal id of that git event. */
    gitEventId: string;
    /** How many watcher batches were merged into this event. */
    batches: number;
}

export const DEFAULT_OBSERVE_WINDOW_MS = 2500;
export const DEFAULT_OBSERVE_MAX_HOLD_MS = 15000;

/* -------------------------------------------------------------------------
 * Implementation
 * ---------------------------------------------------------------------- */

interface GitLink {
    id: string;
    kind: string;
    /** Higher wins when several git events overlap one group. */
    priority: number;
    /** Completes "N files changed by …". */
    describe: string;
    at: number;
}

interface Group {
    batches: FileChangeBatch[];
    openedAt: number;
    lastBatchAt: number;
    links: GitLink[];
    timer: unknown;
}

const NODE_CLOCK: ObserverClock = {
    now: () => Date.now(),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export function createObserver(options: ObserverOptions): Observer {
    const clock = options.clock ?? NODE_CLOCK;
    const newId = options.newId ?? randomUUID;
    const persistent = options.persistent ?? true;
    const maxHoldMs = Math.max(0, options.maxHoldMs ?? DEFAULT_OBSERVE_MAX_HOLD_MS);
    let windowMs = Math.max(0, options.windowMs ?? DEFAULT_OBSERVE_WINDOW_MS);
    let idleHoldMs = Math.max(0, options.idleHoldMs ?? 0);

    /** Time of the latest hint or attributing git event; -Infinity before any. */
    let lastActivity = Number.NEGATIVE_INFINITY;
    /** Attributing git events of the last `windowMs`, for groups opening after them. */
    let recent: GitLink[] = [];
    let group: Group | null = null;
    let closed = false;

    const emit = (event: TyrEventInput): void => {
        try {
            options.emit(event);
        } catch {
            // A failing sink must not take the observer (or the daemon) down.
        }
    };

    const closeGroup = (): void => {
        const current = group;
        if (current === null) {
            return;
        }
        group = null;
        if (current.timer !== null) {
            clock.clearTimer(current.timer);
        }
        const link = pickLink(current.links);
        if (link === null) {
            // Only hints: these were hand edits after all (rule 4).
            for (const batch of current.batches) {
                emit(fsBatchToTyrEvent(batch));
            }
            return;
        }
        const merged = mergeBatches(current.batches);
        if (merged.total === 0) {
            return; // e.g. a file git created and removed again inside one rebase.
        }
        const event = fsBatchToTyrEvent(merged);
        const extra: GitCauseData = {
            cause: "git",
            gitKind: link.kind,
            gitEventId: link.id,
            batches: current.batches.length,
        };
        emit({
            ...event,
            message: `${merged.total} ${merged.total === 1 ? "file" : "files"} changed by ${link.describe}`,
            data: { ...event.data, ...extra },
        });
    };

    /** (Re)arm the group's close timer from rule 3. */
    const arm = (): void => {
        if (group === null) {
            return;
        }
        if (group.timer !== null) {
            clock.clearTimer(group.timer);
            group.timer = null;
        }
        const now = clock.now();
        const quietAt = Math.max(lastActivity + windowMs, group.lastBatchAt + windowMs, group.openedAt + idleHoldMs);
        const closeAt = Math.min(quietAt, group.openedAt + maxHoldMs);
        if (closeAt <= now) {
            closeGroup();
            return;
        }
        const handle = clock.setTimer(() => {
            if (group !== null && group.timer === handle) {
                group.timer = null;
                arm(); // Re-checks: activity may have moved the deadline meanwhile.
            }
        }, closeAt - now);
        if (!persistent) {
            (handle as { unref?: () => void } | null)?.unref?.();
        }
        group.timer = handle;
    };

    const pruneRecent = (now: number): void => {
        recent = recent.filter((link) => now - link.at <= windowMs);
    };

    return {
        gitActivity(): void {
            if (closed) {
                return;
            }
            lastActivity = clock.now();
            arm();
        },

        gitEvent(event: GitWatchEvent): void {
            if (closed) {
                return;
            }
            const id = newId();
            emit({ ...gitEventToTyrEvent(event), id });
            const attribution = attributionOf(event);
            if (attribution === null) {
                return;
            }
            const now = clock.now();
            const link: GitLink = { id, kind: `git.${event.kind}`, at: now, ...attribution };
            lastActivity = now;
            pruneRecent(now);
            recent.push(link);
            if (group !== null) {
                group.links.push(link);
                arm();
            }
        },

        fsBatch(batch: FileChangeBatch): void {
            if (closed) {
                return;
            }
            const now = clock.now();
            if (group !== null) {
                group.batches.push(batch);
                group.lastBatchAt = now;
                arm();
                return;
            }
            const busy = now - lastActivity <= windowMs;
            if (!busy && idleHoldMs <= 0) {
                emit(fsBatchToTyrEvent(batch)); // A hand edit: no latency.
                return;
            }
            pruneRecent(now);
            group = { batches: [batch], openedAt: now, lastBatchAt: now, links: [...recent], timer: null };
            arm();
        },

        configure(next: { windowMs?: number; idleHoldMs?: number }): void {
            if (next.windowMs !== undefined) {
                windowMs = Math.max(0, next.windowMs);
            }
            if (next.idleHoldMs !== undefined) {
                idleHoldMs = Math.max(0, next.idleHoldMs);
            }
            arm();
        },

        flush(): void {
            closeGroup();
        },

        close(): void {
            if (closed) {
                return;
            }
            closeGroup();
            closed = true;
            recent = [];
        },
    };
}

/* -------------------------------------------------------------------------
 * Attribution and merging
 * ---------------------------------------------------------------------- */

const OPERATION_NAMES: Record<keyof GitOperationState, string> = {
    merging: "merge",
    rebasing: "rebase",
    cherryPicking: "cherry-pick",
    reverting: "revert",
    bisecting: "bisect",
};

/** Null for git events that never rewrite working-tree files (rule 1). */
function attributionOf(event: GitWatchEvent): { priority: number; describe: string } | null {
    switch (event.kind) {
        case "merge-state": {
            const names = (Object.keys(OPERATION_NAMES) as (keyof GitOperationState)[])
                .filter((key) => event.previous[key] || event.current[key])
                .map((key) => OPERATION_NAMES[key]);
            return { priority: 4, describe: names.length > 0 ? `git ${names.join(", ")}` : "a git operation" };
        }
        case "head": {
            const branch = event.current.branch;
            if (event.branchChanged) {
                return { priority: 3, describe: `switching to ${branch ?? "a detached HEAD"}` };
            }
            const commit = event.current.commit?.slice(0, 7) ?? "no commit";
            return { priority: 3, describe: `moving ${branch ?? "HEAD"} to ${commit}` };
        }
        case "refs":
            return event.changes.some((change) => change.ref === "refs/stash")
                ? { priority: 2, describe: "git stash" }
                : null;
        case "index":
            return { priority: 1, describe: "a git index update" };
    }
}

function pickLink(links: readonly GitLink[]): GitLink | null {
    let best: GitLink | null = null;
    for (const link of links) {
        if (best === null || link.priority >= best.priority) {
            best = link; // ">=" so the latest wins among equals.
        }
    }
    return best;
}

type NetState = "added" | "modified" | "removed";

/**
 * Fold successive batches into their net effect per path: added then
 * removed cancels out, removed then added is a modification, added then
 * modified is still an addition. A batch that was truncated cannot be folded
 * exactly, so the result is marked truncated and its total is the larger of
 * the folded count and the sum of totals.
 */
export function mergeBatches(batches: readonly FileChangeBatch[]): FileChangeBatch {
    const net = new Map<string, NetState>();
    const apply = (rel: string, next: NetState): void => {
        const before = net.get(rel);
        if (before === undefined) {
            net.set(rel, next);
        } else if (before === "added") {
            if (next === "removed") {
                net.delete(rel);
            }
            // added + modified (or a duplicate add) stays added.
        } else if (before === "removed") {
            net.set(rel, next === "removed" ? "removed" : "modified");
        } else {
            net.set(rel, next === "removed" ? "removed" : "modified");
        }
    };
    let truncated = false;
    let summed = 0;
    for (const batch of batches) {
        for (const rel of batch.added) apply(rel, "added");
        for (const rel of batch.modified) apply(rel, "modified");
        for (const rel of batch.removed) apply(rel, "removed");
        truncated ||= batch.truncated;
        summed += batch.total;
    }
    const merged: FileChangeBatch = { added: [], modified: [], removed: [], total: 0, truncated };
    for (const [rel, state] of net) {
        merged[state].push(rel);
    }
    for (const list of [merged.added, merged.modified, merged.removed]) {
        list.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    }
    merged.total = truncated ? Math.max(net.size, summed) : net.size;
    return merged;
}
