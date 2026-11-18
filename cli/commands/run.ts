// `tyr run "<prompt>"` — ask Tyr to do something now (PLANNING.md 2.13).
//
// Wiring only: engine/intent.ts routes the prompt, engine/run.ts does the
// work and records it (journal, state.json, a `run` report). This file turns
// the progress callbacks into terminal output.
//
// `--agent <role>` (PLANNING.md 2.14) skips routing and runs a tool-using
// agent from cli/agents/ on the prompt; engine/run.ts records it like any
// other route. Safety flags (--apply, --isolate, --yes) go through
// resolveRunSafety (cli/agents/safety.ts): dry-run unless --apply.
//
// Output contract:
//   - text: one progress line per check or review step, the model's answer
//     streamed as it arrives, then findings, notes, a summary line and the
//     report path. --quiet keeps only the answer and problems.
//   - --json: quiet text (only warnings and errors, on stderr) and exactly
//     one object on stdout, the RunResult (versioned by `runVersion`). The
//     answer to a question is in the result, not streamed.
//
// Exit codes (core/errors.ts): OK when the run succeeded, FAILURE when a
// check failed, the review found errors, or the run could not be done (no
// checks configured, no API key), NOT_INITIALIZED without .tyr/tyr.json,
// CONFIG when tyr.json is unusable.

import { Command, Option } from "commander";
import { agentRouteOutcome, runAgent, type AgentEvent } from "../agents/agent.js";
import { AGENT_ROLE_IDS, type AgentRoleId, type AgentRunResult } from "../agents/model.js";
import { getRole } from "../agents/roles.js";
import { createTerminalPrompter, resolveRunSafety } from "../agents/safety.js";
import { findProjectRoot } from "../core/discovery.js";
import { EXIT_CODES, TyrError } from "../core/errors.js";
import { printJson, readGlobals, verbosityOf } from "../core/globals.js";
import type { Finding } from "../core/reports.js";
import { loadConfig } from "../core/scaffold.js";
import { describeIntent, RUN_MODES, type RunMode } from "../engine/intent.js";
import { formatDuration } from "../engine/executor.js";
import { executeRun, type RunAgentDelegate, type RunResult } from "../engine/run.js";
import { canPrompt } from "../ui/prompt.js";
import { createReporter, detectColor, paint, SGR } from "../ui/reporter.js";
import type { TaskHandle } from "../core/types.js";
import * as path from "node:path";

/** Findings listed after a run; --verbose lists them all. */
const MAX_LISTED_FINDINGS = 10;

interface CommandOptions {
    mode?: RunMode;
    llm?: boolean;
    color?: boolean;
    agent?: AgentRoleId;
    apply?: boolean;
    isolate?: boolean;
    yes?: boolean;
    correct?: boolean;
}

/** Characters of a tool input shown in a progress line. */
const MAX_TOOL_LABEL_CHARS = 80;

