// The engine (PLANNING.md 2.10, cli/engine/ENGINE.md): wires the event bus,
// scheduler, executor and repository state together. The daemon starts one
// per project with startEngine() and closes it on shutdown.
//
//   journal ─attachJournal─▶ EventBus ─▶ Scheduler ─runChecks─▶ executor
//                                                       │
//                       engine.json ◀─recordCheckRun────┤
//                       journal     ◀─check.* events────┘
//
// One check pass (runChecks) for a trigger:
//   1. Re-read the commands (tyr.json + settings) so edits apply without a
//      restart, and snapshot the working tree into engine.json.
//   2. Run each enabled check in CHECK_KINDS order (build, typecheck, lint,
//      test, format), one at a time: checks often share caches and build
//      output, and running them in parallel would make timings meaningless.
//   3. Journal check.started / check.passed / check.failed for each run and
//      fold the result into engine.json (open problems, last good run).
//   If the build does not pass, test is skipped: tests of a broken build only
//   repeat the build's failure.
//
// Only events journaled after the engine starts are considered: the daemon
// is not meant to replay history into checks on every restart.
//
// startEngine never throws; problems go to `log` (the daemon passes
// appendLog). close() cancels a run in progress, which kills its processes.

import { appendLog } from "../core/scaffold.js";
import { attachJournal, EventBus, publish, type JournalDetach } from "./bus.js";
import { checkRunToEvent, checkStartedEvent, describeCheckRun, loadCheckCommands, runCheck } from "./executor.js";
import { CHECK_KINDS, type CheckKind, type CheckRun, type CheckTrigger } from "./model.js";
import { recordCheckRun, refreshWorkingTree } from "./repo-state.js";
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
}

export interface Engine {
    readonly scheduler: Scheduler;
    /** Stop listening, cancel any run in progress and wait for it to end. */
    close(): Promise<void>;
}

/** Checks skipped when the build did not pass. */
const NEEDS_BUILD: ReadonlySet<CheckKind> = new Set<CheckKind>(["test"]);

export async function startEngine(root: string, options: EngineOptions = {}): Promise<Engine> {
    const log = options.log ?? ((level, message) => void appendLog(root, level, message));
    const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));
    const abort = new AbortController();

    const runChecks = async (trigger: CheckTrigger): Promise<void> => {
        const commands = await loadCheckCommands(root);
        const kinds = CHECK_KINDS.filter((kind) => commands[kind] !== undefined);
        if (kinds.length === 0) {
            log("debug", `engine: no checks enabled (trigger ${trigger.reason})`);
            return;
        }
        await refreshWorkingTree(root).catch((error) => log("warn", `engine: could not snapshot the working tree: ${describe(error)}`));
        log("info", `engine: running ${kinds.join(", ")} (trigger ${trigger.reason})`);

        let buildPassed = true;
        for (const kind of kinds) {
            if (abort.signal.aborted) return;
            if (NEEDS_BUILD.has(kind) && !buildPassed) {
                log("info", `engine: skipping ${kind}: the build did not pass`);
                continue;
            }
            const run = await runCheck(root, kind, commands[kind]!, {
                trigger,
                signal: abort.signal,
                ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
                onStart: (start) => void publish(root, checkStartedEvent(start)),
            });
            if (kind === "build") buildPassed = run.outcome === "passed";
            // Cancelled runs only happen on shutdown; they say nothing about the code.
            if (run.outcome !== "cancelled") {
                await recordCheckRun(root, run).catch((error) => log("warn", `engine: could not record ${kind}: ${describe(error)}`));
            }
            await publish(root, checkRunToEvent(run));
            log(run.outcome === "passed" ? "info" : "warn", `engine: ${describeCheckRun(run)}`);
            try {
                options.onRun?.(run);
            } catch {
                // Test hook; never let it break a pass.
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
