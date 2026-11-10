// Event/history store: an append-only record of what happened in a project —
// what Claude Code did, what Tyr detected, and what actions were taken.
//
// Storage is JSON Lines at `.tyr/state/events.jsonl`, one event per line. It
// lives under state/ so the generated `.tyr/.gitignore` already excludes it
// and `tyr init --force` (which never touches extra files in state/) keeps it.
//
//   {"v":1,"id":"…","ts":"2026-11-01T14:22:33.120Z","source":"git","kind":"git.head","message":"…","data":{…}}
//
// Concurrency: each event is written with a single `fs.appendFile` of one
// complete line (O_APPEND), so appenders in different processes (daemon,
// CLI commands, Claude Code hooks) never interleave mid-line.
//
// Rotation: before appending, if events.jsonl is at or above `maxBytes`
// (default 5 MiB) it becomes events.1.jsonl, older files shift up
// (events.1 -> events.2, ...) and only `keep` rotated files (default 3)
// survive. `readEvents` reads across all of them, oldest first.
//
// Public API:
//   appendEvent(root, input, opts?)  -> Promise<TyrEvent | null>  never throws
//   readEvents(root, filter?)        -> Promise<TyrEvent[]>       never throws
//   gitEventToTyrEvent(gitEvent)     -> TyrEventInput             for git-watch.ts events
//   fsBatchToTyrEvent(batch)         -> TyrEventInput             for fs-watch.ts batches
//   eventsFile(root)                 -> string                    absolute path of events.jsonl
//
// Kinds are dotted strings, "<area>.<what>". Conventional ones:
//   daemon.started / daemon.stopped / daemon.crashed   (source "tyr")
//   init.completed                                     (source "tyr")
//   git.head / git.index / git.refs / git.merge-state  (source "git", see gitEventToTyrEvent)
//   fs.changed                                         (source "fs", see fsBatchToTyrEvent)
//   claude.tool_use / claude.session_*                 (source "claude")
//   check.passed / check.failed                        (source "check")
//   action.taken                                       (source "tyr" or "user")
//
// Like scaffold.ts this module is silent and, like appendLog, best-effort:
// recording history must never break the command doing the real work.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveTyrPaths } from "./scaffold.js";
import type { GitOperationState, GitWatchEvent } from "./git-watch.js";
import type { FileChangeBatch } from "./fs-watch.js";

/* -------------------------------------------------------------------------
 * Model
 * ---------------------------------------------------------------------- */

export const EVENT_VERSION = 1;

export type EventSource = "tyr" | "git" | "fs" | "claude" | "user" | "check";

export const EVENT_SOURCES: readonly EventSource[] = ["tyr", "git", "fs", "claude", "user", "check"];

export interface TyrEvent {
    v: typeof EVENT_VERSION;
    id: string;
    /** ISO-8601 UTC timestamp. */
    ts: string;
    source: EventSource;
    /** Dotted kind, e.g. "daemon.started", "git.head", "action.taken". */
    kind: string;
    message?: string;
    /** Free-form, JSON-serializable payload. */
    data?: Record<string, unknown>;
}

/** What callers supply to appendEvent; v, id and ts are filled in. */
export interface TyrEventInput {
    source: EventSource;
    kind: string;
    message?: string;
    data?: Record<string, unknown>;
    /** Override the timestamp (Date or ISO string). Default: now. */
    ts?: Date | string;
}

export interface AppendEventOptions {
    /** Rotate once events.jsonl reaches this size. Default 5 MiB. */
    maxBytes?: number;
    /** Rotated files to keep (events.1 … events.N). Default 3. */
    keep?: number;
}

export const DEFAULT_EVENTS_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_EVENTS_KEEP = 3;

const EVENTS_BASENAME = "events";
const ROTATED_FILE = /^events\.(\d+)\.jsonl$/;

/** Absolute path of the live history file, `.tyr/state/events.jsonl`. */
export function eventsFile(root: string): string {
    return path.join(resolveTyrPaths(root).stateDir, `${EVENTS_BASENAME}.jsonl`);
}

