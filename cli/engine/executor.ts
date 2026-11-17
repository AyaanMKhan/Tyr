// Execution engine: run one configured check command and describe what happened.
//
// Commands come from tyr.json as shell strings ("npm run test"), so they run
// through the platform shell with the project root as cwd. Output is captured
// as a bounded tail per stream, and the outcome is classified into the
// CheckOutcome vocabulary of model.ts:
//
// - passed:    exit code 0
// - failed:    any other exit code
// - timeout:   still running after `timeoutMs`; the whole process tree is killed
// - cancelled: the caller's AbortSignal fired; the whole process tree is killed
// - error:     the command could not run at all. That covers spawn failures
//              (missing shell, missing cwd) *and* the shell's own "could not
//              run this" codes: 127 (command not found) and 126 (found but not
//              executable) on POSIX, 9009 ("is not recognized") on Windows.
//              A missing tool is a configuration problem, not a failing
//              check. `exitCode` still records the shell's code.
//
// Killing a tree: on POSIX the shell is spawned `detached`, which makes it a
// process-group leader, so `kill(-pid)` reaches the shell, the tool it ran and
// anything that tool started (SIGTERM, then SIGKILL after a grace period). A
// process that calls setsid() itself escapes; nothing short of cgroups stops
// that. On Windows, `taskkill /T /F` walks the tree. Stragglers left behind by
// a command that exited normally (a forgotten dev server) are reaped the same
// way, so a check never leaks processes into the daemon's lifetime.
//
// Like cli/core, nothing here prints and nothing throws: runCheck always
// resolves to a CheckRun. The clock, run id and HEAD lookup are injectable.

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as path from "node:path";

import type { TyrEventInput } from "../core/events.js";
import { getHeadCommit } from "../core/git.js";
import { readConfig } from "../core/scaffold.js";
import { resolveSettings, type ResolveSettingsOptions } from "../core/settings.js";
import {
    CHECK_FAILED_KIND,
    CHECK_KINDS,
    CHECK_PASSED_KIND,
    CHECK_STARTED_KIND,
    DEFAULT_CHECK_TIMEOUT_MS,
    DEFAULT_OUTPUT_TAIL_BYTES,
    type CheckKind,
    type CheckOutcome,
    type CheckRun,
    type CheckTrigger,
} from "./model.js";

/* -------------------------------------------------------------------------
 * Options
 * ---------------------------------------------------------------------- */

/** Time between SIGTERM and SIGKILL when killing a tree. */
export const DEFAULT_KILL_GRACE_MS = 5000;

/**
 * After the shell exits, how long to wait for its output pipes to close. A
 * background process that inherited them would otherwise hold the run open
 * forever.
 */
const EXIT_DRAIN_MS = 2000;

/** After the final SIGKILL, give up waiting for pipes and resolve anyway. */
const POST_KILL_DEADLINE_MS = 2000;

/** What runCheck knows once the command is running (for check.started). */
export interface CheckStart {
    id: string;
    kind: CheckKind;
    command: string;
    cwd: string;
    trigger: CheckTrigger;
    startedAt: string;
    headCommit: string | null;
}

export interface RunCheckOptions {
    /** Kill the run after this long. Default DEFAULT_CHECK_TIMEOUT_MS. */
    timeoutMs?: number;
    /** Bytes kept from the end of each stream. Default DEFAULT_OUTPUT_TAIL_BYTES. */
    outputTailBytes?: number;
    /** Why the run happened. Default `{ reason: "manual" }`. */
    trigger?: CheckTrigger;
    /** Aborting kills the tree; the outcome is "cancelled". */
    signal?: AbortSignal;
    /**
     * Extra environment, applied last over process.env and Tyr's defaults
     * (CI=1, FORCE_COLOR=0). An `undefined` value removes the variable.
     */
    env?: NodeJS.ProcessEnv;
    /** SIGTERM → SIGKILL grace period. Default DEFAULT_KILL_GRACE_MS. */
    killGraceMs?: number;
    /** Run id. Default a fresh UUID. */
    id?: string;
    /** Clock for timestamps and duration. Default `() => new Date()`. */
    now?: () => Date;
    /** HEAD lookup. Default getHeadCommit's hash, null outside a repo. */
    headCommit?: (root: string) => Promise<string | null>;
    /** Called once the process has been spawned, e.g. to journal check.started. */
    onStart?: (start: CheckStart) => void;
    /** Defaults to process.platform; selects the tree-kill strategy. */
    platform?: NodeJS.Platform;
}

