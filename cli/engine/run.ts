// `tyr run "<prompt>"` (PLANNING.md 2.13): route the prompt (intent.ts),
// do it in the foreground with progress callbacks, then record the result.
//
//   checks   runCheckPass (pass.ts) with a manual trigger. Every check →
//            the full engine pass, review included, so findings.json stays
//            the engine's authoritative record. A subset → the checks only
//            (engine.json still records each run), with findings parsed
//            from their output for this run's report.
//   review   the diff rules and, when an API key is set (and not --no-llm),
//            the model, on the working tree or on the last commit. A review
//            run reports its findings but does not replace findings.json:
//            that file tracks the engine's passes over the working tree.
//   ask      askRepository (ask.ts): a streamed answer from the model.
//   agent    `--agent <role>`: a tool-using agent run. The engine never
//            imports cli/agents/ (see ENGINE.md), so the caller hands in a
//            RunAgentDelegate (cli/agents/agent.ts builds it) and the engine
//            only records what it returns, like every other route.
//
// Recording: `run.started` and `run.completed` go to the event journal (so
// `tyr watch` shows them), state.json counts the run (runCount,
// lastRunAt), and a `run` report lands in .tyr/reports/ with the findings
// and, for a question, the answer.
//
// executeRun never throws for a failing check or an API error; those come
// back in the result's `status`.

import { appendEvent } from "../core/events.js";
import { getDiff } from "../core/git-diff.js";
import { getCurrentBranch, getHeadCommit } from "../core/git.js";
import { writeReport, type FindingSeverity, type WrittenReport } from "../core/reports.js";
import { readConfig, TYR_DIR_NAME } from "../core/scaffold.js";
import { resolveSettings } from "../core/settings.js";
import { recordRun } from "../core/state-store.js";
import { askRepository, type AskMessagesClient, type AskResult } from "./ask.js";
import { parseCheckRun } from "./check-parsers.js";
import { reviewDiff, type DiffReviewOptions } from "./diff-review.js";
import type { CheckStart } from "./executor.js";
import { compareFindings, dedupeFindings, MAX_FINDINGS_PER_DETECTOR, type EngineFinding, type ReviewContext } from "./findings.js";
import { describeIntent, routePrompt, type RunIntent, type RunMode } from "./intent.js";
import { reviewDiffWithLlm, type LlmMessagesClient } from "./llm-review.js";
import type { CheckKind, CheckOutcome, CheckRun, CheckTrigger } from "./model.js";
import { runCheckPass, type CheckPassResult } from "./pass.js";
import { applyThreshold, countBySeverity, withUntrackedFiles, type ReviewDetectors } from "./review.js";

export const RUN_RESULT_VERSION = 1;

/** succeeded: everything passed / answered. failed: a check failed or the review found errors. error: could not do it. */
export type RunStatus = "succeeded" | "failed" | "error" | "cancelled";

export interface RunCheckSummary {
    kind: CheckKind;
    command: string;
    outcome: CheckOutcome;
    exitCode: number | null;
    durationMs: number;
}

export interface RunResult {
    runVersion: typeof RUN_RESULT_VERSION;
    /** Same id as the run.started / run.completed journal events. */
    id: string;
    prompt: string;
    intent: RunIntent;
    status: RunStatus;
    /** One line for the terminal. */
    summary: string;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    /** Checks that ran (checks route). */
    checks: RunCheckSummary[];
    /** Checks skipped because the build did not pass. */
    skipped: CheckKind[];
    /** Findings at or above the severity threshold, most severe first. */
    findings: EngineFinding[];
    counts: Record<FindingSeverity, number>;
    /** The model's answer (ask route) or the agent's final summary (agent route); null otherwise. */
    answer: string | null;
    /** Model used for the answer or the LLM review; null when none was called. */
    model: string | null;
    /** Things worth knowing that are not findings: skipped detectors, errors. */
    notes: string[];
    /** The `run` report written for this run; null when it could not be written. */
    report: { id: string; jsonFile: string; mdFile: string } | null;
    /** The agent route's full record (an AgentRunResult, cli/agents/model.ts); null for other routes. */
    agent: object | null;
}

