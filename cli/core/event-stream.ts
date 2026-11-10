// Live reader for the event journal: `tail -f` for `.tyr/state/events.jsonl`
// that survives rotation. Together with daemon-requests.ts this is the IPC
// channel between the daemon and the CLI (PLANNING.md 2.9).
//
// Why a journal and not a Unix socket / named pipe:
//   - Portable as-is. The same code runs on macOS, Linux and Windows; a socket
//     needs a separate named-pipe path (\\.\pipe\…) on Windows, plus stale
//     socket-file cleanup on POSIX after a crash.
//   - Works when the daemon is down. Writers never need a listener: `tyr init`,
//     CLI commands and (later) Claude Code hooks append whether or not a daemon
//     runs, and a reader started later still sees what happened.
//   - Replayable. A follower can start with history (`backlog` / `since`) and
//     then switch to live delivery, so `tyr watch` attaching late, or
//     re-attaching after a crash, loses nothing. A socket only carries what
//     is sent while both ends are connected.
//   - Many writers, many readers, no broker. The daemon is just one appender
//     among several (CLI, hooks, file watcher); with a socket every one of
//     them would have to route through the daemon or the daemon would have to
//     fan out to every client.
// The cost is latency (fs.watch is near-instant, the polling fallback is
// bounded by `pollIntervalMs`) and that requests need their own small path,
// see daemon-requests.ts.
//
// How following works:
//   - An open file handle on the live file plus a byte offset. Only appended
//     bytes are read; a trailing line without its newline yet is buffered (as
//     bytes, so a multi-byte UTF-8 character split across reads survives)
//     until the rest arrives.
//   - Rotation (events.ts renames events.jsonl -> events.1.jsonl and starts a
//     fresh file) is detected by inode: when the handle's inode is no longer
//     the live path's, the handle (which still points at the renamed file) is
//     drained to its end, then the reader moves to the next newer file in the
//     chain. Following the chain by inode, not by name, means even several
//     rotations between two reads (events.1 shifted on to events.2 already)
//     lose and duplicate nothing. Where inodes are unavailable (reported as
//     0) a live file smaller than the offset is taken as rotation instead.
//   - Wake-ups come from fs.watch on the state directory (not the file: the
//     file is replaced on rotation and may not exist yet), with a periodic
//     safety poll because fs.watch can drop or coalesce notifications. Where
//     fs.watch is unavailable (or `forcePolling`), polling alone drives it.
//   - A missing file or state directory is simply "nothing yet": the reader
//     keeps polling and starts from byte 0 of the file once it appears.
//   - Delivered ids are remembered in a bounded window, which removes the
//     overlap between the backlog (read with readEvents) and the live tail
//     (positioned before that read, so nothing falls in the gap).
//
// Like events.ts this module is silent and never throws: followEvents always
// resolves, I/O errors just mean "try again on the next wake-up", and
// exceptions from onEvent are swallowed so one bad consumer cannot stop the
// stream.

import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
    compileEventFilter,
    eventsFile,
    parseEventLine,
    readEvents,
    ROTATED_EVENTS_FILE,
    type EventSource,
    type TyrEvent,
} from "./events.js";
import { resolveTyrPaths } from "./scaffold.js";

export interface FollowEventsOptions {
    /** Called once per matching event, in journal order. Exceptions are swallowed. */
    onEvent: (event: TyrEvent) => void;
    /** Replay the last N matching events before going live. Default 0. */
    backlog?: number;
    /** Replay every matching event at or after this time before going live. */
    since?: Date | string;
    /** Same semantics as readEvents. */
    sources?: readonly EventSource[];
    /** Same semantics as readEvents (prefix "git." or exact-or-child "daemon"). */
    kinds?: readonly string[];
    /** Aborting closes the follower, like close(). */
    signal?: AbortSignal;
    /**
     * Poll period when fs.watch is not in use. In watch mode a safety poll
     * still runs every max(1000, 4 × this). Default 250ms.
     */
    pollIntervalMs?: number;
    /** Skip fs.watch and only poll (network filesystems, tests). Default false. */
    forcePolling?: boolean;
    /** Keep the event loop alive while following. Default true. */
    persistent?: boolean;
}