/* -------------------------------------------------------------------------
 * Bounded output capture
 * ---------------------------------------------------------------------- */

/**
 * Keeps the last `limit` bytes written to it. Chunks are stored as-is and
 * dropped from the front once over the limit, so memory stays bounded by
 * roughly one chunk over `limit` no matter how much a command prints.
 */
export class TailBuffer {
    private chunks: Buffer[] = [];
    private size = 0;
    private dropped = false;

    constructor(private readonly limit: number) {}

    push(chunk: Buffer): void {
        if (chunk.length === 0) return;
        if (this.limit <= 0) {
            this.dropped = true;
            return;
        }
        if (chunk.length >= this.limit) {
            // One chunk covers the whole window: everything before it goes.
            this.dropped = this.dropped || this.size > 0 || chunk.length > this.limit;
            this.chunks = [chunk.subarray(chunk.length - this.limit)];
            this.size = this.limit;
            return;
        }
        this.chunks.push(chunk);
        this.size += chunk.length;
        while (this.size > this.limit) {
            const excess = this.size - this.limit;
            const head = this.chunks[0];
            this.dropped = true;
            if (head.length <= excess) {
                this.chunks.shift();
                this.size -= head.length;
            } else {
                this.chunks[0] = head.subarray(excess);
                this.size -= excess;
            }
        }
    }

    get truncated(): boolean {
        return this.dropped;
    }

    /**
     * The kept bytes as UTF-8. When the front was cut, any continuation bytes
     * left over from a split character are skipped so the text starts cleanly.
     */
    text(): string {
        let bytes = Buffer.concat(this.chunks, this.size);
        if (this.dropped) {
            let start = 0;
            // At most 3 continuation bytes (10xxxxxx) can follow a lead byte.
            while (start < bytes.length && start < 3 && (bytes[start] & 0xc0) === 0x80) start++;
            bytes = bytes.subarray(start);
        }
        return bytes.toString("utf8");
    }
}

/* -------------------------------------------------------------------------
 * Process-tree killing
 * ---------------------------------------------------------------------- */

function killTree(child: ChildProcess, platform: NodeJS.Platform, signal: NodeJS.Signals): void {
    const pid = child.pid;
    if (pid === undefined) return;
    if (platform === "win32") {
        // taskkill has no graceful tree mode worth waiting for; /F is the only reliable one.
        try {
            const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
                stdio: "ignore",
                windowsHide: true,
            });
            killer.on("error", () => undefined);
        } catch {
            // Fall through to killing the shell alone.
        }
        try {
            child.kill(signal);
        } catch {
            // Already gone.
        }
        return;
    }
    try {
        // Negative pid: the whole process group the detached shell leads.
        process.kill(-pid, signal);
    } catch {
        // ESRCH: nothing left in the group.
    }
}

