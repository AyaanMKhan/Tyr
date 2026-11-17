// One check pass, shared by the engine (cli/engine/engine.ts, triggered by
// the scheduler) and `tyr run` (triggered by the user, in the foreground).
//
//   1. Re-read the commands (tyr.json + settings) so edits apply without a
//      restart, and snapshot the working tree into engine.json.
//   2. Run each enabled check in CHECK_KINDS order (build, typecheck, lint,
//      test, format), one at a time: checks often share caches and build
//      output, and running them in parallel would make timings meaningless.
//      `kinds` narrows the set (a `tyr run "run the tests"`).
//   3. Journal check.started / check.passed / check.failed for each run and
//      fold the result into engine.json (open problems, last good run).
//      If the build does not pass, test is skipped: tests of a broken build
//      only repeat the build's failure.
//   4. Review the pass (review.ts): parse the runs' output into findings,
//      review the working-tree diff (settings review.diff), and on Claude
//      Code Stop, commit or a manual run also ask the model (review.llm, off
//      by default because it costs API calls). Regressions are marked against
//      the previous pass, and a report goes to .tyr/reports/ when something
//      changed.
//
// runCheckPass never throws for a failing check; only an unexpected bug
// escapes, and callers catch it.

import { resolveSettings } from "../core/settings.js";
import { parseCheckRun } from "./check-parsers.js";
import { reviewDiff } from "./diff-review.js";
import { reviewDiffWithLlm } from "./llm-review.js";
import { reviewPass, type ReviewDetectors, type ReviewPassResult } from "./review.js";
import { publish } from "./bus.js";
import { checkRunToEvent, checkStartedEvent, describeCheckRun, loadCheckCommands, runCheck, type CheckStart } from "./executor.js";
import { CHECK_KINDS, type CheckKind, type CheckRun, type CheckTrigger } from "./model.js";
import { readEngineState, recordCheckRun, refreshWorkingTree } from "./repo-state.js";

export type PassLogLevel = "debug" | "info" | "warn" | "error";

/** Triggers that may spend API calls on an LLM review. */
export const LLM_TRIGGERS: ReadonlySet<CheckTrigger["reason"]> = new Set(["claude-stop", "commit", "manual"]);

/** Checks skipped when the build did not pass. */
const NEEDS_BUILD: ReadonlySet<CheckKind> = new Set<CheckKind>(["test"]);

export interface CheckPassOptions {
    /** Only these checks (still in CHECK_KINDS order, still only if configured and enabled). Default: all. */
    kinds?: readonly CheckKind[];
    /** Run the review step (findings, diff review, LLM review). Default true. */
    review?: boolean;
    /** Force the LLM review on or off; default: settings review.llm on an LLM trigger. */
    llm?: boolean;
    /** Cancels the pass; a cancelled check kills its processes. */
    signal?: AbortSignal;
    /** Per-check time limit; defaults to the executor's. */
    timeoutMs?: number;
    log?: (level: PassLogLevel, message: string) => void;
    /** Called when a check starts (after it is journaled). */
    onStart?: (start: CheckStart) => void;
    /** Called when a check is skipped because the build did not pass. */
    onSkip?: (kind: CheckKind, reason: string) => void;
    /** Called after every finished check. */
    onRun?: (run: CheckRun) => void;
    /** Called when the review step starts. */
    onReviewStart?: () => void;
    /** Detector overrides (tests); default: the real parsers, diff review and LLM review. */
    detectors?: ReviewDetectors;
}

export interface CheckPassResult {
    /** Checks that were configured, enabled and selected, in run order. */
    planned: CheckKind[];
    /** Finished (not cancelled) runs, in order. */
    runs: CheckRun[];
    /** Checks skipped because the build did not pass. */
    skipped: CheckKind[];
    /** Review result; null when the review step did not run (disabled, nothing to review, or cancelled). */
    review: ReviewPassResult | null;
    /** True when nothing was configured or enabled for this pass. */
    empty: boolean;
    cancelled: boolean;
}