/** What a delegated agent run hands back to be recorded. */
export interface DelegatedOutcome {
    status: RunStatus;
    summary: string;
    findings: EngineFinding[];
    /** The agent's final text, kept as the run's answer. */
    answer: string | null;
    model: string | null;
    notes: string[];
    /** The full record, kept as RunResult.agent and in the report's data. */
    record: object;
}

/** Runs an agent for the `agent` route. Built outside the engine (cli/agents/agent.ts). */
export interface RunAgentDelegate {
    /** The role id, recorded in the intent. */
    role: string;
    /** Runs the agent on the task. May throw; a throw is recorded as an error. */
    run(task: string, signal?: AbortSignal): Promise<DelegatedOutcome>;
}

export interface RunProgress {
    onIntent?: (intent: RunIntent) => void;
    onCheckStart?: (start: CheckStart) => void;
    onCheckSkip?: (kind: CheckKind, reason: string) => void;
    onCheckDone?: (run: CheckRun) => void;
    /** A review (diff rules, model) is starting; `llm` says whether the model is asked. */
    onReviewStart?: (info: { llm: boolean; scope: string }) => void;
    /** The question is about to go to the model. */
    onAskStart?: (info: { model: string; contextBytes: number }) => void;
    /** A streamed piece of the answer. */
    onText?: (text: string) => void;
}

export interface ExecuteRunOptions extends RunProgress {
    /** Force the route (`--mode`). */
    mode?: RunMode;
    /** Run this agent instead of routing the prompt (`--agent`); the prompt is its task. */
    agent?: RunAgentDelegate;
    /** Ask the model during a review (default: when an API key is set). false = never. */
    llm?: boolean;
    signal?: AbortSignal;
    /** Per-check time limit. */
    timeoutMs?: number;
    /** Clock (tests). */
    now?: () => Date;
    /** Environment for settings (tests). */
    env?: NodeJS.ProcessEnv;
    /** Injected model clients (tests). */
    askClient?: AskMessagesClient;
    llmClient?: LlmMessagesClient;
    /** Detector overrides for the checks route (tests). */
    detectors?: ReviewDetectors;
    /** Diff rule options for the review route (tests). */
    diffReview?: DiffReviewOptions;
}

const TRIGGER: CheckTrigger = { reason: "manual" };

/** Report titles are file names too; keep them short. */
const MAX_TITLE_CHARS = 72;

interface Outcome {
    status: RunStatus;
    summary: string;
    checks: RunCheckSummary[];
    skipped: CheckKind[];
    findings: EngineFinding[];
    answer: string | null;
    model: string | null;
    notes: string[];
    data: Record<string, unknown>;
    agent?: object;
}