/** True while any process in the group is alive (POSIX only). */
function groupAlive(pid: number): boolean {
    try {
        process.kill(-pid, 0);
        return true;
    } catch (error) {
        // EPERM means something exists that we may not signal; treat as alive.
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

/* -------------------------------------------------------------------------
 * Running a check
 * ---------------------------------------------------------------------- */

/** Shell exit codes that mean "the command itself could not be run". */
function notRunnableReason(code: number, platform: NodeJS.Platform): string | null {
    if (platform === "win32") {
        return code === 9009 ? "command not found (exit 9009)" : null;
    }
    if (code === 127) return "command not found (exit 127)";
    if (code === 126) return "command not executable (exit 126)";
    return null;
}

function buildEnv(overrides: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, CI: "1", FORCE_COLOR: "0" };
    // NO_COLOR alongside FORCE_COLOR makes every Node child print a warning.
    delete env.NO_COLOR;
    for (const [key, value] of Object.entries(overrides ?? {})) {
        if (value === undefined) delete env[key];
        else env[key] = value;
    }
    return env;
}

async function defaultHeadCommit(root: string): Promise<string | null> {
    return (await getHeadCommit(root))?.hash ?? null;
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        const code = (error as NodeJS.ErrnoException).code;
        return code !== undefined && !error.message.includes(code) ? `${error.message} (${code})` : error.message;
    }
    return String(error);
}

interface RawResult {
    outcome: CheckOutcome;
    exitCode: number | null;
    signal: string | null;
    error?: string;
}

/**
 * Run `command` in `root` and report how it went. Never throws and never
 * rejects: every failure, including a broken injected dependency, comes back
 * as a CheckRun.
 */
export async function runCheck(
    root: string,
    kind: CheckKind,
    command: string,
    opts: RunCheckOptions = {},
): Promise<CheckRun> {
    const now = opts.now ?? (() => new Date());
    const platform = opts.platform ?? process.platform;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
    const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    const tailBytes = opts.outputTailBytes ?? DEFAULT_OUTPUT_TAIL_BYTES;
    const trigger = opts.trigger ?? { reason: "manual" };
    const id = opts.id ?? randomUUID();
    const cwd = path.resolve(root);

    const started = now();
    const headLookup = (opts.headCommit ?? defaultHeadCommit)(cwd).catch(() => null);
    const stdout = new TailBuffer(tailBytes);
    const stderr = new TailBuffer(tailBytes);

    let raw: RawResult;
    if (command.trim() === "") {
        raw = { outcome: "error", exitCode: null, signal: null, error: "empty command" };
    } else if (opts.signal?.aborted) {
        raw = { outcome: "cancelled", exitCode: null, signal: null };
    } else {
        raw = await execute({
            command,
            cwd,
            env: buildEnv(opts.env),
            platform,
            timeoutMs,
            killGraceMs,
            signal: opts.signal,
            stdout,
            stderr,
            onSpawn: opts.onStart === undefined
                ? undefined
                : async () => {
                      const headCommit = await headLookup;
                      try {
                          opts.onStart?.({
                              id,
                              kind,
                              command,
                              cwd,
                              trigger,
                              startedAt: started.toISOString(),
                              headCommit,
                          });
                      } catch {
                          // A throwing listener must not break the run.
                      }
                  },
        });
    }

    const finished = now();
    const run: CheckRun = {
        id,
        kind,
        command,
        cwd,
        trigger,
        startedAt: started.toISOString(),
        finishedAt: finished.toISOString(),
        durationMs: Math.max(0, finished.getTime() - started.getTime()),
        outcome: raw.outcome,
        exitCode: raw.exitCode,
        signal: raw.signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        outputTruncated: stdout.truncated || stderr.truncated,
        headCommit: await headLookup,
    };
    if (raw.error !== undefined) run.error = raw.error;
    return run;
}

interface ExecuteArgs {
    command: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
    timeoutMs: number;
    killGraceMs: number;
    signal: AbortSignal | undefined;
    stdout: TailBuffer;
    stderr: TailBuffer;
    onSpawn: (() => void) | undefined;
}