function rotatedFile(stateDir: string, index: number): string {
    return path.join(stateDir, `${EVENTS_BASENAME}.${index}.jsonl`);
}

/* -------------------------------------------------------------------------
 * Append
 * ---------------------------------------------------------------------- */

function toIso(value: Date | string | undefined): string {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
    if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
    return new Date().toISOString();
}

/** Shift events.jsonl -> events.1.jsonl -> … dropping anything past `keep`. */
async function rotate(stateDir: string, live: string, keep: number): Promise<void> {
    if (keep <= 0) {
        await fs.rm(live, { force: true });
        return;
    }
    await fs.rm(rotatedFile(stateDir, keep), { force: true });
    for (let index = keep - 1; index >= 1; index--) {
        try {
            await fs.rename(rotatedFile(stateDir, index), rotatedFile(stateDir, index + 1));
        } catch {
            // A missing slot is normal while history is still short.
        }
    }
    // Another process may have rotated first; then this rename fails with
    // ENOENT (or moves a fresh, tiny file), both harmless.
    await fs.rename(live, rotatedFile(stateDir, 1));
}

/**
 * Append one event. Returns the stored event, or null if it could not be
 * written. Never throws.
 */
export async function appendEvent(
    root: string,
    input: TyrEventInput,
    opts: AppendEventOptions = {},
): Promise<TyrEvent | null> {
    try {
        const { stateDir } = resolveTyrPaths(root);
        const live = eventsFile(root);

        const event: TyrEvent = {
            v: EVENT_VERSION,
            id: randomUUID(),
            ts: toIso(input.ts),
            source: EVENT_SOURCES.includes(input.source) ? input.source : "tyr",
            kind: String(input.kind),
        };
        if (typeof input.message === "string") event.message = input.message;
        if (input.data !== undefined) event.data = input.data;
        // JSON.stringify never emits raw newlines, so this is exactly one line.
        const line = `${JSON.stringify(event)}\n`;

        await fs.mkdir(stateDir, { recursive: true });

        const maxBytes = opts.maxBytes ?? DEFAULT_EVENTS_MAX_BYTES;
        if (maxBytes > 0) {
            try {
                const { size } = await fs.stat(live);
                if (size >= maxBytes) await rotate(stateDir, live, opts.keep ?? DEFAULT_EVENTS_KEEP);
            } catch {
                // No file yet, or a lost rotation race: just append.
            }
        }

        await fs.appendFile(live, line, "utf8");
        return event;
    } catch {
        return null;
    }
}

/* -------------------------------------------------------------------------
 * Read
 * ---------------------------------------------------------------------- */

export interface ReadEventsOptions {
    /** Inclusive lower bound (Date or ISO string). */
    since?: Date | string;
    /** Inclusive upper bound (Date or ISO string). */
    until?: Date | string;
    sources?: readonly EventSource[];
    /**
     * Kind filters. A pattern ending in "." is a prefix ("git." matches
     * "git.head"); otherwise it matches that exact kind or its dotted
     * children ("daemon" matches "daemon.started", but "daemon.start" does
     * not match "daemon.started").
     */
    kinds?: readonly string[];
    /** Keep only the most recent N matching events. */
    limit?: number;
    /** Return newest first. Default false (chronological). */
    newestFirst?: boolean;
}

function boundOf(value: Date | string | undefined): number | null {
    if (value === undefined) return null;
    const ms = value instanceof Date ? value.getTime() : Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
}

function kindMatches(kind: string, pattern: string): boolean {
    if (pattern.endsWith(".")) return kind.startsWith(pattern);
    return kind === pattern || kind.startsWith(`${pattern}.`);
}