export function registerRunCommand(program: Command) {
    program
        .command("run")
        .description("Ask Tyr to do something now: run checks, review changes, or answer a question")
        .argument("<prompt>", "What you want Tyr to do, in plain language")
        .addOption(new Option("--mode <mode>", "Skip the guess and force the route").choices([...RUN_MODES]))
        .option("--no-llm", "Never ask the model during a review (diff rules only)")
        .addOption(new Option("--agent <role>", "Run a tool-using agent on the prompt instead of routing it").choices([...AGENT_ROLE_IDS]))
        .option("--apply", "With --agent fixer: make the changes (default: a dry run that only describes them)")
        .option("--isolate", "With --agent: work in a new git worktree on a tyr/ branch, never in your working tree")
        .option("-y, --yes", "With --agent fixer --apply: apply changes in place without asking")
        .option("--correct", "With --agent: queue the agent's summary for the live Claude Code session")
        .option("--no-color", "Disable colored output")
        .addHelpText("after", `
The prompt is routed by keywords (use --mode to override):
  checks   "run the tests", "lint", "check everything"
           Runs those checks now. Every check also runs the review, like
           the background process does after a change.
  review   "review my changes", "review the last commit"
           Diff rules (secrets, deleted tests, risky patterns), plus the
           model when an API key is set.
  ask      anything else, e.g. "why is the build failing?"
           The model answers from what Tyr knows: check results and failing
           output, open findings, recent commits and the uncommitted diff.
           Needs an API key (ai.apiKey, TYR_API_KEY or ANTHROPIC_API_KEY).
           It sees that snapshot only; --agent reviewer is the version that
           opens files and searches the code itself.

Agents (--agent <role>, never picked by keywords; need an API key):
  reviewer     reads the code and reports problems with path:line; never edits
  test-runner  runs the configured checks and diagnoses failures; never edits
  fixer        makes the smallest fix and re-runs the checks to verify it
The fixer is a dry run unless --apply: it shows the changes it would make.
With --apply it asks before each change (--yes: don't ask), or with
--isolate it works on a new tyr/ branch in .tyr/worktrees/ and leaves your
working tree alone. Without a terminal, --apply needs --yes or --isolate.
"tyr agents list" and "tyr agents clean" manage those worktrees.

Every run is journaled (tyr watch shows it), counted in state.json and
saved as a report in .tyr/reports/.

Exit codes: 0 when the run succeeded; 1 when a check failed, the review
found errors, or the run could not be done; 3 when the project is not
initialized; 4 when .tyr/tyr.json is unusable.

Examples:
  $ tyr run "run the tests"
  $ tyr run "check everything"
  $ tyr run "review my last commit"
  $ tyr run "why is the build failing?"
  $ tyr run --mode ask "lint"          Ask about linting instead of running it
  $ tyr run "run all checks" --json | jq .status
  $ tyr run --agent reviewer "review my changes"
  $ tyr run --agent test-runner "why does the test check fail?"
  $ tyr run --agent fixer "fix the failing typecheck"           Dry run
  $ tyr run --agent fixer --apply --isolate "fix the failing tests"`)
        .action(async (prompt: string, options: CommandOptions, command: Command) => {
            const globals = readGlobals(command);
            const verbosity = verbosityOf(globals);
            const json = globals.json === true;
            const out = json ? process.stderr : process.stdout;
            const color = options.color === false ? false : detectColor(out);
            const reporter = createReporter({ verbosity, color, stream: out });

            if (prompt.trim() === "") {
                throw new TyrError("The prompt is empty.", { exitCode: EXIT_CODES.USAGE, hint: 'Say what to do, e.g. tyr run "run the tests"' });
            }
            validateAgentFlags(options);
            const root = await findProjectRoot();
            const config = await loadConfig(root);
            if (config.missing) {
                throw new TyrError(`Tyr is not initialized in ${root}.`, { exitCode: EXIT_CODES.NOT_INITIALIZED, hint: 'Run "tyr init" first.' });
            }
            if (config.value === null) {
                throw new TyrError(`.tyr/tyr.json cannot be used: ${config.errors.join("; ")}`, {
                    exitCode: EXIT_CODES.CONFIG,
                    hint: 'Fix the file, or run "tyr init --force" to rebuild it.',
                });
            }

            let task: TaskHandle | null = null;
            let streamed = false;
            const dim = (text: string) => paint(text, SGR.dim, color);

            let agent: RunAgentDelegate | undefined;
            if (options.agent) {
                const role = getRole(options.agent)!;
                const interactive = canPrompt({ json });
                const safety = resolveRunSafety({
                    role,
                    apply: options.apply === true,
                    isolate: options.isolate === true,
                    yes: options.yes === true,
                    interactive,
                });
                const prompter = createTerminalPrompter({ isInteractive: () => interactive });
                const onEvent = (event: AgentEvent): void => {
                    switch (event.type) {
                        case "start":
                            reporter.info(dim(`Running the ${event.role} agent with ${event.model}: ${safety.explanation}.`));
                            break;
                        case "worktree":
                            reporter.info(
                                dim(
                                    `Working in ${path.relative(process.cwd(), event.path) || event.path} on ${event.branch}` +
                                        (event.carried > 0 ? ` (${event.carried} uncommitted file${event.carried === 1 ? "" : "s"} copied in)` : "") +
                                        ".",
                                ),
                            );
                            break;
                        case "turn":
                            reporter.debug(`turn ${event.turn}`);
                            break;
                        case "tool-call": {
                            const label = toolLabel(event.tool, event.input);
                            // An approval question must not race a spinner for the line.
                            if (safety.approval === "ask" && (event.tool === "edit_file" || event.tool === "write_file")) {
                                reporter.info(label);
                                task = null;
                            } else {
                                task = reporter.task(label);
                            }
                            break;
                        }
                        case "tool-result": {
                            const handle = task as TaskHandle | null;
                            task = null;
                            const label = `${event.tool}: ${clip(event.preview, MAX_TOOL_LABEL_CHARS)}`;
                            if (handle === null) {
                                if (event.isError) reporter.warn(label);
                            } else if (event.isError) handle.fail(label);
                            else handle.succeed();
                            break;
                        }
                        default:
                            break;
                    }
                };
                agent = {
                    role: role.id,
                    run: async (taskText, signal) => {
                        const outcome = await runAgent(
                            root,
                            { role: role.id, task: taskText, dryRun: safety.dryRun, isolate: safety.isolate, approval: safety.approval },
                            {
                                prompter,
                                onEvent,
                                explanation: safety.explanation,
                                ...(options.correct === true ? { correct: true } : {}),
                                ...(signal ? { signal } : {}),
                            },
                        );
                        return agentRouteOutcome(outcome);
                    },
                };
            }

            const result = await executeRun(root, prompt, {
                ...(agent ? { agent } : {}),
                ...(options.mode ? { mode: options.mode } : {}),
                ...(options.llm === false ? { llm: false } : {}),
                onIntent: (intent) => reporter.info(dim(`Tyr will ${describeIntent(intent)}.`)),
                onCheckStart: (start) => {
                    task = reporter.task(`${start.kind}: ${start.command}`);
                },
                onCheckDone: (run) => {
                    const took = formatDuration(run.durationMs);
                    const handle = task ?? reporter.task(run.kind);
                    task = null;
                    if (run.outcome === "passed") handle.succeed(`${run.kind} passed (${took})`);
                    else if (run.outcome === "failed") handle.fail(`${run.kind} failed with exit code ${run.exitCode ?? "?"} (${took})`);
                    else handle.fail(`${run.kind}: ${run.outcome}${run.error ? ` (${run.error})` : ""}`);
                },
                onCheckSkip: (kind, reason) => reporter.muted(`${kind} skipped: ${reason}`),
                onReviewStart: (info) => {
                    task = reporter.task(`Reviewing ${info.scope}${info.llm ? " with the diff rules and the model" : ""}...`);
                },
                onAskStart: (info) => {
                    reporter.info(dim(`Asking ${info.model} (${Math.max(1, Math.round(info.contextBytes / 1024))} KB of context)...`));
                    if (!json) reporter.blank();
                },
                onText: (text) => {
                    // The answer is the product: printed even under --quiet, never into --json's stdout.
                    if (json) return;
                    streamed = true;
                    process.stdout.write(text);
                },
            });
            if (streamed) process.stdout.write(result.answer?.endsWith("\n") ? "\n" : "\n\n");
            const pending = task as TaskHandle | null;
            if (pending !== null) {
                if (result.status === "failed") pending.fail();
                else pending.succeed();
            }
            if (result.intent.mode === "agent" && result.agent !== null) {
                printAgentResult(reporter, result.agent as AgentRunResult, result.answer, { json, verbose: verbosity === "verbose", color });
            }

            printFindings(reporter, result.findings, verbosity === "verbose", color);
            for (const note of result.notes) reporter.warn(note);
            if (result.status === "succeeded") reporter.success(result.summary);
            else if (result.status === "cancelled") reporter.warn(result.summary);
            else reporter.error(result.summary);
            if (result.report) reporter.muted(`Report: ${path.relative(process.cwd(), result.report.mdFile) || result.report.mdFile}`);
            reporter.stop();

            if (json) printJson(result);
            const exitCode = runExitCode(result);
            if (exitCode !== EXIT_CODES.OK) process.exitCode = exitCode;
        });
}