export async function executeRun(root: string, prompt: string, options: ExecuteRunOptions = {}): Promise<RunResult> {
    const clock = options.now ?? (() => new Date());
    const started = clock();
    const intent: RunIntent = options.agent
        ? { mode: "agent", role: options.agent.role, task: prompt.trim() }
        : routePrompt(prompt, options.mode);
    safely(() => options.onIntent?.(intent));

    const startedEvent = await appendEvent(root, {
        source: "user",
        kind: "run.started",
        message: `tyr run: ${describeIntent(intent)}`,
        data: { prompt: preview(prompt), mode: intent.mode },
        ts: started,
    });
    const id = startedEvent?.id ?? `run-${started.getTime()}`;

    let outcome: Outcome;
    try {
        if (intent.mode === "checks") outcome = await runChecks(root, intent, options);
        else if (intent.mode === "review") outcome = await runReview(root, intent, options);
        else if (intent.mode === "agent") outcome = await runAgentRoute(intent, options);
        else outcome = await runAsk(root, intent.question, options);
    } catch (error) {
        outcome = {
            ...emptyOutcome(),
            status: "error",
            summary: `tyr run failed: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
    if (options.signal?.aborted && outcome.status !== "error") {
        outcome = { ...outcome, status: "cancelled", summary: "Cancelled" };
    }

    const finished = clock();
    await recordRun(root, started).catch(() => null);
    const report = await writeRunReport(root, prompt, intent, outcome, finished);
    if (report === null) outcome.notes.push("could not write the run report");

    const result: RunResult = {
        runVersion: RUN_RESULT_VERSION,
        id,
        prompt,
        intent,
        status: outcome.status,
        summary: outcome.summary,
        startedAt: started.toISOString(),
        finishedAt: finished.toISOString(),
        durationMs: Math.max(0, finished.getTime() - started.getTime()),
        checks: outcome.checks,
        skipped: outcome.skipped,
        findings: outcome.findings,
        counts: countBySeverity(outcome.findings),
        answer: outcome.answer,
        model: outcome.model,
        notes: outcome.notes,
        report: report === null ? null : { id: report.id, jsonFile: report.jsonFile, mdFile: report.mdFile },
        agent: outcome.agent ?? null,
    };

    await appendEvent(root, {
        source: "user",
        kind: "run.completed",
        message: `tyr run ${result.status}: ${result.summary}`,
        data: {
            runId: id,
            mode: intent.mode,
            status: result.status,
            durationMs: result.durationMs,
            findings: result.findings.length,
            ...(result.report ? { reportId: result.report.id } : {}),
        },
        ts: finished,
    });
    return result;
}

/* -------------------------------------------------------------------------
 * Routes
 * ---------------------------------------------------------------------- */

async function runChecks(root: string, intent: Extract<RunIntent, { mode: "checks" }>, options: ExecuteRunOptions): Promise<Outcome> {
    const settings = (await resolveSettings({ root, ...(options.env ? { env: options.env } : {}) })).settings;
    const pass: CheckPassResult = await runCheckPass(root, TRIGGER, {
        kinds: intent.checks,
        // A partial pass must not stand in for the engine's full review: it
        // would mark the other checks' findings resolved.
        review: intent.all,
        ...(options.llm === false ? { llm: false } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.detectors ? { detectors: options.detectors } : {}),
        ...(options.onCheckStart ? { onStart: options.onCheckStart } : {}),
        ...(options.onCheckSkip ? { onSkip: options.onCheckSkip } : {}),
        ...(options.onCheckDone ? { onRun: options.onCheckDone } : {}),
        onReviewStart: () => options.onReviewStart?.({ llm: false, scope: "check output and working tree" }),
    });

    const notes: string[] = [];
    let findings: EngineFinding[];
    if (pass.review !== null) {
        findings = pass.review.findings;
        notes.push(...pass.review.notes);
    } else {
        const parse = options.detectors?.parseCheckRun ?? parseCheckRun;
        const parsed: EngineFinding[] = [];
        for (const run of pass.runs) {
            try {
                parsed.push(...parse(run).slice(0, MAX_FINDINGS_PER_DETECTOR));
            } catch (error) {
                notes.push(`check output parsing failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        findings = applyThreshold(dedupeFindings(parsed), settings.severity.threshold).sort(compareFindings);
    }
    for (const run of pass.runs) {
        if (run.outcome === "error") notes.push(`${run.kind} could not run: ${run.error ?? "unknown error"}`);
        if (run.outcome === "timeout") notes.push(`${run.kind} timed out after ${Math.round(run.durationMs / 1000)}s`);
    }
    const checks = pass.runs.map(checkSummary);

    if (pass.planned.length === 0) {
        const wanted = intent.all ? "No checks are" : `${intent.checks.join(", ")} ${intent.checks.length === 1 ? "is" : "are"} not`;
        return {
            ...emptyOutcome(),
            status: "error",
            summary: `${wanted} configured or enabled. Set the commands in tyr.json (tyr config) or turn them on in settings.`,
            // A full pass still reviews the diff; keep what it found.
            findings,
            notes,
        };
    }
    const failed = checks.filter((c) => c.outcome !== "passed");
    const passed = checks.length - failed.length;
    const parts = [`${passed}/${checks.length} checks passed`];
    if (failed.length > 0) parts.push(`failed: ${failed.map((c) => c.kind).join(", ")}`);
    if (pass.skipped.length > 0) parts.push(`skipped: ${pass.skipped.join(", ")}`);
    if (findings.length > 0) parts.push(`${findings.length} finding${findings.length === 1 ? "" : "s"}`);
    return {
        status: failed.length > 0 ? "failed" : "succeeded",
        summary: parts.join("; "),
        checks,
        skipped: pass.skipped,
        findings,
        answer: null,
        model: null,
        notes,
        data: { reviewReportId: pass.review?.report?.id ?? null },
    };
}

async function runReview(root: string, intent: Extract<RunIntent, { mode: "review" }>, options: ExecuteRunOptions): Promise<Outcome> {
    const settings = (await resolveSettings({ root, ...(options.env ? { env: options.env } : {}) })).settings;
    const notes: string[] = [];
    // Tyr's own files are not the project's changes.
    const diffOptions = { pathspec: [".", `:(exclude)${TYR_DIR_NAME}`], timeoutMs: 15_000 };
    let ctx: ReviewContext | null = null;
    if (intent.scope === "last-commit") {
        const diff = await getDiff(root, { kind: "since", ref: "HEAD~1", until: "head" }, diffOptions).catch(() => null);
        if (diff !== null) ctx = { root, diff, base: "HEAD~1" };
    } else {
        const diff = await getDiff(root, { kind: "since", ref: "HEAD" }, { ...diffOptions, includeUntracked: true }).catch(() => null);
        // A truncated patch already lost its tail; appending would mislead the rules.
        if (diff !== null) ctx = { root, diff: diff.truncated ? diff : await withUntrackedFiles(root, diff).catch(() => diff), base: "HEAD" };
    }
    const what = intent.scope === "last-commit" ? "the last commit" : "uncommitted changes";
    if (ctx === null) {
        const why = intent.scope === "last-commit" ? "there is no previous commit to compare with" : "this is not a git repository with a commit";
        return { ...emptyOutcome(), status: "error", summary: `Cannot review ${what}: ${why}.` };
    }
    const totals = ctx.diff.totals;
    if (totals.files === 0) {
        return { ...emptyOutcome(), status: "succeeded", summary: `Nothing to review: no ${what}.` };
    }

    const hasKey = settings.ai.apiKey !== null && settings.ai.apiKey.trim() !== "";
    const llm = options.llm !== false && hasKey;
    options.onReviewStart?.({ llm, scope: what });

    const collected: EngineFinding[] = [];
    try {
        collected.push(...reviewDiff(ctx, options.diffReview).slice(0, MAX_FINDINGS_PER_DETECTOR));
    } catch (error) {
        notes.push(`diff review failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    let model: string | null = null;
    if (llm) {
        model = settings.ai.model;
        const outcome = await reviewDiffWithLlm(ctx, {
            settings,
            ...(options.llmClient ? { client: options.llmClient } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
        });
        if (outcome.status === "ok") collected.push(...outcome.findings.slice(0, MAX_FINDINGS_PER_DETECTOR));
        else notes.push(`LLM review ${outcome.status}${outcome.reason ? `: ${outcome.reason}` : ""}`);
    } else if (options.llm !== false) {
        notes.push("LLM review skipped: no API key (set ai.apiKey, TYR_API_KEY or ANTHROPIC_API_KEY)");
    }
    const findings = applyThreshold(dedupeFindings(collected), settings.severity.threshold).sort(compareFindings);
    const serious = findings.filter((f) => f.severity === "error" || f.severity === "critical").length;
    const summary =
        `Reviewed ${what} (${totals.files} file${totals.files === 1 ? "" : "s"}, +${totals.additions}/-${totals.deletions})` +
        (findings.length === 0 ? ": no findings" : `: ${findings.length} finding${findings.length === 1 ? "" : "s"}`) +
        (llm ? "" : " (diff rules only)");
    return {
        status: serious > 0 ? "failed" : "succeeded",
        summary,
        checks: [],
        skipped: [],
        findings,
        answer: null,
        model,
        notes,
        data: { scope: intent.scope, base: ctx.base, files: totals.files, llm },
    };
}

async function runAsk(root: string, question: string, options: ExecuteRunOptions): Promise<Outcome> {
    const result: AskResult = await askRepository(root, question, {
        ...(options.env ? { env: options.env } : {}),
        ...(options.askClient ? { client: options.askClient } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onText ? { onText: options.onText } : {}),
        ...(options.onAskStart ? { onRequest: options.onAskStart } : {}),
    });
    // The reason is already the summary; a note would repeat it.
    const notes: string[] = [];
    const answered = result.status === "ok";
    return {
        ...emptyOutcome(),
        status: answered ? "succeeded" : "error",
        summary: answered
            ? "Answered"
            : result.status === "skipped"
              ? `Cannot answer: ${result.reason ?? "skipped"}`
              : `The answer failed: ${result.reason ?? "unknown error"}`,
        answer: result.answer === "" ? null : result.answer,
        model: result.model,
        notes,
        data: { stopReason: result.stopReason ?? null, usage: result.usage ?? null },
    };
}

async function runAgentRoute(intent: Extract<RunIntent, { mode: "agent" }>, options: ExecuteRunOptions): Promise<Outcome> {
    const delegated = await options.agent!.run(intent.task, options.signal);
    return {
        status: delegated.status,
        summary: delegated.summary,
        checks: [],
        skipped: [],
        findings: delegated.findings,
        answer: delegated.answer,
        model: delegated.model,
        notes: delegated.notes,
        data: { agent: delegated.record },
        agent: delegated.record,
    };
}

/* -------------------------------------------------------------------------
 * Recording
 * ---------------------------------------------------------------------- */

async function writeRunReport(
    root: string,
    prompt: string,
    intent: RunIntent,
    outcome: Outcome,
    now: Date,
): Promise<WrittenReport | null> {
    try {
        const [config, branch, head] = await Promise.all([
            readConfig(root).catch(() => null),
            getCurrentBranch(root).catch(() => null),
            getHeadCommit(root).catch(() => null),
        ]);
        // The Markdown report shows the summary; for a question that is the answer.
        const summary = [
            `Prompt: ${prompt.trim()}`,
            `Route: ${describeIntent(intent)} (${outcome.status})`,
            "",
            outcome.answer ?? outcome.summary,
            ...(outcome.notes.length > 0 ? ["", ...outcome.notes.map((n) => `Note: ${n}`)] : []),
        ].join("\n");
        return await writeReport(
            root,
            {
                kind: "run",
                title: oneLine(prompt, MAX_TITLE_CHARS),
                summary,
                git: { branch: branch?.branch ?? null, headCommit: head?.hash ?? null },
                findings: outcome.findings,
                data: {
                    prompt,
                    intent,
                    status: outcome.status,
                    result: outcome.summary,
                    checks: outcome.checks,
                    skipped: outcome.skipped,
                    answer: outcome.answer,
                    model: outcome.model,
                    notes: outcome.notes,
                    ...outcome.data,
                },
            },
            { now, config },
        );
    } catch {
        return null;
    }
}

/* -------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------- */

function emptyOutcome(): Outcome {
    return { status: "succeeded", summary: "", checks: [], skipped: [], findings: [], answer: null, model: null, notes: [], data: {} };
}

function checkSummary(run: CheckRun): RunCheckSummary {
    return { kind: run.kind, command: run.command, outcome: run.outcome, exitCode: run.exitCode, durationMs: run.durationMs };
}

function oneLine(text: string, max: number): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length <= max ? flat : `${flat.slice(0, max - 3)}...`;
}

/** Prompts are journaled as previews, like Claude Code prompts. */
function preview(text: string): string {
    return oneLine(text, 200);
}

function safely(fn: () => void): void {
    try {
        fn();
    } catch {
        // Progress hooks never break a run.
    }
}