function execute(args: ExecuteArgs): Promise<RawResult> {
    return new Promise((resolve) => {
        const { platform } = args;
        let child: ChildProcess;
        try {
            child = spawn(args.command, {
                cwd: args.cwd,
                env: args.env,
                shell: true,
                // POSIX: own process group, so the tree can be killed as one.
                // Windows: detached would open a new console window.
                detached: platform !== "win32",
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
            });
        } catch (error) {
            resolve({ outcome: "error", exitCode: null, signal: null, error: errorMessage(error) });
            return;
        }

        /** Set once we decide to kill: the outcome the kill stands for. */
        let killedFor: "timeout" | "cancelled" | null = null;
        let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
        let spawnError: Error | null = null;
        let settled = false;
        const timers: NodeJS.Timeout[] = [];
        const later = (ms: number, fn: () => void): void => {
            const timer = setTimeout(fn, ms);
            timers.push(timer);
        };

        const onAbort = (): void => startKill("cancelled");

        function startKill(reason: "timeout" | "cancelled"): void {
            if (killedFor !== null || settled) return;
            killedFor = reason;
            killTree(child, platform, "SIGTERM");
            // Windows' taskkill is already forceful; POSIX gets a grace period.
            const killTimer = setTimeout(() => {
                killTree(child, platform, "SIGKILL");
                // Something outside the group may still hold the pipes.
                const deadline = setTimeout(() => finish(), POST_KILL_DEADLINE_MS);
                deadline.unref();
                timers.push(deadline);
            }, args.killGraceMs);
            // Deliberately not cleared by finish(): a member of the group that
            // ignored SIGTERM must still get SIGKILL after the shell is gone.
            killTimer.unref();
        }

        function finish(): void {
            if (settled) return;
            settled = true;
            for (const timer of timers) clearTimeout(timer);
            args.signal?.removeEventListener("abort", onAbort);
            child.stdout?.destroy();
            child.stderr?.destroy();

            // Reap stragglers a normally-exiting command left in its group.
            if (killedFor === null && platform !== "win32" && child.pid !== undefined && groupAlive(child.pid)) {
                killTree(child, platform, "SIGTERM");
                const reap = setTimeout(() => killTree(child, platform, "SIGKILL"), args.killGraceMs);
                reap.unref();
            }

            if (spawnError !== null && exit === null) {
                resolve({ outcome: "error", exitCode: null, signal: null, error: errorMessage(spawnError) });
                return;
            }
            const code = exit?.code ?? null;
            const signal = exit?.signal ?? null;
            if (killedFor !== null) {
                resolve({ outcome: killedFor, exitCode: code, signal });
                return;
            }
            if (code === 0) {
                resolve({ outcome: "passed", exitCode: 0, signal });
                return;
            }
            if (code !== null) {
                const reason = notRunnableReason(code, platform);
                resolve(reason === null
                    ? { outcome: "failed", exitCode: code, signal }
                    : { outcome: "error", exitCode: code, signal, error: reason });
                return;
            }
            // Killed by a signal nobody here sent (OOM killer, a user's kill).
            resolve({ outcome: "failed", exitCode: null, signal });
        }

        child.stdout?.on("data", (chunk: Buffer) => args.stdout.push(chunk));
        child.stderr?.on("data", (chunk: Buffer) => args.stderr.push(chunk));
        child.stdout?.on("error", () => undefined);
        child.stderr?.on("error", () => undefined);

        child.on("error", (error) => {
            spawnError = error;
            // No 'close' follows a failed spawn.
            if (child.pid === undefined) finish();
        });
        child.on("exit", (code, signal) => {
            exit = { code, signal };
            // Pipes held open by a background grandchild must not hang the run.
            later(EXIT_DRAIN_MS, () => finish());
        });
        child.on("close", () => finish());

        if (child.pid !== undefined) {
            later(args.timeoutMs, () => startKill("timeout"));
            args.signal?.addEventListener("abort", onAbort, { once: true });
            // The signal may have fired between the caller's check and here.
            if (args.signal?.aborted) onAbort();
            args.onSpawn?.();
        }
    });
}