/** Usage errors for flags that only mean something with --agent. */
function validateAgentFlags(options: CommandOptions): void {
    if (options.agent && options.mode) {
        throw new TyrError("--agent and --mode cannot be used together.", {
            exitCode: EXIT_CODES.USAGE,
            hint: "--agent runs an agent on the prompt; --mode picks one of the built-in routes.",
        });
    }
    if (options.agent) return;
    const stray = (["apply", "isolate", "yes", "correct"] as const).filter((flag) => options[flag] === true);
    if (stray.length > 0) {
        throw new TyrError(`${stray.map((flag) => `--${flag}`).join(", ")} only ${stray.length === 1 ? "works" : "work"} with --agent.`, {
            exitCode: EXIT_CODES.USAGE,
            hint: 'e.g. tyr run --agent fixer --apply --isolate "fix the failing tests"',
        });
    }
}

/** The agent's answer, its changes and where they are. */
function printAgentResult(
    reporter: ReturnType<typeof createReporter>,
    agent: AgentRunResult,
    answer: string | null,
    options: { json: boolean; verbose: boolean; color: boolean },
): void {
    // The final text is the product: printed even under --quiet, never into --json's stdout.
    if (!options.json && answer !== null) {
        reporter.blank();
        process.stdout.write(answer.endsWith("\n") ? answer : `${answer}\n`);
        reporter.blank();
    }
    if (agent.changes.length > 0) {
        const dryRun = agent.safety?.dryRun === true;
        const heading = dryRun
            ? "Proposed changes (dry run; nothing was written, --apply makes them)"
            : agent.worktree
              ? `Changes on ${agent.worktree.branch}`
              : "Changes applied";
        reporter.info(paint(`${heading} (${agent.changes.length})`, SGR.bold, options.color));
        for (const change of agent.changes) {
            reporter.info(`  ${change.path}: ${change.summary}`);
            if (options.verbose && change.patch) {
                for (const line of change.patch.replace(/\n$/, "").split("\n")) reporter.info(paint(`    ${line}`, SGR.dim, options.color));
            }
        }
        if (dryRun && !options.verbose) reporter.muted("--verbose shows each patch");
    }
    if (agent.worktree) {
        const where = path.relative(process.cwd(), agent.worktree.path) || agent.worktree.path;
        reporter.info(`Worktree: ${where} (branch ${agent.worktree.branch})`);
        reporter.muted(`Review: git -C "${where}" diff   (only the agent's changes; yours are staged there)`);
        reporter.muted(`Take them: git -C "${where}" diff | git apply   (from the repository root)`);
        reporter.muted("Remove it: tyr agents clean");
    }
    const refused = agent.safety?.refusals ?? [];
    if (refused.length > 0) {
        reporter.warn(`The safety gate refused ${refused.length} action${refused.length === 1 ? "" : "s"}:`);
        for (const r of refused.slice(0, MAX_LISTED_FINDINGS)) reporter.info(`  ${r.tool}${r.path ? ` ${r.path}` : ""}: ${r.reason}`);
    }
    if (agent.usage) {
        reporter.debug(`${agent.turns} turn${agent.turns === 1 ? "" : "s"}, ${agent.usage.inputTokens} input / ${agent.usage.outputTokens} output tokens`);
    }
}

