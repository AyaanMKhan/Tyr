// `tyr run "<prompt>"` — ask Tyr to do something now (PLANNING.md 2.13).
//
// Wiring only: engine/intent.ts routes the prompt, engine/run.ts does the
// work and records it (journal, state.json, a `run` report). This file turns
// the progress callbacks into terminal output.
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
import { findProjectRoot } from "../core/discovery.js";
import { EXIT_CODES, TyrError } from "../core/errors.js";
import { printJson, readGlobals, verbosityOf } from "../core/globals.js";
import type { Finding } from "../core/reports.js";
import { loadConfig } from "../core/scaffold.js";
import { describeIntent, RUN_MODES, type RunMode } from "../engine/intent.js";
import { formatDuration } from "../engine/executor.js";
import { executeRun, type RunResult } from "../engine/run.js";
import { createReporter, detectColor, paint, SGR } from "../ui/reporter.js";
import type { TaskHandle } from "../core/types.js";
import * as path from "node:path";

/** Findings listed after a run; --verbose lists them all. */
const MAX_LISTED_FINDINGS = 10;

interface CommandOptions {
    mode?: RunMode;
    llm?: boolean;
    color?: boolean;
}

export function registerRunCommand(program: Command) {
    program
        .command("run")
        .description("Ask Tyr to do something now: run checks, review changes, or answer a question")
        .argument("<prompt>", "What you want Tyr to do, in plain language")
        .addOption(new Option("--mode <mode>", "Skip the guess and force the route").choices([...RUN_MODES]))
        .option("--no-llm", "Never ask the model during a review (diff rules only)")
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
  $ tyr run "run all checks" --json | jq .status`)
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
            const result = await executeRun(root, prompt, {
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