export interface EventFollower {
    /** "watch" while an fs.watch on the state directory is active, else "poll". */
    readonly mode: "watch" | "poll";
    /** Stop following. Idempotent; pending reads finish, nothing more is delivered. */
    close(): void;
    /** Resolves once the follower is closed and its file handle released. */
    done: Promise<void>;
}

export const DEFAULT_FOLLOW_POLL_MS = 250;
const MIN_SAFETY_POLL_MS = 1000;
const READ_CHUNK_BYTES = 64 * 1024;
/** How many delivered ids are remembered for de-duplication. */
const DEDUPE_WINDOW = 4096;
/** Bound on file-to-file moves in one wake-up; the rest waits for the next. */
const MAX_HOPS = 16;
/**
 * Consecutive listings in which the followed file cannot be found before it
 * is assumed deleted (rotated past `keep`). Listing the directory is not
 * atomic with a concurrent rotation, so one miss can be a race.
 */
const MAX_MISSES = 3;

interface OpenFile {
    handle: fs.FileHandle;
    /** 0n where the platform/filesystem has no stable inode. */
    ino: bigint;
    size: number;
}

interface HistoryEntry {
    /** 0 for events.jsonl, N for events.N.jsonl. */
    index: number;
    path: string;
    ino: bigint;
    size: number;
}

async function openFile(file: string): Promise<OpenFile | null> {
    let handle: fs.FileHandle;
    try {
        handle = await fs.open(file, "r");
    } catch {
        return null;
    }
    try {
        const stat = await handle.stat({ bigint: true });
        return { handle, ino: stat.ino, size: Number(stat.size) };
    } catch {
        await handle.close().catch(() => undefined);
        return null;
    }
}

/** Live and rotated history files with their inodes, oldest (highest index) first. */
async function listHistory(stateDir: string, live: string): Promise<HistoryEntry[]> {
    let names: string[];
    try {
        names = await fs.readdir(stateDir);
    } catch {
        return [];
    }
    const candidates: { index: number; path: string }[] = [];
    for (const name of names) {
        if (name === path.basename(live)) {
            candidates.push({ index: 0, path: live });
            continue;
        }
        const match = ROTATED_EVENTS_FILE.exec(name);
        if (match !== null) candidates.push({ index: Number(match[1]), path: path.join(stateDir, name) });
    }
    const entries: HistoryEntry[] = [];
    for (const candidate of candidates) {
        try {
            const stat = await fs.stat(candidate.path, { bigint: true });
            entries.push({ ...candidate, ino: stat.ino, size: Number(stat.size) });
        } catch {
            // Renamed or deleted since readdir.
        }
    }
    return entries.sort((a, b) => b.index - a.index);
}

/**
 * Follow the event journal of `root`. Resolves once the backlog (if any) has
 * been delivered and live following has started. Never rejects.
 */
