// A short-lived, cross-process lock on `.tyr/` (`.tyr/state/tyr.lock`).
//
// `daemon.pid` stops two daemons from owning one project, but commands and
// the daemon still read-modify-write the same files (state.json above all).
// withTyrLock() serializes those critical sections. It is meant to wrap a few
// file writes, never a long-running job: a lock older than `staleMs` is
// assumed abandoned and broken.
//
// Acquisition is an exclusive create (`open(path, "wx")`), which is atomic on
// every platform and filesystem Node supports. The file records who holds it
// so a waiter can break a lock whose process died, and so a timeout can name
// the culprit.
//
// Nesting: a withTyrLock() call inside another one for the same project, in
// the same async call chain, runs straight through instead of deadlocking on
// itself. Concurrent (non-nested) callers in one process still serialize,
// first on an in-process queue and then on the file.
//
// This module must not import daemon.ts (daemon.ts imports it).

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { appendLog, resolveTyrPaths, toJsonDocument } from "./scaffold.js";

/* -------------------------------------------------------------------------
 * Process liveness
 * ---------------------------------------------------------------------- */

/**
 * Signal 0 checks existence without delivering anything. EPERM means the
 * process exists but belongs to someone else, which is still "alive" for the
 * purpose of not starting a second daemon. PID reuse after a crash can give a
 * false positive; `tyr stop` then clears it.
 */
export function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

/* -------------------------------------------------------------------------
 * Types
 * ---------------------------------------------------------------------- */

/** Contents of `.tyr/state/tyr.lock`. */
export interface LockInfo {
    pid: number;
    /** What holds it, for humans: e.g. "tyr init", "daemon". */
    owner: string;
    acquiredAt: string;
    /** Distinguishes two holders in one process that acquired in the same millisecond. */
    token?: string;
}

export interface TyrLockOptions {
    /** Give up waiting after this long. Default 10000ms. */
    timeoutMs?: number;
    /** A lock held longer than this is considered abandoned. Default 30000ms. */
    staleMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_MS = 30_000;
const MIN_BACKOFF_MS = 10;
const MAX_BACKOFF_MS = 100;

export class LockTimeoutError extends Error {
    readonly lockFile: string;
    /** The holder at the moment we gave up; null if the file was unreadable. */
    readonly holder: LockInfo | null;

    constructor(lockFile: string, holder: LockInfo | null) {
        const who = holder === null ? "unknown process" : `pid ${holder.pid}, \`${holder.owner}\``;
        super(
            `Another Tyr command is updating .tyr/ (${who}). ` +
                `Try again in a moment; if no Tyr command is running, delete ${lockFile}.`,
        );
        this.name = "LockTimeoutError";
        this.lockFile = lockFile;
        this.holder = holder;
    }
}

export function resolveLockFile(root: string): string {
    return path.join(resolveTyrPaths(root).stateDir, "tyr.lock");
}

/* -------------------------------------------------------------------------
 * In-process bookkeeping
 * ---------------------------------------------------------------------- */

/** Lock files held by the current async call chain (for re-entrancy). */
const heldInContext = new AsyncLocalStorage<ReadonlySet<string>>();

/** Tail of the in-process wait queue per lock file. */
const queues = new Map<string, Promise<void>>();

function keyOf(lockFile: string): string {
    return process.platform === "win32" ? lockFile.toLowerCase() : lockFile;
}

/* -------------------------------------------------------------------------
 * Public API
 * ---------------------------------------------------------------------- */

/**
 * Run `fn` while holding `.tyr/state/tyr.lock`. Throws LockTimeoutError if
 * another live holder keeps it past `timeoutMs`. Creates `.tyr/state/` if
 * needed. The lock is released when `fn` settles, whether or not it threw.
 */
export async function withTyrLock<T>(
    root: string,
    owner: string,
    fn: () => Promise<T>,
    options: TyrLockOptions = {},
): Promise<T> {
    const lockFile = resolveLockFile(root);
    const key = keyOf(lockFile);
    const held = heldInContext.getStore();
    if (held?.has(key)) {
        // Nested call from inside our own critical section.
        return fn();
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
    const deadline = Date.now() + timeoutMs;

    // Queue behind other callers in this process, so they take turns instead
    // of all polling the file.
    const previous = queues.get(key) ?? Promise.resolve();
    let leave!: () => void;
    const mine = new Promise<void>((resolve) => (leave = resolve));
    const tail = previous.then(() => mine);
    queues.set(key, tail);

    try {
        await raceDeadline(previous, deadline, lockFile);
        const info = await acquire(root, lockFile, owner, deadline, staleMs);
        try {
            const nextHeld = new Set(held ?? []);
            nextHeld.add(key);
            return await heldInContext.run(nextHeld, fn);
        } finally {
            await release(lockFile, info);
        }
    } finally {
        leave();
        if (queues.get(key) === tail) queues.delete(key);
    }
}

/** Current holder of the lock, or null when it is free or unreadable. */
export async function readLock(root: string): Promise<LockInfo | null> {
    return readLockFile(resolveLockFile(root));
}

/* -------------------------------------------------------------------------
 * Internals
 * ---------------------------------------------------------------------- */

/** Wait for `promise`, but throw LockTimeoutError once the deadline passes. */
async function raceDeadline(promise: Promise<void>, deadline: number, lockFile: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            readLockFile(lockFile).then(
                (holder) => reject(new LockTimeoutError(lockFile, holder)),
                () => reject(new LockTimeoutError(lockFile, null)),
            );
        }, Math.max(0, deadline - Date.now()));
    });
    try {
        await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

async function acquire(
    root: string,
    lockFile: string,
    owner: string,
    deadline: number,
    staleMs: number,
): Promise<LockInfo> {
    let backoff = MIN_BACKOFF_MS;
    let madeDir = false;
    for (;;) {
        const info: LockInfo = {
            pid: process.pid,
            owner,
            acquiredAt: new Date().toISOString(),
            token: randomBytes(6).toString("hex"),
        };
        const outcome = await tryCreate(lockFile, info);
        if (outcome === "acquired") return info;
        if (outcome === "no-dir" && !madeDir) {
            await fs.mkdir(path.dirname(lockFile), { recursive: true });
            madeDir = true;
            continue;
        }

        if (outcome === "exists" && (await breakIfStale(root, lockFile, staleMs))) {
            continue;
        }

        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            throw new LockTimeoutError(lockFile, await readLockFile(lockFile));
        }
        await delay(Math.min(backoff, remaining));
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
}

async function tryCreate(lockFile: string, info: LockInfo): Promise<"acquired" | "exists" | "busy" | "no-dir"> {
    let handle: fs.FileHandle;
    try {
        handle = await fs.open(lockFile, "wx");
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST") return "exists";
        if (code === "ENOENT") return "no-dir";
        // Windows: a just-deleted file lingers in a "delete pending" state
        // while another process still has it open, and creating over it fails
        // with EPERM. It clears within moments.
        if (process.platform === "win32" && (code === "EPERM" || code === "EACCES" || code === "EBUSY")) return "busy";
        throw error;
    }
    let failure: unknown = null;
    try {
        await handle.writeFile(toJsonDocument(info), "utf8");
    } catch (error) {
        failure = error;
    } finally {
        await handle.close().catch(() => undefined);
    }
    if (failure !== null) {
        await fs.rm(lockFile, { force: true }).catch(() => undefined);
        throw failure;
    }
    return "acquired";
}

async function readLockFile(lockFile: string): Promise<LockInfo | null> {
    try {
        return parseLock(await fs.readFile(lockFile, "utf8"));
    } catch {
        return null;
    }
}

function parseLock(raw: string): LockInfo | null {
    try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object") return null;
        const { pid, owner, acquiredAt, token } = parsed as Record<string, unknown>;
        if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
        return {
            pid,
            owner: typeof owner === "string" ? owner : "unknown",
            acquiredAt: typeof acquiredAt === "string" ? acquiredAt : "",
            ...(typeof token === "string" ? { token } : {}),
        };
    } catch {
        return null;
    }
}

