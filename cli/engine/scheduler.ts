// Check scheduler (PLANNING.md 2.10, cli/engine/ENGINE.md): decides WHEN the
// project's checks run. It decides nothing about WHICH checks or HOW. Those
// belong to the `runChecks` callback the engine supplies (engine.ts).
//
// Triggers, in priority order:
//
//   commit       HEAD moved to a new commit (commit.made). Runs right away,
//                after a short coalescing delay so a rebase that moves HEAD
//                ten times runs the checks once.
//   claude-stop  Claude Code finished a turn (claude.stop) and files changed
//                since the last run. This is the natural "the agent thinks it
//                is done" moment.
//   idle         Files changed (file.changed, cause "edit") and nothing else
//                changed for `idleMs`. Suppressed while a Claude Code session
//                is mid-turn: its edits are reviewed at its Stop instead, so a
//                half-finished refactor is not tested. A session that goes
//                quiet for `claudeActiveTimeoutMs` without a Stop (crash,
//                missing hook) stops suppressing.
//   manual       requestRun("manual"), e.g. a future `tyr check`.
//
// File changes a git operation made (cause "git") never mark the tree dirty
// on their own. The commit.made that accompanies them is the trigger.
//
// Concurrency: one run at a time. A trigger that arrives during a run is
// queued (only one, keeping the highest-priority reason) and starts when the
// run ends. File changes that arrive while checks run, or within `settleMs`
// after, are assumed to be the checks' own output (build artifacts, coverage,
// caches) and ignored, unless Claude Code used a tool in that window. That
// stops a build that writes into the tree from triggering itself forever.
//
// Timers and the clock are injectable, so tests can run the policy
// deterministically. Like the rest of cli/engine this never prints and never
// throws: a failing runChecks is reported to `onError`.

import type { EventBus } from "./bus.js";
import type { CheckReason, CheckTrigger, EngineEvent } from "./model.js";

export const DEFAULT_IDLE_MS = 5_000;
export const DEFAULT_COMMIT_DELAY_MS = 1_000;
export const DEFAULT_SETTLE_MS = 3_000;
export const DEFAULT_CLAUDE_ACTIVE_TIMEOUT_MS = 2 * 60_000;

/** Higher wins when two triggers coalesce. */
const PRIORITY: Record<CheckReason, number> = {
    manual: 5,
    commit: 4,
    "claude-stop": 3,
    idle: 2,
    startup: 1,
};

