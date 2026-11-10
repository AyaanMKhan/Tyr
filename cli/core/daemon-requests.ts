// CLI -> daemon requests: the other half of the IPC channel (see
// event-stream.ts for the daemon -> CLI half and why it is a journal rather
// than a socket).
//
// A request is one small JSON file in `.tyr/state/requests/`, named
// `<epoch ms>-<uuid>.json` so a plain sort is arrival order. It is written to
// a dot-prefixed temp name and renamed into place (writeFileAtomic), so the
// daemon never reads a half-written request; the reader ignores dotfiles.
// The daemon consumes a request by deleting it, and only acts on it when its
// own delete succeeded, so a request is handled at most once even if two
// readers ever raced. Answers, where there are any, go back through the event
// journal: a ping is answered with a `daemon.pong` event carrying the
// request id, which `pingDaemon` waits for with followEvents.
//
// Request types:
//   stop   graceful shutdown (what `tyr stop` means; `tyr stop` itself still
//          uses the older `daemon.stop` file, which the daemon also polls)
//   ping   liveness / round-trip check, answered with a daemon.pong event
//
// The daemon services the directory from its existing poll timer, so a
// request is picked up within that period (500ms), not instantly. That is
// plenty for stop/ping and needs no watcher on the daemon side.
//
// Like events.ts this module is silent and never throws.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { appendEvent } from "./events.js";
import { followEvents } from "./event-stream.js";
import { resolveTyrPaths, writeFileAtomic } from "./scaffold.js";

export const DAEMON_REQUEST_VERSION = 1;

export type DaemonRequestType = "stop" | "ping";

export const DAEMON_REQUEST_TYPES: readonly DaemonRequestType[] = ["stop", "ping"];

export interface DaemonRequest {
    v: typeof DAEMON_REQUEST_VERSION;
    id: string;
    type: DaemonRequestType;
    /** ISO-8601 UTC time the request was written. */
    createdAt: string;
    /** Pid of the process that sent it (diagnostics only). */
    pid: number;
}

/** Event kind the daemon appends in answer to a ping; `data.requestId` is the ping's id. */
export const DAEMON_PONG_KIND = "daemon.pong";

/**
 * Requests older than this are dropped unanswered: whoever sent them has long
 * stopped waiting, and an ancient `stop` must not kill a daemon started later.
 */
export const DEFAULT_REQUEST_MAX_AGE_MS = 5 * 60 * 1000;

const REQUEST_FILE = /^(\d+)-([0-9a-f-]+)\.json$/i;

/** `.tyr/state/requests/`, under state/ so `.tyr/.gitignore` already covers it. */
export function daemonRequestsDir(root: string): string {
    return path.join(resolveTyrPaths(root).stateDir, "requests");
}

function requestFile(root: string, request: DaemonRequest): string {
    return path.join(daemonRequestsDir(root), `${Date.parse(request.createdAt)}-${request.id}.json`);
}

/**
 * Drop a request for the daemon. Returns the request as written, or null if
 * it could not be written. Never throws.
 */
export async function sendDaemonRequest(
    root: string,
    request: { type: DaemonRequestType },
): Promise<DaemonRequest | null> {
    if (!DAEMON_REQUEST_TYPES.includes(request.type)) return null;
    const full: DaemonRequest = {
        v: DAEMON_REQUEST_VERSION,
        id: randomUUID(),
        type: request.type,
        createdAt: new Date().toISOString(),
        pid: process.pid,
    };
    try {
        await fs.mkdir(daemonRequestsDir(root), { recursive: true });
        await writeFileAtomic(requestFile(root, full), `${JSON.stringify(full)}\n`);
        return full;
    } catch {
        return null;
    }
}

/** Withdraw a request the daemon has not consumed yet. True if it was still pending. */
export async function cancelDaemonRequest(root: string, request: DaemonRequest): Promise<boolean> {
    try {
        await fs.rm(requestFile(root, request));
        return true;
    } catch {
        return false;
    }
}

/** Remove every pending request (a starting daemon must not act on leftovers). Never throws. */
export async function clearDaemonRequests(root: string): Promise<void> {
    await fs.rm(daemonRequestsDir(root), { recursive: true, force: true }).catch(() => undefined);
}

function parseRequest(raw: string): DaemonRequest | null {
    try {
        const value: unknown = JSON.parse(raw);
        if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
        const { id, type, createdAt, pid } = value as Record<string, unknown>;
        if (typeof id !== "string" || id === "") return null;
        if (typeof type !== "string" || !DAEMON_REQUEST_TYPES.includes(type as DaemonRequestType)) return null;
        if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) return null;
        return {
            v: DAEMON_REQUEST_VERSION,
            id,
            type: type as DaemonRequestType,
            createdAt,
            pid: typeof pid === "number" ? pid : 0,
        };
    } catch {
        return null;
    }
}

