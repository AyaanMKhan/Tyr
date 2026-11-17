// The engine (PLANNING.md 2.10, cli/engine/ENGINE.md): wires the event bus,
// scheduler, executor and repository state together. The daemon starts one
// per project with startEngine() and closes it on shutdown.
//
//   journal ─attachJournal─▶ EventBus ─▶ Scheduler ─runChecks─▶ executor
//                                                       │
//                       engine.json ◀─recordCheckRun────┤
//                       journal     ◀─check.* events────┘
//
// One check pass (runChecks) for a trigger is runCheckPass in pass.ts,
// which `tyr run` shares.
//
// Only events journaled after the engine starts are considered: the daemon
// is not meant to replay history into checks on every restart.
//
// startEngine never throws; problems go to `log` (the daemon passes
// appendLog). close() cancels a run in progress, which kills its processes.

import { appendLog } from "../core/scaffold.js";
import type { ReviewDetectors, ReviewPassResult } from "./review.js";
import { attachJournal, EventBus, type JournalDetach } from "./bus.js";
import type { CheckRun, CheckTrigger } from "./model.js";
import { runCheckPass } from "./pass.js";
import { createScheduler, type Scheduler, type SchedulerOptions } from "./scheduler.js";

export type EngineLogLevel = "debug" | "info" | "warn" | "error";

export interface EngineOptions {
    /** Defaults to appendLog (tyr.log). */
    log?: (level: EngineLogLevel, message: string) => void;
    /** Scheduler timing overrides (tests). */
    scheduler?: Omit<SchedulerOptions, "runChecks" | "onError">;
    /** Per-check time limit; defaults to the executor's. */
    timeoutMs?: number;
    /** Passed to attachJournal (tests use forcePolling). */
    journal?: { forcePolling?: boolean; pollIntervalMs?: number };
    /** Called after every finished check (tests). */
    onRun?: (run: CheckRun) => void;
    /** Called after every review pass (tests). */
    onReview?: (result: ReviewPassResult) => void;
    /** Detector overrides (tests); default: the real parsers, diff review and LLM review. */
    detectors?: ReviewDetectors;
}

export interface Engine {
    readonly scheduler: Scheduler;
    /** Stop listening, cancel any run in progress and wait for it to end. */
    close(): Promise<void>;
}

export async function startEngine(root: string, options: EngineOptions = {}): Promise<Engine> {
    const log = options.log ?? ((level, message) => void appendLog(root, level, message));
    const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));
    const abort = new AbortController();

    const runChecks = async (trigger: CheckTrigger): Promise<void> => {
        const result = await runCheckPass(root, trigger, {
            signal: abort.signal,
            log,
            ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
            ...(options.onRun ? { onRun: options.onRun } : {}),
            ...(options.detectors ? { detectors: options.detectors } : {}),
        });
        if (result.review !== null) {
            try {
                options.onReview?.(result.review);
            } catch {
                // Test hook.
            }
        }
    };

    const bus = new EventBus({ onError: (error) => log("error", `engine: event handler failed: ${describe(error)}`) });
    const scheduler = createScheduler({
        ...options.scheduler,
        runChecks,
        onError: (error) => log("error", `engine: check pass failed: ${describe(error)}`),
    });
    const unsubscribe = scheduler.attach(bus);

    let detach: JournalDetach | null = null;
    try {
        detach = await attachJournal(root, bus, { ...options.journal });
    } catch (error) {
        log("error", `engine: cannot follow the event journal: ${describe(error)}`);
    }

    let closing: Promise<void> | null = null;
    return {
        scheduler,
        close() {
            closing ??= (async () => {
                unsubscribe();
                scheduler.close();
                abort.abort();
                await detach?.();
                await scheduler.idle();
            })();
            return closing;
        },
    };
}