function safely(fn: () => void): void {
    try {
        fn();
    } catch {
        // Callback hooks never break a pass.
    }
}

export async function runCheckPass(root: string, trigger: CheckTrigger, options: CheckPassOptions = {}): Promise<CheckPassResult> {
    const log = options.log ?? (() => undefined);
    const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));
    const signal = options.signal;
    const result: CheckPassResult = { planned: [], runs: [], skipped: [], review: null, empty: false, cancelled: false };

    const [commands, resolved] = await Promise.all([loadCheckCommands(root), resolveSettings({ root })]);
    const settings = resolved.settings;
    const selected = options.kinds ? new Set(options.kinds) : null;
    const kinds = CHECK_KINDS.filter((kind) => commands[kind] !== undefined && (selected === null || selected.has(kind)));
    result.planned = [...kinds];
    const reviewWanted = options.review !== false;
    const llm = options.llm ?? (settings.review.llm && LLM_TRIGGERS.has(trigger.reason));
    const reviewing = reviewWanted && (settings.review.diff || settings.review.llm || llm);
    if (kinds.length === 0 && !reviewing) {
        log("debug", `engine: no checks or reviews enabled (trigger ${trigger.reason})`);
        result.empty = true;
        return result;
    }
    // Before this pass is recorded: regressions compare against it.
    const stateBefore = await readEngineState(root);
    await refreshWorkingTree(root).catch((error) => log("warn", `engine: could not snapshot the working tree: ${describe(error)}`));
    if (kinds.length > 0) log("info", `engine: running ${kinds.join(", ")} (trigger ${trigger.reason})`);

    let buildPassed = true;
    for (const kind of kinds) {
        if (signal?.aborted) {
            result.cancelled = true;
            return result;
        }
        if (NEEDS_BUILD.has(kind) && !buildPassed) {
            log("info", `engine: skipping ${kind}: the build did not pass`);
            result.skipped.push(kind);
            safely(() => options.onSkip?.(kind, "the build did not pass"));
            continue;
        }
        const run = await runCheck(root, kind, commands[kind]!, {
            trigger,
            ...(signal ? { signal } : {}),
            ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
            onStart: (start) => {
                void publish(root, checkStartedEvent(start));
                safely(() => options.onStart?.(start));
            },
        });
        if (kind === "build") buildPassed = run.outcome === "passed";
        // Cancelled runs only happen on shutdown or Ctrl-C; they say nothing about the code.
        if (run.outcome !== "cancelled") {
            result.runs.push(run);
            await recordCheckRun(root, run).catch((error) => log("warn", `engine: could not record ${kind}: ${describe(error)}`));
        }
        await publish(root, checkRunToEvent(run));
        log(run.outcome === "passed" ? "info" : "warn", `engine: ${describeCheckRun(run)}`);
        safely(() => options.onRun?.(run));
    }
    if (signal?.aborted) {
        result.cancelled = true;
        return result;
    }
    if (!reviewWanted) return result;

    safely(() => options.onReviewStart?.());
    const detectors: ReviewDetectors = options.detectors ?? {
        parseCheckRun,
        ...(settings.review.diff ? { reviewDiff: (ctx) => reviewDiff(ctx) } : {}),
        reviewDiffWithLlm: (ctx) => reviewDiffWithLlm(ctx, { settings, ...(signal ? { signal } : {}) }),
    };
    const review = await reviewPass(root, {
        trigger,
        runs: result.runs,
        stateBefore,
        threshold: settings.severity.threshold,
        llm,
        detectors,
    });
    for (const note of review.notes) log("warn", `engine: review: ${note}`);
    log(
        review.findings.length > 0 ? "warn" : "info",
        `engine: review found ${review.findings.length} (${review.regressions.length} regressions, ${review.added.length} new, ${review.resolved.length} resolved)` +
            (review.report ? `; report ${review.report.id}` : ""),
    );
    result.review = review;
    return result;
}