function parseLine(line: string): TyrEvent | null {
    if (line.trim() === "") return null;
    try {
        const value: unknown = JSON.parse(line);
        if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
        const raw = value as Partial<TyrEvent>;
        if (typeof raw.ts !== "string" || Number.isNaN(Date.parse(raw.ts))) return null;
        if (typeof raw.kind !== "string" || typeof raw.source !== "string") return null;
        const event: TyrEvent = {
            v: EVENT_VERSION,
            id: typeof raw.id === "string" ? raw.id : "",
            ts: raw.ts,
            source: raw.source as EventSource,
            kind: raw.kind,
        };
        if (typeof raw.message === "string") event.message = raw.message;
        if (raw.data !== null && typeof raw.data === "object" && !Array.isArray(raw.data)) event.data = raw.data;
        return event;
    } catch {
        return null;
    }
}

/** History files oldest first: events.N … events.1, then events.jsonl. */
async function historyFiles(stateDir: string): Promise<string[]> {
    let names: string[];
    try {
        names = await fs.readdir(stateDir);
    } catch {
        return [];
    }
    const rotated = names
        .map((name) => ROTATED_FILE.exec(name))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => ({ name: match[0], index: Number(match[1]) }))
        .sort((a, b) => b.index - a.index)
        .map((entry) => path.join(stateDir, entry.name));
    const files = [...rotated];
    if (names.includes(`${EVENTS_BASENAME}.jsonl`)) files.push(path.join(stateDir, `${EVENTS_BASENAME}.jsonl`));
    return files;
}

/**
 * Read history across the live and rotated files. Malformed or partial lines
 * are skipped. Events come back in file (append) order, which is
 * chronological for a single machine. Never throws; a missing store is [].
 */
export async function readEvents(root: string, options: ReadEventsOptions = {}): Promise<TyrEvent[]> {
    const { stateDir } = resolveTyrPaths(root);
    const since = boundOf(options.since);
    const until = boundOf(options.until);
    const sources = options.sources !== undefined ? new Set<string>(options.sources) : null;
    const kinds = options.kinds;

    const events: TyrEvent[] = [];
    for (const file of await historyFiles(stateDir)) {
        let contents: string;
        try {
            contents = await fs.readFile(file, "utf8");
        } catch {
            continue; // Rotated away between readdir and read.
        }
        for (const line of contents.split("\n")) {
            const event = parseLine(line);
            if (event === null) continue;
            const ms = Date.parse(event.ts);
            if (since !== null && ms < since) continue;
            if (until !== null && ms > until) continue;
            if (sources !== null && !sources.has(event.source)) continue;
            if (kinds !== undefined && !kinds.some((pattern) => kindMatches(event.kind, pattern))) continue;
            events.push(event);
        }
    }

    let result = events;
    if (options.limit !== undefined && options.limit >= 0) {
        result = options.limit === 0 ? [] : events.slice(-options.limit);
    }
    return options.newestFirst === true ? result.reverse() : result;
}

/* -------------------------------------------------------------------------
 * Git watcher mapping
 * ---------------------------------------------------------------------- */

function shortHash(hash: string | null): string {
    return hash === null ? "(none)" : hash.slice(0, 7);
}

const OPERATION_NAMES: Record<keyof GitOperationState, string> = {
    merging: "merge",
    rebasing: "rebase",
    cherryPicking: "cherry-pick",
    reverting: "revert",
    bisecting: "bisect",
};

function refVerb(change: { previous: string | null; current: string | null }): string {
    if (change.previous === null) return "created";
    if (change.current === null) return "deleted";
    return "updated";
}

/**
 * Map a git-watch.ts event to an event input (source "git", kind
 * "git.<watch kind>"). The watcher payload is kept verbatim in `data`, plus a
 * few derived fields; `message` is a one-line human summary.
 */