/** "read_file src/a.ts", "run_check test", "search TODO". Exported for tests. */
export function toolLabel(tool: string, input: unknown): string {
    const fields = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const pick = ["path", "kind", "check", "pattern", "glob", "dir"].map((key) => fields[key]).find((v) => typeof v === "string");
    return clip(pick === undefined ? tool : `${tool} ${String(pick)}`, MAX_TOOL_LABEL_CHARS);
}

function clip(text: string, max: number): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length <= max ? flat : `${flat.slice(0, max - 3)}...`;
}

function printFindings(
    reporter: ReturnType<typeof createReporter>,
    findings: readonly Finding[],
    verbose: boolean,
    color: boolean,
): void {
    if (findings.length === 0) return;
    const shown = verbose ? findings : findings.slice(0, MAX_LISTED_FINDINGS);
    reporter.blank();
    reporter.info(paint(`Findings (${findings.length})`, SGR.bold, color));
    for (const finding of shown) {
        const where = finding.file ? ` ${finding.file}${finding.line !== undefined ? `:${finding.line}` : ""}` : "";
        const rule = finding.rule ? paint(` [${finding.rule}]`, SGR.dim, color) : "";
        const severity = paint(finding.severity.padEnd(8), severityColor(finding.severity), color);
        reporter.info(`  ${severity}${where} ${finding.title}${rule}`);
    }
    if (shown.length < findings.length) reporter.info(paint(`  +${findings.length - shown.length} more (--verbose shows all)`, SGR.dim, color));
    reporter.blank();
}

function severityColor(severity: Finding["severity"]): string {
    return severity === "critical" || severity === "error" ? SGR.red : severity === "warning" ? SGR.yellow : SGR.dim;
}

/** The exit code for a finished run. Exported for tests. */
export function runExitCode(result: Pick<RunResult, "status">): number {
    switch (result.status) {
        case "succeeded":
            return EXIT_CODES.OK;
        case "cancelled":
            return EXIT_CODES.INTERRUPTED;
        default:
            return EXIT_CODES.FAILURE;
    }
}