export interface SchedulerTimers {
    now(): number;
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

const realTimers: SchedulerTimers = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => {
        const handle = setTimeout(fn, ms);
        // The daemon's own keep-alive holds the process open; pending checks must not.
        handle.unref?.();
        return handle;
    },
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface SchedulerOptions {
    /** Runs the checks for one trigger. Awaited; the scheduler never overlaps two calls. */
    runChecks: (trigger: CheckTrigger) => Promise<void>;
    idleMs?: number;
    commitDelayMs?: number;
    settleMs?: number;
    claudeActiveTimeoutMs?: number;
    timers?: SchedulerTimers;
    onError?: (error: unknown) => void;
}

export interface SchedulerStatus {
    running: CheckTrigger | null;
    queued: CheckTrigger | null;
    /** Files changed since the last run started. */
    dirty: boolean;
    /** Claude Code sessions currently mid-turn. */
    activeSessions: string[];
}

export interface Scheduler {
    /** Feed one engine event. attach() does this from a bus. */
    handle(event: EngineEvent): void;
    /** Subscribe to a bus; returns the unsubscribe function. */
    attach(bus: EventBus): () => void;
    /** Ask for a run now (queued if one is in progress). */
    requestRun(reason: CheckReason, eventId?: string): void;
    status(): SchedulerStatus;
    /** Resolves when no run is in progress or queued. For tests and shutdown. */
    idle(): Promise<void>;
    /** Cancel pending timers and drop the queue. A run in progress finishes. */
    close(): void;
}

/** Sessions without an id share this key. */
const ANONYMOUS_SESSION = "(unknown)";

export function createScheduler(options: SchedulerOptions): Scheduler {
    const timers = options.timers ?? realTimers;
    const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    const commitDelayMs = options.commitDelayMs ?? DEFAULT_COMMIT_DELAY_MS;
    const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
    const claudeTimeoutMs = options.claudeActiveTimeoutMs ?? DEFAULT_CLAUDE_ACTIVE_TIMEOUT_MS;

    let closed = false;
    let dirty = false;
    let running: CheckTrigger | null = null;
    let queued: CheckTrigger | null = null;
    let idleTimer: unknown = null;
    let commitTimer: unknown = null;
    let pendingCommit: CheckTrigger | null = null;
    /** Start of the current run, or end of the last run plus settleMs: changes before this are the checks' own. */
    let quietUntil = 0;
    let runStartedAt: number | null = null;
    /** Last Claude tool activity during the current or last run window. */
    let lastClaudeToolAt = -Infinity;
    /** Session id -> last activity time, for sessions mid-turn. */
    const activeSessions = new Map<string, number>();
    let waiters: (() => void)[] = [];

    const report = (error: unknown): void => {
        try {
            options.onError?.(error);
        } catch {
            // The error hook itself must not break scheduling.
        }
    };

    const clearTimer = (handle: unknown): null => {
        if (handle !== null) timers.clearTimeout(handle);
        return null;
    };

    const claudeBusy = (): boolean => {
        const now = timers.now();
        for (const [session, at] of activeSessions) {
            if (now - at >= claudeTimeoutMs) activeSessions.delete(session);
        }
        return activeSessions.size > 0;
    };

    const settle = (): void => {
        if (running !== null || queued !== null) return;
        const done = waiters;
        waiters = [];
        for (const resolve of done) resolve();
    };

    const start = (trigger: CheckTrigger): void => {
        if (closed) return;
        if (running !== null) {
            if (queued === null || PRIORITY[trigger.reason] > PRIORITY[queued.reason]) queued = trigger;
            return;
        }
        running = trigger;
        dirty = false;
        idleTimer = clearTimer(idleTimer);
        runStartedAt = timers.now();
        lastClaudeToolAt = -Infinity;
        let result: Promise<void>;
        try {
            result = Promise.resolve(options.runChecks(trigger));
        } catch (error) {
            result = Promise.reject(error);
        }
        void result.catch(report).finally(() => {
            running = null;
            runStartedAt = null;
            quietUntil = timers.now() + settleMs;
            const next = queued;
            queued = null;
            if (next !== null) {
                start(next);
            } else {
                if (dirty) armIdle();
                settle();
            }
        });
    };

    const armIdle = (): void => {
        idleTimer = clearTimer(idleTimer);
        if (closed) return;
        idleTimer = timers.setTimeout(() => {
            idleTimer = null;
            if (!dirty) return;
            if (claudeBusy()) {
                // Re-check once the session would time out; its Stop usually comes first.
                armIdle();
                return;
            }
            start({ reason: "idle" });
        }, idleMs);
    };

    /** Was this change most likely written by the checks themselves? */
    const isCheckOutput = (at: number): boolean => {
        const inWindow = runStartedAt !== null || at < quietUntil;
        return inWindow && lastClaudeToolAt === -Infinity;
    };

    const handle = (event: EngineEvent): void => {
        if (closed) return;
        const now = timers.now();
        switch (event.type) {
            case "file.changed": {
                if (event.cause === "git") return;
                if (isCheckOutput(now)) return;
                dirty = true;
                if (running === null) armIdle();
                return;
            }
            case "commit.made": {
                // Coalesce bursts (rebase, cherry-picks); the last commit wins.
                pendingCommit = { reason: "commit", eventId: event.id };
                commitTimer = clearTimer(commitTimer);
                commitTimer = timers.setTimeout(() => {
                    commitTimer = null;
                    const trigger = pendingCommit;
                    pendingCommit = null;
                    if (trigger !== null) start(trigger);
                }, commitDelayMs);
                return;
            }
            case "claude.tool": {
                activeSessions.set(event.sessionId ?? ANONYMOUS_SESSION, now);
                lastClaudeToolAt = now;
                return;
            }
            case "claude.stop": {
                activeSessions.delete(event.sessionId ?? ANONYMOUS_SESSION);
                if (dirty) start({ reason: "claude-stop", eventId: event.id });
                return;
            }
            default:
                return;
        }
    };

    return {
        handle,
        attach(bus) {
            return bus.subscribe(["file.changed", "commit.made", "claude.tool", "claude.stop"], handle);
        },
        requestRun(reason, eventId) {
            start(eventId === undefined ? { reason } : { reason, eventId });
        },
        status() {
            claudeBusy();
            return { running, queued, dirty, activeSessions: [...activeSessions.keys()] };
        },
        idle() {
            if (running === null && queued === null) return Promise.resolve();
            return new Promise((resolve) => waiters.push(resolve));
        },
        close() {
            closed = true;
            idleTimer = clearTimer(idleTimer);
            commitTimer = clearTimer(commitTimer);
            pendingCommit = null;
            queued = null;
            if (running === null) settle();
        },
    };
}