function sameHolder(a: LockInfo, b: LockInfo): boolean {
    return a.pid === b.pid && a.acquiredAt === b.acquiredAt && a.token === b.token;
}

/**
 * Break the lock if its holder is dead or it has been held for longer than
 * `staleMs`. Returns true when the caller should retry right away.
 *
 * Two waiters can judge the same lock stale at once; a plain read-then-delete
 * would let the slower one delete the lock the faster one just created. So
 * the stale file is first *renamed* (atomic: only one waiter wins), and the
 * renamed contents are checked. If they turn out to be a fresh lock that
 * slipped in, it is put back with an exclusive link.
 */
async function breakIfStale(root: string, lockFile: string, staleMs: number): Promise<boolean> {
    let raw: string;
    let mtimeMs: number;
    try {
        [raw, { mtimeMs }] = await Promise.all([fs.readFile(lockFile, "utf8"), fs.stat(lockFile)]);
    } catch {
        // Vanished between the create attempt and now: just retry.
        return true;
    }
    const holder = parseLock(raw);
    const reason = staleReason(holder, mtimeMs, staleMs);
    if (reason === null) return false;

    const aside = `${lockFile}.stale.${process.pid}.${randomBytes(4).toString("hex")}`;
    try {
        await fs.rename(lockFile, aside);
    } catch {
        // Someone else broke or released it first.
        return true;
    }
    try {
        const movedRaw = await fs.readFile(aside, "utf8").catch(() => "");
        if (movedRaw !== raw) {
            // Not the file we judged stale: restore it unless a new one exists.
            await fs.link(aside, lockFile).catch(() => undefined);
            return true;
        }
    } finally {
        await fs.rm(aside, { force: true }).catch(() => undefined);
    }

    const who = holder === null ? "an unreadable lock" : `pid ${holder.pid} (\`${holder.owner}\`)`;
    await appendLog(root, "warn", `Broke stale .tyr lock held by ${who}: ${reason}`);
    return true;
}

function staleReason(holder: LockInfo | null, mtimeMs: number, staleMs: number): string | null {
    if (holder === null) {
        // Possibly a holder between create and write; give it the stale window.
        return Date.now() - mtimeMs > staleMs ? `unreadable for over ${staleMs}ms` : null;
    }
    if (!isProcessAlive(holder.pid)) return "its process is gone";
    const acquired = Date.parse(holder.acquiredAt);
    const age = Date.now() - (Number.isNaN(acquired) ? mtimeMs : acquired);
    return age > staleMs ? `held for ${age}ms (limit ${staleMs}ms)` : null;
}

/** Remove the lock only while it is still ours: it may have been broken as stale. */
async function release(lockFile: string, info: LockInfo): Promise<void> {
    const current = await readLockFile(lockFile);
    if (current === null || !sameHolder(current, info)) return;
    await fs.rm(lockFile, { force: true }).catch(() => undefined);
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