export async function followEvents(root: string, options: FollowEventsOptions): Promise<EventFollower> {
    const { stateDir } = resolveTyrPaths(root);
    const live = eventsFile(root);
    const pollMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_FOLLOW_POLL_MS);
    const safetyMs = Math.max(MIN_SAFETY_POLL_MS, pollMs * 4);
    const persistent = options.persistent ?? true;
    // `since` only bounds the replay: anything appended while following is new,
    // whatever timestamp its writer chose.
    const matches = compileEventFilter({ sources: options.sources, kinds: options.kinds });

    let closed = false;
    let current: OpenFile | null = null;
    let offset = 0;
    let partial: Buffer = Buffer.alloc(0);
    let misses = 0;
    const recent = new Set<string>();
    let watcher: fsSync.FSWatcher | null = null;
    let timer: NodeJS.Timeout | null = null;
    let running: Promise<void> | null = null;
    let rerun = false;

    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
    });

    const deliver = (event: TyrEvent): void => {
        if (closed) return;
        // Events without an id (hand-written lines) cannot be de-duplicated.
        if (event.id !== "") {
            if (recent.has(event.id)) return;
            recent.add(event.id);
            if (recent.size > DEDUPE_WINDOW) {
                // Sets iterate in insertion order: drop the oldest id.
                const oldest = recent.values().next().value;
                if (oldest !== undefined) recent.delete(oldest);
            }
        }
        if (!matches(event)) return;
        try {
            options.onEvent(event);
        } catch {
            // A consumer's bug must not stop the stream.
        }
    };

    const consume = (chunk: Buffer): void => {
        const data = partial.length > 0 ? Buffer.concat([partial, chunk]) : chunk;
        let start = 0;
        for (let newline = data.indexOf(0x0a, start); newline !== -1; newline = data.indexOf(0x0a, start)) {
            const event = parseEventLine(data.toString("utf8", start, newline));
            if (event !== null) deliver(event);
            start = newline + 1;
        }
        // Copy: `chunk` is a reused read buffer.
        partial = start < data.length ? Buffer.from(data.subarray(start)) : Buffer.alloc(0);
    };

    /** A file we are leaving will get no more lines; a complete-but-unterminated one is still worth trying. */
    const flushPartial = (): void => {
        if (partial.length > 0) {
            const event = parseEventLine(partial.toString("utf8"));
            if (event !== null) deliver(event);
        }
        partial = Buffer.alloc(0);
    };

    const readToEnd = async (): Promise<void> => {
        if (current === null) return;
        const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
        while (!closed) {
            const { bytesRead } = await current.handle.read(buffer, 0, READ_CHUNK_BYTES, offset);
            if (bytesRead === 0) return;
            offset += bytesRead;
            consume(buffer.subarray(0, bytesRead));
        }
    };

    const closeCurrent = async (): Promise<void> => {
        const file = current;
        current = null;
        if (file !== null) await file.handle.close().catch(() => undefined);
    };

    /**
     * Move to `next`, from its first byte. False when it changed under us
     * (the caller re-lists and retries).
     *
     * `anchor` is where the file we are leaving was listed. The listing is a
     * readdir plus one stat per file, so a rotation landing halfway through
     * it can pair a stale position for our file with an already-shifted
     * successor, skipping a whole file. Rotation shifts names strictly
     * upward, oldest first (k -> k+1 before k-1 -> k), so if our file still
     * sits at the anchor *after* `next` was opened, the k-1 -> k shift had
     * not happened yet and what we opened really is the next newer file.
     */
    const switchTo = async (next: HistoryEntry, anchor?: { path: string; ino: bigint }): Promise<boolean> => {
        const opened = await openFile(next.path);
        if (opened === null) return false;
        let consistent = next.ino === 0n || opened.ino === next.ino;
        if (consistent && anchor !== undefined) {
            try {
                consistent = (await fs.stat(anchor.path, { bigint: true })).ino === anchor.ino;
            } catch {
                consistent = false;
            }
        }
        if (!consistent) {
            await opened.handle.close().catch(() => undefined);
            return false;
        }
        flushPartial();
        await closeCurrent();
        current = opened;
        offset = 0;
        misses = 0;
        return true;
    };

    /** Read everything new, following rotation. One run at a time (see wake). */
    const pump = async (): Promise<void> => {
        if (current === null) {
            current = await openFile(live);
            if (current === null) return; // Not created yet.
            offset = 0;
            partial = Buffer.alloc(0);
        }
        for (let hop = 0; hop < MAX_HOPS && !closed; hop++) {
            await readToEnd();
            const files = await listHistory(stateDir, live);
            // close() may have released the handle while we awaited.
            const followed: OpenFile | null = current;
            if (followed === null || closed) return;
            let next: HistoryEntry | undefined;
            let anchor: { path: string; ino: bigint } | undefined;

            if (followed.ino === 0n) {
                // No inodes: the only rotation signal is the live file shrinking.
                const liveEntry = files.find((entry) => entry.index === 0);
                if (liveEntry === undefined || liveEntry.size >= offset) return;
                next = liveEntry;
            } else {
                const here = files.find((entry) => entry.ino === followed.ino);
                if (here !== undefined && here.index === 0) {
                    misses = 0;
                    if (here.size < offset) {
                        // Truncated in place (not something Tyr does): start over.
                        offset = 0;
                        partial = Buffer.alloc(0);
                        continue;
                    }
                    return;
                }
                // Rotated away (or gone): lines appended between our read and
                // the rename are in the old file, so drain it once more.
                await readToEnd();
                if (here !== undefined) {
                    misses = 0;
                    next = files.find((entry) => entry.index === here.index - 1);
                    anchor = { path: here.path, ino: followed.ino };
                    if (next === undefined) return; // The new live file is not there yet.
                } else {
                    // Possibly a race with a rotation in progress: look again on the next wake-up.
                    if (files.length > 0 && ++misses < MAX_MISSES) return;
                    // Deleted past `keep` (all remaining files are newer) or the
                    // whole store was removed: resume from the oldest survivor.
                    next = files[0];
                    if (next === undefined) {
                        flushPartial();
                        await closeCurrent();
                        misses = 0;
                        return;
                    }
                }
            }
            await switchTo(next, anchor);
        }
    };

    /** Coalesce wake-ups: at most one pump runs, and one more is queued behind it. */
    const wake = (): void => {
        if (closed) return;
        if (running !== null) {
            rerun = true;
            return;
        }
        running = (async () => {
            do {
                rerun = false;
                try {
                    await pump();
                } catch {
                    // Transient I/O error: the next wake-up retries.
                }
            } while (rerun && !closed);
        })().finally(() => {
            running = null;
        });
    };

    const attachWatcher = (): void => {
        if (watcher !== null || options.forcePolling === true || closed) return;
        try {
            const created = fsSync.watch(stateDir, { persistent }, (_type, filename) => {
                // Unknown filename (some platforms) means "something changed".
                if (filename === null || String(filename).startsWith("events")) wake();
            });
            created.on("error", () => {
                // The directory was removed, or the platform gave up: poll until it can be re-attached.
                created.close();
                if (watcher === created) watcher = null;
            });
            watcher = created;
        } catch {
            watcher = null; // State dir missing or fs.watch unsupported.
        }
    };

    const schedule = (): void => {
        if (closed) return;
        timer = setTimeout(
            () => {
                timer = null;
                attachWatcher();
                wake();
                schedule();
            },
            watcher !== null ? safetyMs : pollMs,
        );
        if (!persistent) timer.unref();
    };

    const onAbort = (): void => close();

    const close = (): void => {
        if (closed) return;
        closed = true;
        options.signal?.removeEventListener("abort", onAbort);
        if (timer !== null) clearTimeout(timer);
        timer = null;
        watcher?.close();
        watcher = null;
        void (async () => {
            await running?.catch(() => undefined);
            await closeCurrent();
            resolveDone();
        })();
    };

    const follower: EventFollower = {
        get mode() {
            return watcher !== null ? "watch" : "poll";
        },
        close,
        done,
    };

    if (options.signal?.aborted === true) {
        close();
        return follower;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    // Position the live tail at the current end *before* reading the backlog,
    // so an event appended in between is read by both (and de-duplicated)
    // rather than by neither.
    const initial = await openFile(live);
    if (initial !== null) {
        current = initial;
        offset = initial.size;
    }

    const backlog = Math.max(0, Math.floor(options.backlog ?? 0));
    if (backlog > 0 || options.since !== undefined) {
        const history = await readEvents(root, {
            since: options.since,
            sources: options.sources,
            kinds: options.kinds,
            limit: backlog > 0 ? backlog : undefined,
        });
        for (const event of history) deliver(event);
    }

    if (closed) {
        // Aborted during the backlog; close() could not see `initial` until now.
        await closeCurrent();
        return follower;
    }
    attachWatcher();
    schedule();
    wake();
    return follower;
}
