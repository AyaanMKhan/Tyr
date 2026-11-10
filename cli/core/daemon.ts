// Tyr's background process: spawning, supervising and stopping it.
//
// Process model: a detached child of `node` running `cli/daemon-main.js`
// (a dedicated entry, so the daemon never goes through commander, the banner
// or the global-option hooks). The parent writes `.tyr/state/daemon.pid`,
// waits until the child reports itself running, then unrefs it and exits.
//
// Stopping is cooperative first: `tyr stop` drops a `daemon.stop` request
// file that the daemon polls for. That matters on Windows, where
// `process.kill(pid, "SIGTERM")` is a hard TerminateProcess and no signal
// handler ever runs, so a signal alone could never persist `status: "stopped"`.
// Signals (SIGINT/SIGTERM, and SIGBREAK on Windows) still shut down cleanly
// wherever the platform delivers them, and `stopDaemon()` falls back to a hard
// kill plus its own cleanup if the daemon does not exit in time.
//
// Other CLI -> daemon requests (`stop`, `ping`) go through the request files
// of daemon-requests.ts, serviced from the same poll timer; answers come back
// through the event journal (see event-stream.ts for why not a socket).
//
// Like scaffold.ts, the parent-side functions never print. The daemon side
// writes only to `.tyr/logs/` and `state.json`, since it has no terminal.

import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appendLog, readState, resolveTyrPaths, toJsonDocument, writeFileAtomic } from "./scaffold.js";
import { isProcessAlive } from "./lock.js";
import { markError, markRunning, markStopped } from "./state-store.js";
import { describeError, watchGit, type GitWatchEvent, type GitWatcher } from "./git-watch.js";
import { appendEvent, type TyrEventInput } from "./events.js";
import { watchFiles, type FileWatcher } from "./fs-watch.js";
import { createObserver, DEFAULT_OBSERVE_WINDOW_MS } from "./observe.js";
import { clearDaemonRequests, serviceDaemonRequests } from "./daemon-requests.js";
import { getLogLevel, LOG_LEVEL_ENV, rotateFileIfLarge } from "./log.js";

/* -------------------------------------------------------------------------
 * Paths and the PID file
 * ---------------------------------------------------------------------- */

/** Contents of `.tyr/state/daemon.pid`. JSON rather than a bare number so it can grow. */
export interface DaemonPidFile {
    pid: number;
    startedAt: string;
}

export interface DaemonPaths {
    /** `.tyr/state/daemon.pid`: present while a daemon owns the project. */
    pidFile: string;
    /** `.tyr/state/daemon.stop`: a graceful stop request the daemon polls for. */
    stopFile: string;
    /** `.tyr/logs/daemon.log`: the daemon's raw stdout/stderr (crash traces land here). */
    outputFile: string;
}

export function resolveDaemonPaths(root: string): DaemonPaths {
    const paths = resolveTyrPaths(root);
    return {
        // Under state/ and logs/, so `.tyr/.gitignore` already covers them.
        pidFile: path.join(paths.stateDir, "daemon.pid"),
        stopFile: path.join(paths.stateDir, "daemon.stop"),
        outputFile: path.join(paths.logsDir, "daemon.log"),
    };
}

/** Null when the file is missing, malformed, or names an impossible pid. */
export async function readPidFile(root: string): Promise<DaemonPidFile | null> {
    try {
        const raw = await fs.readFile(resolveDaemonPaths(root).pidFile, "utf8");
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object") return null;
        const { pid, startedAt } = parsed as Record<string, unknown>;
        if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
        return { pid, startedAt: typeof startedAt === "string" ? startedAt : "" };
    } catch {
        return null;
    }
}

async function writePidFile(root: string, contents: DaemonPidFile): Promise<void> {
    await writeFileAtomic(resolveDaemonPaths(root).pidFile, toJsonDocument(contents));
}

/**
 * Remove the PID file, but only while it still names `pid`: a daemon shutting
 * down late must not delete the file of a newer daemon that replaced it.
 */
async function removePidFileIfOwned(root: string, pid: number): Promise<void> {
    const current = await readPidFile(root);
    if (current === null || current.pid === pid) {
        await fs.rm(resolveDaemonPaths(root).pidFile, { force: true }).catch(() => undefined);
    }
}

