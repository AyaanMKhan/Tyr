// cli/agents/agent.ts — one agent run, end to end (PLANNING 2.14).
//
//   runAgent(root, options, deps)   -> Promise<AgentRunResult>
//   agentRouteOutcome(result)       -> the `tyr run --agent` outcome (engine/run.ts)
//   parseAgentFindings(text, role)  -> EngineFinding[] from a reviewer's summary
//
// The steps, each from its own module:
//
//   1. key and model        provider.ts resolveAgentAi    no key -> "skipped"
//   2. role                 roles.ts getRole               unknown -> "error"
//   3. refusal up front     a write role told to apply with approval "deny"
//                           (nobody to ask, no --yes) is "denied" before any
//                           request: every edit would be refused anyway
//   4. isolation            safety.ts createAgentWorktree (carryChanges), the
//                           workspace becomes the worktree; the copied user
//                           changes are staged there, so its unstaged diff
//                           is exactly the agent's work
//   5. context and prompts  context.ts buildAgentContext / buildSystemPrompt /
//                           buildTaskMessage
//   6. gate and tools       safety.ts createGate (the role's ceiling),
//                           tools.ts createToolset filtered to role.tools
//   7. the loop             provider.ts runToolLoop with role.maxTurns
//   8. cleanup and record   an isolated worktree that ended with no changes
//                           (dry-run, nothing edited, a failure) is removed
//                           with its branch; one with changes is kept for the
//                           user to review. Gate decisions are summarized.
//   9. optional correction  with `correct`, the summary is queued for a live
//                           Claude Code session (coordinate.ts, source "agent")
//
// Context is read from the project root even for isolated runs: the worktree
// starts at the same HEAD with the user's uncommitted changes copied in, so
// the diff is the same, and failing output and findings live in the root's
// .tyr/state/ (which is not committed, so the worktree has none). Check
// commands also come from the root's tyr.json and settings; they run in the
// workspace.
//
// Like the rest of cli/agents: nothing prints, runAgent never throws, and the
// client, prompter, clock and git runner are injectable.

import { runGit } from "../core/git-exec.js";
import { loadCheckCommands } from "../engine/executor.js";
import { makeFinding, type EngineFinding } from "../engine/findings.js";
import type { DelegatedOutcome, RunStatus } from "../engine/run.js";
import type { FindingSeverity } from "../core/reports.js";
import { buildAgentContext, buildSystemPrompt, buildTaskMessage, type AgentContextOptions } from "./context.js";
import { queueCorrection } from "./coordinate.js";
import type {
    AgentRole,
    AgentRunOptions,
    AgentRunResult,
    AgentRunStatus,
    AgentSafetySummary,
    ProposedChange,
} from "./model.js";
import {
    defaultAgentClient,
    resolveAgentAi,
    runToolLoop,
    type AgentAi,
    type AgentMessagesClient,
    type ToolLoopEvent,
    type ToolLoopResult,
} from "./provider.js";
import { getRole } from "./roles.js";
import {
    createAgentWorktree,
    createGate,
    removeAgentWorktree,
    type AgentWorktree,
    type GitRunner,
    type SafetyDecision,
} from "./safety.js";
import { createToolset, type ToolsetOptions } from "./tools.js";

/** Refusals kept in the safety summary. */
export const MAX_RECORDED_REFUSALS = 20;

/** Progress of a run: the loop's events plus the orchestrator's own. */
export type AgentEvent =
    | ToolLoopEvent
    | { type: "start"; role: string; model: string; dryRun: boolean; isolate: boolean; approval: AgentRunOptions["approval"] }
    | { type: "worktree"; path: string; branch: string; carried: number }
    | { type: "decision"; decision: SafetyDecision };

export interface AgentDeps {
    /** Messages client. Default: a real Anthropic client for the resolved key. */
    client?: AgentMessagesClient;
    /** Key and model. Default: resolveAgentAi(root, { env }). */
    ai?: AgentAi;
    /** Environment for settings. Default process.env. */
    env?: NodeJS.ProcessEnv;
    /** Approval prompter for approval "ask" (createGate's default otherwise). */
    prompter?: (change: ProposedChange) => Promise<boolean>;
    now?: () => Date;
    git?: GitRunner;
    signal?: AbortSignal;
    onEvent?: (event: AgentEvent) => void;
    /** Tool overrides (check commands, check runner, time limit). */
    toolset?: ToolsetOptions;
    /** Context overrides (e.g. failing output tyr run already has). */
    context?: AgentContextOptions;
    /** resolveRunSafety's explanation, kept in the record. */
    explanation?: string;
    /** Queue the final summary as a correction for a live Claude Code session (source "agent"). */
    correct?: boolean;
    /** Override role.maxTurns (tests, tighter budgets). */
    maxTurns?: number;
    /** Per-request time limit for the model. */
    timeoutMs?: number;
}