/* -------------------------------------------------------------------------
 * Serialization: one run per (root, kind) at a time
 * ---------------------------------------------------------------------- */

const inFlight = new Map<string, Promise<CheckRun>>();

/**
 * Like runCheck, but a run of the same kind in the same root waits for the
 * previous one to finish first, so two runs of one check never overlap.
 * Different kinds still run concurrently.
 */
export function runCheckSerialized(
    root: string,
    kind: CheckKind,
    command: string,
    opts: RunCheckOptions = {},
): Promise<CheckRun> {
    const key = `${path.resolve(root)}\0${kind}`;
    const previous = inFlight.get(key) ?? Promise.resolve(null);
    const next = previous.then(() => runCheck(root, kind, command, opts));
    inFlight.set(key, next);
    void next.then(() => {
        if (inFlight.get(key) === next) inFlight.delete(key);
    });
    return next;
}

/* -------------------------------------------------------------------------
 * Configured commands
 * ---------------------------------------------------------------------- */

/**
 * The check commands to run for `root`: every command detected in tyr.json
 * whose `checks.<kind>` setting is on. Missing or invalid tyr.json yields {}.
 * `settings` is passed to resolveSettings (tests use it to isolate env and
 * the global config); `root` is always the one given here.
 */
export async function loadCheckCommands(
    root: string,
    settings: Omit<ResolveSettingsOptions, "root"> = {},
): Promise<Partial<Record<CheckKind, string>>> {
    try {
        const [config, resolved] = await Promise.all([
            readConfig(root),
            resolveSettings({ ...settings, root }),
        ]);
        if (config === null) return {};
        const commands: Partial<Record<CheckKind, string>> = {};
        for (const kind of CHECK_KINDS) {
            const command = config.commands[kind]?.command;
            if (typeof command !== "string" || command.trim() === "") continue;
            if (resolved.settings.checks[kind] !== true) continue;
            commands[kind] = command;
        }
        return commands;
    } catch {
        return {};
    }
}

/* -------------------------------------------------------------------------
 * Journal events
 * ---------------------------------------------------------------------- */

/** "850ms", "4.2s", "2m 5s". */
export function formatDuration(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const totalSeconds = Math.round(ms / 1000);
    return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

/** One-line summary of a finished run, e.g. "test passed in 4.2s". */
export function describeCheckRun(run: CheckRun): string {
    switch (run.outcome) {
        case "passed":
            return `${run.kind} passed in ${formatDuration(run.durationMs)}`;
        case "failed":
            return run.exitCode !== null
                ? `${run.kind} failed (exit ${run.exitCode})`
                : `${run.kind} failed (${run.signal ?? "killed"})`;
        case "timeout":
            return `${run.kind} timed out after ${formatDuration(run.durationMs)}`;
        case "cancelled":
            return `${run.kind} cancelled`;
        case "error":
            return `${run.kind} could not run${run.error ? `: ${run.error}` : ""}`;
    }
}

/**
 * Journal event for a finished run. Only "passed" maps to check.passed; every
 * other outcome (failed, timeout, error, cancelled) is check.failed, and
 * `data.run.outcome` says which.
 */
export function checkRunToEvent(run: CheckRun): TyrEventInput {
    return {
        source: "check",
        kind: run.outcome === "passed" ? CHECK_PASSED_KIND : CHECK_FAILED_KIND,
        message: describeCheckRun(run),
        data: { run },
        ts: run.finishedAt,
    };
}

/** Journal event for a run that just started (see RunCheckOptions.onStart). */
export function checkStartedEvent(start: CheckStart): TyrEventInput {
    return {
        source: "check",
        kind: CHECK_STARTED_KIND,
        message: `${start.kind} started: ${start.command}`,
        data: {
            runId: start.id,
            kind: start.kind,
            command: start.command,
            cwd: start.cwd,
            trigger: start.trigger,
            headCommit: start.headCommit,
        },
        ts: start.startedAt,
    };
}