// Lives in lock.ts (which must not import this module); re-exported so
// existing `isProcessAlive` imports from daemon.ts keep working.
export { isProcessAlive };

/* -------------------------------------------------------------------------
 * Status
 * ---------------------------------------------------------------------- */

export interface DaemonStatus {
    running: boolean;
    pid: number | null;
    startedAt: string | null;
    /** A PID file exists but its process is gone (crash, reboot, hard kill). */
    stale: boolean;
}

export async function readDaemonStatus(root: string): Promise<DaemonStatus> {
    const pidFile = await readPidFile(root);
    if (pidFile === null) {
        // An unreadable file left by a crash mid-write is stale too.
        const exists = await fs.access(resolveDaemonPaths(root).pidFile).then(() => true, () => false);
        return { running: false, pid: null, startedAt: null, stale: exists };
    }
    const running = isProcessAlive(pidFile.pid);
    return { running, pid: pidFile.pid, startedAt: pidFile.startedAt || null, stale: !running };
}

/* -------------------------------------------------------------------------
 * Starting
 * ---------------------------------------------------------------------- */

export interface StartDaemonResult {
    pid: number;
    alreadyRunning: boolean;
    /** A stale PID file from a dead daemon was found and replaced. */
    replacedStale: boolean;
    /** False when the child was spawned but did not confirm within the timeout. */
    ready: boolean;
}

export interface StartDaemonOptions {
    /** How long to wait for the child to mark itself running. Default 5000ms. */
    readyTimeoutMs?: number;
}

/** Compiled next to this module's parent: dist/cli/daemon-main.js (or .test-build/...). */
function daemonEntry(): string {
    return fileURLToPath(new URL("../daemon-main.js", import.meta.url));
}

/**
 * Start the daemon for an initialized project, or report the one already
 * running. Throws when the child cannot be spawned or dies during startup.
 */
export async function startDaemon(root: string, options: StartDaemonOptions = {}): Promise<StartDaemonResult> {
    const absRoot = resolveTyrPaths(root).root;
    const daemonPaths = resolveDaemonPaths(absRoot);
    await fs.mkdir(path.dirname(daemonPaths.pidFile), { recursive: true });
    await fs.mkdir(path.dirname(daemonPaths.outputFile), { recursive: true });

    // Claim the PID file with an exclusive create so two concurrent starts
    // cannot both spawn. It holds *our* pid until the child exists, which
    // keeps it "alive" to any competing start in the meantime.
    let replacedStale = false;
    for (let attempt = 0; ; attempt++) {
        const claimed = await claimPidFile(daemonPaths.pidFile);
        if (claimed) break;
        const status = await readDaemonStatus(absRoot);
        if (status.running && status.pid !== null) {
            return { pid: status.pid, alreadyRunning: true, replacedStale: false, ready: true };
        }
        if (attempt > 0) {
            throw new Error(`Could not claim ${daemonPaths.pidFile}`);
        }
        await appendLog(absRoot, "warn", `Removing stale daemon PID file (pid ${status.pid ?? "unknown"})`);
        await fs.rm(daemonPaths.pidFile, { force: true });
        replacedStale = true;
    }

    // A leftover stop request would make the new daemon exit immediately.
    await fs.rm(daemonPaths.stopFile, { force: true });
    await clearDaemonRequests(absRoot);

    let pid: number;
    try {
        pid = await spawnDetached(absRoot, daemonPaths.outputFile);
        await writePidFile(absRoot, { pid, startedAt: new Date().toISOString() });
    } catch (error) {
        await fs.rm(daemonPaths.pidFile, { force: true }).catch(() => undefined);
        throw error;
    }

    const ready = await waitForReady(absRoot, pid, options.readyTimeoutMs ?? 5000);
    if (ready === "exited") {
        await removePidFileIfOwned(absRoot, pid);
        throw new Error(`Background process exited during startup; see ${daemonPaths.outputFile}`);
    }
    return { pid, alreadyRunning: false, replacedStale, ready: ready === "ready" };
}

async function claimPidFile(pidFile: string): Promise<boolean> {
    try {
        const handle = await fs.open(pidFile, "wx");
        try {
            await handle.writeFile(toJsonDocument({ pid: process.pid, startedAt: new Date().toISOString() }));
        } finally {
            await handle.close();
        }
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
    }
}

