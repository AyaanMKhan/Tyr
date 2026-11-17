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
//   4. Review the pass (review.ts): parse the runs' output into findings,
//      review the working-tree diff (settings review.diff), and on Claude
//      Code Stop, commit or a manual run also ask the model (review.llm, off
//      by default because it costs API calls). Regressions are marked against
//      the previous pass, and a report goes to .tyr/reports/ when something
//      changed.
//
// Only events journaled after the engine starts are considered: the daemon
// is not meant to replay history into checks on every restart.
//
// startEngine never throws; problems go to `log` (the daemon passes
// appendLog). close() cancels a run in progress, which kills its processes.

import { appendLog } from "../core/scaffold.js";
import { resolveSettings } from "../core/settings.js";
import { parseCheckRun } from "./check-parsers.js";
import { reviewDiff } from "./diff-review.js";
import { reviewDiffWithLlm } from "./llm-review.js";
import { reviewPass, type ReviewDetectors, type ReviewPassResult } from "./review.js";
import { attachJournal, EventBus, publish, type JournalDetach } from "./bus.js";
import { checkRunToEvent, checkStartedEvent, describeCheckRun, loadCheckCommands, runCheck } from "./executor.js";
import { CHECK_KINDS, type CheckKind, type CheckRun, type CheckTrigger } from "./model.js";
import { readEngineState, recordCheckRun, refreshWorkingTree } from "./repo-state.js";
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

/** Triggers that may spend API calls on an LLM review. */
const LLM_TRIGGERS: ReadonlySet<CheckTrigger["reason"]> = new Set(["claude-stop", "commit", "manual"]);

/** Checks skipped when the build did not pass. */
const NEEDS_BUILD: ReadonlySet<CheckKind> = new Set<CheckKind>(["test"]);

export async function startEngine(root: string, options: EngineOptions = {}): Promise<Engine> {
    const log = options.log ?? ((level, message) => void appendLog(root, level, message));
    const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));
    const abort = new AbortController();

    const runChecks = async (trigger: CheckTrigger): Promise<void> => {
        const [commands, resolved] = await Promise.all([loadCheckCommands(root), resolveSettings({ root })]);
        const settings = resolved.settings;
        const kinds = CHECK_KINDS.filter((kind) => commands[kind] !== undefined);
        const reviewing = settings.review.diff || settings.review.llm;
        if (kinds.length === 0 && !reviewing) {
            log("debug", `engine: no checks or reviews enabled (trigger ${trigger.reason})`);
            return;
        }
        // Before this pass is recorded: regressions compare against it.
        const stateBefore = await readEngineState(root);
        await refreshWorkingTree(root).catch((error) => log("warn", `engine: could not snapshot the working tree: ${describe(error)}`));
        if (kinds.length > 0) log("info", `engine: running ${kinds.join(", ")} (trigger ${trigger.reason})`);

        const runs: CheckRun[] = [];
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
                runs.push(run);
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
        if (abort.signal.aborted) return;

        const detectors: ReviewDetectors = options.detectors ?? {
            parseCheckRun,
            ...(settings.review.diff ? { reviewDiff: (ctx) => reviewDiff(ctx) } : {}),
            reviewDiffWithLlm: (ctx) => reviewDiffWithLlm(ctx, { settings, signal: abort.signal }),
        };
        const result = await reviewPass(root, {
            trigger,
            runs,
            stateBefore,
            threshold: settings.severity.threshold,
            llm: settings.review.llm && LLM_TRIGGERS.has(trigger.reason),
            detectors,
        });
        for (const note of result.notes) log("warn", `engine: review: ${note}`);
        log(
            result.findings.length > 0 ? "warn" : "info",
            `engine: review found ${result.findings.length} (${result.regressions.length} regressions, ${result.added.length} new, ${result.resolved.length} resolved)` +
                (result.report ? `; report ${result.report.id}` : ""),
        );
        try {
            options.onReview?.(result);
        } catch {
            // Test hook.
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
