// `tyr status` — what Tyr knows about this project (PLANNING.md 2.12).
//
// Wiring only: core/status.ts collects the StatusReport (it never throws) and
// ui/status-view.ts renders it.
//
// Output contract:
//   - text: the rendered report on stdout. Under --quiet only problems are
//     printed: "not initialized" as an error and each collection warning.
//   - --json: the StatusReport verbatim (its fields are a public contract,
//     versioned by `statusVersion`), for initialized and uninitialized
//     projects alike. Nothing else goes to stdout.
//
// Exit codes (core/errors.ts): OK when the project is initialized, whatever
// its findings or warnings (status reports, it does not judge);
// NOT_INITIALIZED when there is no .tyr/tyr.json; CONFIG when tyr.json
// exists but cannot be used, since `tyr init` blindly is not the fix.

import { Command } from "commander";
import { findProjectRoot } from "../core/discovery.js";
import { EXIT_CODES, type ExitCode } from "../core/errors.js";
import { printJson, readGlobals, verbosityOf } from "../core/globals.js";
import { collectStatus, type StatusReport } from "../core/status.js";
import { createReporter, detectColor, detectUnicode } from "../ui/reporter.js";
import { renderStatus } from "../ui/status-view.js";

/** Findings and reports collected under --verbose (the renderer lists them all). */
const VERBOSE_MAX_FINDINGS = 50;
const VERBOSE_RECENT_REPORTS = 10;

interface CommandOptions {
    scan?: boolean;
    color?: boolean;
}

export function registerStatusCommand(program: Command) {
    program
        .command("status")
        .description("Show what Tyr knows about this project and what it is doing")
        .option("--no-scan", "Skip the file scan used to measure drift since the last index (faster)")
        .option("--no-color", "Disable colored output")
        .addHelpText("after", `
Summarizes everything recorded in .tyr/: the project profile from "tyr init",
whether the background process is running, the last run and report, the
latest check results and open problems, open findings by severity, and how
far the repository has drifted (new commits, added or removed files) since it
was last indexed. Nothing is changed.

--verbose lists every configured command, more findings, the check commands
and recent reports. --quiet prints only problems (not initialized, warnings).

Exit codes: 0 when the project is initialized (even with open findings),
3 when it is not ("tyr init" first), 4 when .tyr/tyr.json is unusable.

Examples:
  $ tyr status
  $ tyr status --verbose            Everything, including recent reports
  $ tyr status --no-scan            Skip the file scan (HEAD drift only)
  $ tyr status --json | jq .findings.counts
  $ tyr --cwd ../api status         Another project`)
        .action(async (options: CommandOptions, command: Command) => {
            const globals = readGlobals(command);
            const verbosity = verbosityOf(globals);
            const verbose = verbosity === "verbose";
            const root = await findProjectRoot();
            const report = await collectStatus(root, {
                scanFiles: options.scan !== false,
                ...(verbose ? { maxFindings: VERBOSE_MAX_FINDINGS, recentReports: VERBOSE_RECENT_REPORTS } : {}),
            });

            if (globals.json) {
                printJson(report);
            } else {
                const color = options.color === false ? false : detectColor(process.stdout);
                if (verbosity === "quiet") {
                    // `status --quiet` *is* the problem list: it stays on stdout with the
                    // rest of the report instead of moving to stderr like other warnings.
                    const reporter = createReporter({ verbosity, color, animate: false, errorStream: process.stdout });
                    if (!report.initialized) {
                        reporter.error(`Tyr is not initialized in ${report.root}; run "${report.suggestion}"`);
                    } else {
                        for (const warning of report.warnings) reporter.warn(warning.message);
                    }
                } else {
                    const lines = renderStatus(report, { color, verbose, unicode: detectUnicode() });
                    process.stdout.write(lines.join("\n") + "\n");
                }
            }

            const exitCode = statusExitCode(report);
            if (exitCode !== EXIT_CODES.OK) process.exitCode = exitCode;
        });
}

/** The exit code for a collected report. Exported for tests. */
export function statusExitCode(report: StatusReport): ExitCode {
    if (!report.initialized) return EXIT_CODES.NOT_INITIALIZED;
    if (report.project === null) return EXIT_CODES.CONFIG;
    return EXIT_CODES.OK;
}