/**
 * `detached` puts the child in its own process group (POSIX) or console
 * (Windows) so it outlives the terminal; `windowsHide` stops Windows from
 * flashing a console window for it. stdout/stderr go to a log file because
 * an inherited pipe would hold the parent open and die with the terminal.
 *
 * The child writes that file through raw descriptors, so it cannot be
 * rotated while the daemon runs; it is rotated here, just before opening.
 * The resolved log level is passed down through TYR_LOG_LEVEL so the daemon
 * honours `--log-level` too.
 */
async function spawnDetached(root: string, outputFile: string): Promise<number> {
    await rotateFileIfLarge(outputFile);
    const out = fsSync.openSync(outputFile, "a");
    return new Promise<number>((resolve, reject) => {
        const child = spawn(process.execPath, [daemonEntry(), root], {
            cwd: root,
            detached: true,
            windowsHide: true,
            stdio: ["ignore", out, out],
            env: { ...process.env, [LOG_LEVEL_ENV]: getLogLevel() },
        });
        // The child holds its own copy of the descriptor.
        fsSync.closeSync(out);
        child.once("error", reject);
        child.once("spawn", () => {
            child.unref();
            if (child.pid === undefined) {
                reject(new Error("Background process started without a pid"));
                return;
            }
            resolve(child.pid);
        });
    });
}

/** Poll state.json until the daemon claims it, the child dies, or time runs out. */
async function waitForReady(root: string, pid: number, timeoutMs: number): Promise<"ready" | "exited" | "timeout"> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const state = await readState(root);
        if (state?.status === "running" && state.pid === pid) return "ready";
        if (!isProcessAlive(pid)) return "exited";
        await delay(50);
    }
    return "timeout";
}

/* -------------------------------------------------------------------------
 * Stopping
 * ---------------------------------------------------------------------- */

export interface StopDaemonResult {
    /** Pid that was stopped; null when nothing was running. */
    pid: number | null;
    /** True when the daemon exited by itself; false when it had to be killed. */
    graceful: boolean;
    /** A stale PID file was found (and removed) instead of a live daemon. */
    staleCleared: boolean;
}

export async function stopDaemon(root: string, options: { timeoutMs?: number } = {}): Promise<StopDaemonResult> {
    const absRoot = resolveTyrPaths(root).root;
    const daemonPaths = resolveDaemonPaths(absRoot);
    const status = await readDaemonStatus(absRoot);

    if (!status.running || status.pid === null) {
        if (status.stale) {
            await fs.rm(daemonPaths.pidFile, { force: true });
            await markStoppedIfRunning(absRoot, "Cleared stale daemon PID file");
        }
        return { pid: null, graceful: true, staleCleared: status.stale };
    }

    const pid = status.pid;
    await fs.writeFile(daemonPaths.stopFile, `${new Date().toISOString()}\n`, "utf8");
    let graceful = await waitForExit(pid, options.timeoutMs ?? 5000);

    if (!graceful) {
        try {
            process.kill(pid, "SIGTERM");
        } catch {
            // Already gone between the check and the kill.
        }
        await waitForExit(pid, 2000);
        // A hard kill skipped the daemon's own cleanup, so do it here.
        await removePidFileIfOwned(absRoot, pid);
        await markStoppedIfRunning(absRoot, `Background process (pid ${pid}) did not stop in time and was killed`, pid);
    }

    await fs.rm(daemonPaths.stopFile, { force: true }).catch(() => undefined);
    return { pid, graceful, staleCleared: false };
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!isProcessAlive(pid)) return true;
        await delay(50);
    }
    return !isProcessAlive(pid);
}

/**
 * Cleanup for a daemon that died without saying so (crash or hard kill).
 * With `pid`, a running state that belongs to some other daemon is left alone.
 */
async function markStoppedIfRunning(root: string, message: string, pid?: number): Promise<void> {
    await markStopped(root, { onlyIfRunning: true, ownerPid: pid });
    await appendLog(root, "warn", message);
}

/* -------------------------------------------------------------------------
 * The daemon process itself (entered from cli/daemon-main.ts)
 * ---------------------------------------------------------------------- */

/** How often the daemon checks for a stop request. Cheap: one stat. */
const STOP_POLL_MS = 500;