export interface ReadDaemonRequestsOptions {
    /** Drop requests older than this. Default 5 minutes. */
    maxAgeMs?: number;
    /** Injectable clock for tests. */
    now?: () => number;
}

/**
 * Daemon side: consume every pending request, oldest first. Each returned
 * request has been deleted, so it is handed out exactly once. Malformed and
 * stale files are deleted and skipped. Never throws; no directory is [].
 */
export async function readDaemonRequests(
    root: string,
    options: ReadDaemonRequestsOptions = {},
): Promise<DaemonRequest[]> {
    const dir = daemonRequestsDir(root);
    let names: string[];
    try {
        names = await fs.readdir(dir);
    } catch {
        return [];
    }
    const now = (options.now ?? Date.now)();
    const maxAgeMs = options.maxAgeMs ?? DEFAULT_REQUEST_MAX_AGE_MS;

    const requests: DaemonRequest[] = [];
    // Temp files are dot-prefixed and do not match, so in-flight writes are never touched.
    for (const name of names.filter((entry) => REQUEST_FILE.test(entry)).sort()) {
        const file = path.join(dir, name);
        let raw: string;
        try {
            raw = await fs.readFile(file, "utf8");
            // Claim it: whoever deletes the file owns the request.
            await fs.rm(file);
        } catch {
            continue; // Consumed or cancelled meanwhile.
        }
        const request = parseRequest(raw);
        if (request === null) continue;
        if (now - Date.parse(request.createdAt) > maxAgeMs) continue;
        requests.push(request);
    }
    return requests;
}

export interface ServiceDaemonRequestsResult {
    /** A stop request was among them: the caller should shut down. */
    stop: boolean;
    handled: DaemonRequest[];
}

/**
 * Daemon side: consume pending requests and answer the ones that need an
 * answer (pings get a daemon.pong event). Stopping is left to the caller,
 * which owns shutdown. Never throws.
 */
export async function serviceDaemonRequests(
    root: string,
    options: ReadDaemonRequestsOptions & { pid?: number } = {},
): Promise<ServiceDaemonRequestsResult> {
    const handled = await readDaemonRequests(root, options);
    let stop = false;
    for (const request of handled) {
        if (request.type === "stop") {
            stop = true;
        } else if (request.type === "ping") {
            await appendEvent(root, {
                source: "tyr",
                kind: DAEMON_PONG_KIND,
                message: "Background process answered a ping",
                data: { requestId: request.id, pid: options.pid ?? process.pid },
            });
        }
    }
    return { stop, handled };
}

export interface PingDaemonOptions {
    /** Poll period for the pong follower; see FollowEventsOptions. */
    pollIntervalMs?: number;
    forcePolling?: boolean;
}

/**
 * Ask the daemon for a pong and wait for it. Resolves with the round-trip time
 * in ms, or null when no answer came within `timeoutMs` (no daemon, a hung
 * one, or the request could not be written). An unanswered request is
 * withdrawn so a daemon started later does not answer a ping nobody awaits.
 * It does not check the PID file first: callers that want a fast "not
 * running" use readDaemonStatus. Never throws.
 */
export async function pingDaemon(root: string, timeoutMs = 2000, options: PingDaemonOptions = {}): Promise<number | null> {
    // Pong ids seen before we know our request id (a fast daemon could answer
    // before sendDaemonRequest returns).
    const seen = new Set<string>();
    let wanted: string | null = null;
    let answered: (() => void) | null = null;
    const answer = new Promise<void>((resolve) => {
        answered = resolve;
    });

    // Follow first, then send: the pong cannot be appended before the request
    // exists, so it cannot slip past us.
    const follower = await followEvents(root, {
        kinds: [DAEMON_PONG_KIND],
        pollIntervalMs: options.pollIntervalMs ?? 50,
        forcePolling: options.forcePolling,
        onEvent: (event) => {
            const id = event.data?.requestId;
            if (typeof id !== "string") return;
            seen.add(id);
            if (id === wanted) answered?.();
        },
    });

    let timeout: NodeJS.Timeout | null = null;
    try {
        const started = performance.now();
        const request = await sendDaemonRequest(root, { type: "ping" });
        if (request === null) return null;
        wanted = request.id;
        if (seen.has(request.id)) return performance.now() - started;

        const outcome = await Promise.race([
            answer.then(() => "pong" as const),
            new Promise<"timeout">((resolve) => {
                timeout = setTimeout(() => resolve("timeout"), Math.max(0, timeoutMs));
            }),
        ]);
        if (outcome === "pong") return performance.now() - started;
        await cancelDaemonRequest(root, request);
        return null;
    } finally {
        if (timeout !== null) clearTimeout(timeout);
        follower.close();
        await follower.done;
    }
}