export async function runAgent(root: string, options: AgentRunOptions, deps: AgentDeps = {}): Promise<AgentRunResult> {
    const now = deps.now ?? (() => new Date());
    const started = now();
    const notes: string[] = [];
    const decisions: SafetyDecision[] = [];
    const emit = (event: AgentEvent): void => {
        try {
            deps.onEvent?.(event);
        } catch {
            // A broken progress printer must not end the run.
        }
    };
    const base = (status: AgentRunStatus, reason?: string): AgentRunResult => ({
        role: options.role,
        status,
        summary: "",
        ...(reason !== undefined ? { reason } : {}),
        toolCalls: [],
        changes: [],
        turns: 0,
        notes,
        startedAt: started.toISOString(),
        durationMs: Math.max(0, now().getTime() - started.getTime()),
    });

    const role = getRole(options.role);
    if (role === undefined) return base("error", `unknown role "${String(options.role)}"`);
    if (typeof options.task !== "string" || options.task.trim() === "") return base("error", "the task is empty");

    const ai = deps.ai ?? (await resolveAgentAi(root, { ...(deps.env ? { env: deps.env } : {}) }));
    if (!ai.ok) return base("skipped", ai.reason);

    if (role.permission === "write" && !options.dryRun && options.approval === "deny") {
        return {
            ...base("denied", deps.explanation ?? "changes are not approved for this run"),
            model: ai.model,
            safety: summarize(options, deps.explanation, decisions),
        };
    }
    if (deps.signal?.aborted) return { ...base("cancelled", "cancelled"), model: ai.model };

    let worktree: AgentWorktree | null = null;
    let loop: ToolLoopResult | null = null;
    let changes: ProposedChange[] = [];
    let failure: string | null = null;
    try {
        let workspace = root;
        if (options.isolate) {
            const created = await createAgentWorktree(root, {
                role: role.id,
                carryChanges: true,
                ...(deps.now ? { now: deps.now } : {}),
                ...(deps.git ? { git: deps.git } : {}),
            });
            if ("error" in created) {
                return {
                    ...base("error", `could not create the worktree: ${created.error}`),
                    model: ai.model,
                    safety: summarize(options, deps.explanation, decisions),
                };
            }
            worktree = created;
            workspace = created.workspace;
            const carried = (created.carried?.copied.length ?? 0) + (created.carried?.deleted.length ?? 0);
            emit({ type: "worktree", path: created.path, branch: created.branch, carried });
            if (created.carried && created.carried.skipped.length > 0) {
                notes.push(`not copied into the worktree: ${created.carried.skipped.join(", ")}`);
            }
            // Stage the copy of the user's changes, so `git diff` in the
            // worktree shows only what the agent changed (and can be applied
            // to the user's tree as a patch). The agent's git_diff compares
            // with HEAD, so it still sees everything.
            if (carried > 0) {
                const staged = await (deps.git ?? runGit)(created.path, ["add", "-A", "--", "."]).catch(() => null);
                if (staged === null || !staged.ok) notes.push("could not stage your copied changes in the worktree; its git diff includes them");
            }
        }

        emit({ type: "start", role: role.id, model: ai.model, dryRun: options.dryRun, isolate: worktree !== null, approval: options.approval });

        const context = await buildAgentContext(root, deps.context);
        const gate = createGate({
            ceiling: role.permission,
            workspace,
            approval: options.approval,
            dryRun: options.dryRun,
            ...(deps.prompter ? { prompter: deps.prompter } : {}),
            ...(deps.now ? { now: deps.now } : {}),
            onDecision: (decision) => {
                decisions.push(decision);
                emit({ type: "decision", decision });
            },
        });
        const toolset = createToolset({
            loadCommands: () => loadCheckCommands(root, deps.env ? { env: deps.env } : {}),
            ...deps.toolset,
        });
        changes = toolset.changes;
        const signal = deps.signal;

        loop = await runToolLoop({
            client: deps.client ?? defaultAgentClient(ai.apiKey),
            model: ai.model,
            system: buildSystemPrompt(role, context),
            task: buildTaskMessage(options.task, context),
            tools: toolset.toolsFor(role.tools),
            env: { workspace, dryRun: options.dryRun, gate, ...(signal ? { signal } : {}) },
            maxTurns: deps.maxTurns ?? role.maxTurns,
            ...(signal ? { signal } : {}),
            ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
            onEvent: emit,
            apiKey: ai.apiKey,
        });
    } catch (error) {
        failure = `agent failed: ${error instanceof Error ? error.message : String(error)}`;
    }

    // Keep a worktree only when the agent left something in it to review.
    let keptWorktree: { path: string; branch: string } | undefined;
    if (worktree !== null) {
        const wrote = !options.dryRun && changes.length > 0;
        if (wrote) {
            keptWorktree = { path: worktree.path, branch: worktree.branch };
        } else {
            const removed = await removeAgentWorktree(root, worktree.path, {
                force: true,
                keepBranch: false,
                ...(deps.git ? { git: deps.git } : {}),
            }).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
            if ("error" in removed) {
                keptWorktree = { path: worktree.path, branch: worktree.branch };
                notes.push(`could not remove the unused worktree: ${removed.error}`);
            } else {
                notes.push("the worktree was removed: the agent made no changes in it");
            }
        }
    }

    const result: AgentRunResult = {
        role: role.id,
        status: failure !== null ? "error" : (loop?.status ?? "error"),
        summary: loop?.summary ?? "",
        ...(failure !== null ? { reason: failure } : loop?.reason !== undefined ? { reason: loop.reason } : {}),
        toolCalls: loop?.toolCalls ?? [],
        changes: [...changes],
        ...(keptWorktree ? { worktree: keptWorktree } : {}),
        turns: loop?.turns ?? 0,
        ...(loop ? { usage: { inputTokens: loop.usage.inputTokens, outputTokens: loop.usage.outputTokens } } : {}),
        model: ai.model,
        safety: summarize({ ...options, isolate: worktree !== null }, deps.explanation, decisions),
        notes,
        startedAt: started.toISOString(),
        durationMs: 0,
    };

    if (deps.correct === true && result.status === "completed" && result.summary.trim() !== "") {
        try {
            const correction = await queueCorrection(
                root,
                {
                    source: "agent",
                    severity: correctionSeverity(role, result.summary),
                    message: `Tyr's ${role.id} agent: ${result.summary}`,
                },
                { now: now() },
            );
            if (correction !== null) {
                result.correctionId = correction.id;
                notes.push("the summary was queued for the live Claude Code session (agents.correct)");
            }
        } catch (error) {
            notes.push(`could not queue the correction: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    result.durationMs = Math.max(0, now().getTime() - started.getTime());
    return result;
}

function summarize(
    options: Pick<AgentRunOptions, "dryRun" | "isolate" | "approval">,
    explanation: string | undefined,
    decisions: readonly SafetyDecision[],
): AgentSafetySummary {
    const checks = decisions.filter((d) => d.kind === "check");
    const approvals = decisions.filter((d) => d.kind === "approve");
    const refusals = decisions
        .filter((d) => !d.allowed)
        .slice(-MAX_RECORDED_REFUSALS)
        .map((d) => ({ tool: d.tool, ...(d.path !== undefined ? { path: d.path } : {}), reason: d.reason ?? "denied" }));
    return {
        dryRun: options.dryRun,
        isolate: options.isolate,
        approval: options.approval,
        ...(explanation !== undefined ? { explanation } : {}),
        checks: checks.length,
        denied: checks.filter((d) => !d.allowed).length,
        approved: approvals.filter((d) => d.allowed).length,
        refused: approvals.filter((d) => !d.allowed).length,
        refusals,
    };
}

function correctionSeverity(role: AgentRole, summary: string): FindingSeverity {
    const findings = parseAgentFindings(summary, role.id);
    if (findings.some((f) => f.severity === "critical")) return "critical";
    if (findings.some((f) => f.severity === "error")) return "error";
    if (role.id === "test-runner" && /:\s*failed\b/i.test(summary)) return "error";
    return "warning";
}

/* -------------------------------------------------------------------------
 * Findings from a reviewer's summary
 * ---------------------------------------------------------------------- */

const FINDING_LINE = /^\s*(?:[-*]\s*)?(critical|error|warning|info)\s+(\S+?)(?::(\d+))?(?::\d+)?\s+[-–—]\s+(.+)$/i;

/**
 * The reviewer is told to report one finding per line as
 * `<severity> path:line - <problem>. <why>`; those lines become findings
 * (source "llm", rule "agent:<role>") so the run report, the exit code and
 * --json treat them like any other review. Lines in another shape are left
 * in the summary only.
 */
export function parseAgentFindings(text: string, role: string): EngineFinding[] {
    const findings: EngineFinding[] = [];
    for (const line of text.split(/\r?\n/)) {
        const match = FINDING_LINE.exec(line);
        if (match === null) continue;
        const [, severity, file, lineNo, rest] = match;
        const body = rest!.trim();
        const cut = body.search(/\.\s/);
        const title = cut > 0 ? body.slice(0, cut) : body.replace(/\.$/, "");
        const detail = cut > 0 ? body.slice(cut + 1).trim() : undefined;
        findings.push(
            makeFinding({
                source: "llm",
                severity: severity!.toLowerCase() as FindingSeverity,
                title,
                ...(detail ? { detail } : {}),
                file: file!.replace(/\\/g, "/"),
                ...(lineNo !== undefined ? { line: Number(lineNo) } : {}),
                rule: `agent:${role}`,
            }),
        );
    }
    return findings;
}

/* -------------------------------------------------------------------------
 * `tyr run --agent`
 * ---------------------------------------------------------------------- */

/**
 * The run outcome engine/run.ts records for an agent run. Status:
 *   completed  succeeded, or failed when the reviewer reported an error or
 *              critical finding, or the test-runner reported a failing check
 *   max-turns  failed (the agent did not finish)
 *   cancelled  cancelled
 *   skipped / denied / error   error
 */
export function agentRouteOutcome(result: AgentRunResult): DelegatedOutcome {
    const findings = result.role === "reviewer" ? parseAgentFindings(result.summary, result.role) : [];
    const serious = findings.some((f) => f.severity === "error" || f.severity === "critical");
    const checkFailed = result.role === "test-runner" && /^\s*\S+:\s*failed\b/im.test(result.summary);
    let status: RunStatus;
    switch (result.status) {
        case "completed":
            status = serious || checkFailed ? "failed" : "succeeded";
            break;
        case "max-turns":
            status = "failed";
            break;
        case "cancelled":
            status = "cancelled";
            break;
        default:
            status = "error";
    }
    return {
        status,
        summary: agentSummaryLine(result, findings.length),
        findings,
        answer: result.summary.trim() === "" ? null : result.summary,
        model: result.model ?? null,
        notes: [...(result.notes ?? [])],
        record: result,
    };
}

/** One line for the terminal and the journal. */
export function agentSummaryLine(result: AgentRunResult, findings = 0): string {
    const who = `${result.role} agent`;
    switch (result.status) {
        case "skipped":
            return `Cannot run the ${who}: ${result.reason ?? "skipped"}`;
        case "denied":
            return `The ${who} was not run: ${result.reason ?? "denied"}`;
        case "error":
            return `The ${who} failed: ${result.reason ?? "unknown error"}`;
        case "cancelled":
            return "Cancelled";
        default:
            break;
    }
    const parts = [`${result.status === "max-turns" ? `The ${who} stopped after ${result.turns} turns` : `The ${who} finished`}`];
    parts.push(`${result.toolCalls.length} tool call${result.toolCalls.length === 1 ? "" : "s"}`);
    if (findings > 0) parts.push(`${findings} finding${findings === 1 ? "" : "s"}`);
    if (result.changes.length > 0) {
        const n = result.changes.length;
        const what = `${n} change${n === 1 ? "" : "s"}`;
        if (result.safety?.dryRun) parts.push(`${what} proposed (dry run)`);
        else if (result.worktree) parts.push(`${what} on ${result.worktree.branch}`);
        else parts.push(`${what} applied`);
    }
    return parts.join("; ");
}