/**
 * Polling-fallback intervals, passed to the watchers explicitly (they are
 * their defaults) because the observer's timing and the fallback warning
 * both depend on them.
 */
const GIT_POLL_INTERVAL_MS = 2000;
const FS_POLL_INTERVAL_MS = 5000;

/**
 * Body of the background process. Marks state.json running, follows git
 * events and project file changes into tyr.log and the event journal, and
 * stays alive until asked to stop.
 *
 * Order matters for responsiveness: the stop/request poll starts right after
 * the process claims state.json, *before* the watchers, whose baseline scans
 * can take seconds on a big repository. `tyr stop` during startup is then
 * honoured within one poll instead of waiting for the SIGTERM fallback.
 * finish() closes whichever watchers exist by then, and a watcher that
 * finishes starting after finish() ran is closed on arrival.
 *
 * Both watchers feed one observer (observe.ts), which journals git events at
 * once and attributes the working-tree writes of a checkout, merge, rebase,
 * pull or stash to the git event that caused them instead of reporting them
 * as hand edits.
 */
export async function runDaemon(root: string): Promise<void> {
    const absRoot = resolveTyrPaths(root).root;
    const daemonPaths = resolveDaemonPaths(absRoot);
    let watcher: GitWatcher | null = null;
    let fileWatcher: FileWatcher | null = null;
    let timer: NodeJS.Timeout | null = null;
    let exiting = false;

    // Appends still in flight; finish() waits for them so nothing observed
    // before the stop lands after `daemon.stopped` (or is lost to exit()).
    const pending = new Set<Promise<unknown>>();
    const track = (promise: Promise<unknown>): void => {
        pending.add(promise);
        void promise.finally(() => pending.delete(promise));
    };
    const journal = (event: TyrEventInput): void => track(appendEvent(absRoot, event));

    const observer = createObserver({
        emit: (event) => {
            journal(event);
            if (event.source === "fs") {
                // Debug only: an active editing session would otherwise flood tyr.log.
                void appendLog(absRoot, "debug", `fs: ${event.message ?? "files changed"}`);
            }
        },
    });

    /** One daemon.warning per watcher fallback; also adapts the observer's timing. */
    const onFallback = (which: "git" | "fs", reason: string): void => {
        if (exiting) return;
        if (which === "git") {
            // No more activity hints, and events arrive up to a poll late.
            observer.configure({ idleHoldMs: GIT_POLL_INTERVAL_MS + 1000 });
        } else {
            // Batches now arrive up to a rescan interval after the change.
            observer.configure({ windowMs: Math.max(DEFAULT_OBSERVE_WINDOW_MS, FS_POLL_INTERVAL_MS + 1000) });
        }
        const what = which === "git" ? "Git watcher" : "File watcher";
        const every = which === "git" ? GIT_POLL_INTERVAL_MS : FS_POLL_INTERVAL_MS;
        const message = `${what} fell back to polling every ${every / 1000}s (${reason}); changes will show up later`;
        void appendLog(absRoot, "warn", message);
        journal({ source: "tyr", kind: "daemon.warning", message, data: { watcher: which, mode: "poll", reason } });
    };

    const finish = async (status: "stopped" | "error", message: string, code: number): Promise<void> => {
        if (exiting) return;
        exiting = true;
        if (timer !== null) clearInterval(timer);
        watcher?.close();
        fileWatcher?.close();
        // Held batches go out now rather than vanish with the process.
        observer.close();
        await Promise.allSettled([...pending]);
        try {
            // Guarded on our pid: never overwrite a newer daemon's "running".
            const guard = { ownerPid: process.pid };
            await (status === "error" ? markError(absRoot, guard) : markStopped(absRoot, guard));
        } catch {
            // Still remove the PID file and exit; a stuck daemon is worse.
        }
        await appendLog(absRoot, status === "error" ? "error" : "info", message);
        await appendEvent(absRoot, {
            source: "tyr",
            kind: status === "error" ? "daemon.crashed" : "daemon.stopped",
            message,
            data: { pid: process.pid },
        });
        await removePidFileIfOwned(absRoot, process.pid);
        await fs.rm(daemonPaths.stopFile, { force: true }).catch(() => undefined);
        process.exit(code);
    };

    const onFatal = (error: unknown): void => {
        const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
        // Also to stderr, which is redirected into daemon.log.
        process.stderr.write(`${detail}\n`);
        void finish("error", `Background process crashed: ${detail}`, 1);
    };
    process.on("uncaughtException", onFatal);
    process.on("unhandledRejection", onFatal);

    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
    if (process.platform === "win32") signals.push("SIGBREAK");
    for (const signal of signals) {
        process.on(signal, () => void finish("stopped", `Background process stopped (${signal})`, 0));
    }

    // Taken before we report ready: anything written after `tyr start`
    // returns is newer, and watchFiles reports it even if its baseline scan
    // (which runs well after this) would otherwise swallow it.
    const observingSince = Date.now();
    // Also the readiness signal: startDaemon() polls for status "running" with our pid.
    const state = await markRunning(absRoot, process.pid);
    if (state === null) {
        await appendLog(absRoot, "error", "Background process cannot start: .tyr/state/state.json is missing or unreadable");
        await removePidFileIfOwned(absRoot, process.pid);
        process.exit(1);
    }

    // Before the watchers (see above). Doubles as the keep-alive, so the
    // process stays up even with no watcher holding the loop open.
    timer = setInterval(() => {
        fs.access(daemonPaths.stopFile).then(
            () => void finish("stopped", "Background process stopped (tyr stop)", 0),
            () => undefined,
        );
        // Request files (ping, stop); pings are answered with a daemon.pong event.
        void serviceDaemonRequests(absRoot).then((requests) => {
            if (requests.stop) void finish("stopped", "Background process stopped (stop request)", 0);
        });
    }, STOP_POLL_MS);

    // Both baseline scans run concurrently. Neither watcher rejects, but a
    // bug there must cost a warning, not the daemon.
    const startFailed = (which: "git" | "fs") => (error: unknown): null => {
        onFallback(which, `could not start: ${describeError(error)}`);
        return null;
    };
    const [git, files] = await Promise.all([
        watchGit(absRoot, {
            pollIntervalMs: GIT_POLL_INTERVAL_MS,
            onEvent: (event) => {
                void appendLog(absRoot, "info", `git: ${describeGitEvent(event)}`);
                observer.gitEvent(event);
            },
            onActivity: () => observer.gitActivity(),
            onFallback: (reason) => onFallback("git", reason),
        }).catch(startFailed("git")),
        watchFiles(absRoot, {
            pollIntervalMs: FS_POLL_INTERVAL_MS,
            since: observingSince,
            onBatch: (batch) => observer.fsBatch(batch),
            onFallback: (reason) => onFallback("fs", reason),
        }).catch(startFailed("fs")),
    ]);
    if (exiting) {
        // finish() ran during startup and closed nothing it could not see.
        git?.close();
        files?.close();
        return;
    }
    watcher = git;
    fileWatcher = files;

    journal({
        source: "tyr",
        kind: "daemon.started",
        message: `Background process started (pid ${process.pid})`,
        data: { pid: process.pid, runCount: state.runCount, gitWatch: watcher?.mode ?? null, fsWatch: fileWatcher?.mode ?? null },
    });
    await appendLog(
        absRoot,
        "info",
        `Background process started (pid ${process.pid}); ` +
            (watcher ? `watching git (${watcher.mode})` : "not a git repository") +
            (fileWatcher ? `, watching files (${fileWatcher.mode})` : ", not watching files"),
    );
}

/** One log line per git event, e.g. "HEAD moved to 1a2b3c4 on main". */
export function describeGitEvent(event: GitWatchEvent): string {
    switch (event.kind) {
        case "head": {
            const where = event.current.branch ?? "detached HEAD";
            const commit = event.current.commit?.slice(0, 7) ?? "(no commits)";
            if (event.branchChanged) return `switched to ${where} at ${commit}`;
            return `HEAD moved to ${commit} on ${where}`;
        }
        case "index":
            return `index changed (${event.staged.length} staged)`;
        case "refs":
            return `refs changed: ${event.changes.map((change) => change.ref).join(", ")}`;
        case "merge-state": {
            const active = Object.entries(event.current)
                .filter(([, on]) => on)
                .map(([name]) => name);
            return `operation state: ${active.length ? active.join(", ") : "idle"}`;
        }
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