export function gitEventToTyrEvent(event: GitWatchEvent): TyrEventInput {
    switch (event.kind) {
        case "head": {
            const { previous, current } = event;
            let message: string;
            if (event.branchChanged) {
                message = `Switched from ${previous.branch ?? "(none)"} to ${current.branch ?? "(none)"} at ${shortHash(current.commit)}`;
            } else if (event.commitChanged) {
                message = `HEAD on ${current.branch ?? "(detached)"} moved ${shortHash(previous.commit)} -> ${shortHash(current.commit)}`;
            } else {
                message = `HEAD changed on ${current.branch ?? "(detached)"}`;
            }
            return {
                source: "git",
                kind: "git.head",
                message,
                data: {
                    previous,
                    current,
                    commitChanged: event.commitChanged,
                    branchChanged: event.branchChanged,
                },
            };
        }
        case "index":
            return {
                source: "git",
                kind: "git.index",
                message:
                    event.staged.length === 0
                        ? "Index cleared: nothing staged"
                        : `${event.staged.length} path${event.staged.length === 1 ? "" : "s"} staged`,
                data: { staged: event.staged },
            };
        case "refs": {
            const shown = event.changes.slice(0, 3).map((change) => `${change.ref} ${refVerb(change)}`);
            const more = event.changes.length > 3 ? ` (+${event.changes.length - 3} more)` : "";
            return {
                source: "git",
                kind: "git.refs",
                message: `${shown.join(", ")}${more}`,
                data: { changes: event.changes },
            };
        }
        case "merge-state": {
            const keys = Object.keys(OPERATION_NAMES) as (keyof GitOperationState)[];
            const started = keys.filter((key) => event.current[key] && !event.previous[key]).map((key) => OPERATION_NAMES[key]);
            const finished = keys.filter((key) => !event.current[key] && event.previous[key]).map((key) => OPERATION_NAMES[key]);
            const parts: string[] = [];
            if (started.length > 0) parts.push(`started ${started.join(", ")}`);
            if (finished.length > 0) parts.push(`finished ${finished.join(", ")}`);
            return {
                source: "git",
                kind: "git.merge-state",
                message: parts.length > 0 ? `Git operation ${parts.join("; ")}` : "Git operation state changed",
                data: { previous: event.previous, current: event.current, started, finished },
            };
        }
    }
}

/** Most paths per list kept in an fs.changed event's data. */
export const FS_EVENT_MAX_PATHS = 50;

/** Paths named in an fs.changed message before "(+N more)". */
const FS_MESSAGE_PATHS = 2;

/**
 * Map an fs-watch.ts batch to an event input (source "fs", kind
 * "fs.changed"). `data` is `{ added, modified, removed, total, truncated }`:
 * each list capped at FS_EVENT_MAX_PATHS, `total` the real number of changed
 * files, and `truncated` true when any list (here or in the watcher's own
 * storm cap) lost paths. The message reads like
 * "3 files changed: src/a.ts, src/b.ts (+1 more)", naming added, then
 * modified, then removed paths.
 */
export function fsBatchToTyrEvent(batch: FileChangeBatch): TyrEventInput {
    const cap = (list: readonly string[]): string[] => list.slice(0, FS_EVENT_MAX_PATHS);
    const added = cap(batch.added);
    const modified = cap(batch.modified);
    const removed = cap(batch.removed);
    const listed = batch.added.length + batch.modified.length + batch.removed.length;
    // A hand-built batch may omit or understate total; never report fewer
    // files than the lists themselves hold.
    const total = Math.max(Number.isFinite(batch.total) ? batch.total : 0, listed);
    const truncated =
        batch.truncated === true ||
        total > listed ||
        added.length < batch.added.length ||
        modified.length < batch.modified.length ||
        removed.length < batch.removed.length;

    const shown = [...batch.added, ...batch.modified, ...batch.removed].slice(0, FS_MESSAGE_PATHS);
    const more = total > shown.length ? ` (+${total - shown.length} more)` : "";
    const noun = total === 1 ? "file" : "files";
    return {
        source: "fs",
        kind: "fs.changed",
        message: shown.length > 0 ? `${total} ${noun} changed: ${shown.join(", ")}${more}` : `${total} ${noun} changed`,
        data: { added, modified, removed, total, truncated },
    };
}
