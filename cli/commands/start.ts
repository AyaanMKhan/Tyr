// `tyr start` — launch Tyr's background process for the current project.
//
// Wiring only: spawning, duplicate detection and the PID file live in
// cli/core/daemon.ts. `reportDaemonStart()` is exported so `tyr init --start`
// prints exactly the same lines as `tyr start`.

import { Command } from "commander";
import { findProjectRoot } from "../core/discovery.js";
import { readConfig } from "../core/scaffold.js";
import { resolveDaemonPaths, startDaemon } from "../core/daemon.js";
import { printJson, readGlobals, verbosityOf } from "../core/globals.js";
import { createReporter } from "../ui/reporter.js";
import type { Reporter } from "../core/types.js";

/** What `--json` reports about the daemon: also embedded in `tyr init --json`. */
export interface DaemonSummary {
    pid: number;
    alreadyRunning: boolean;
}

type StartResult =
    | { ok: true; root: string; daemon: DaemonSummary }
    | { ok: false; root?: string; error: string };

export function registerStartCommand(program: Command) {
    program
        .command("start")
        .description("Start Tyr's background process")
        .addHelpText("after", `
Launches Tyr's background process for the current project. Run "tyr init" first.
The process runs detached (it survives closing the terminal), records its pid
in .tyr/state/daemon.pid, follows git events into .tyr/logs/tyr.log and marks
state.json "running". Starting twice is harmless: a live process is reported
instead of a second one being spawned. Stop it with "tyr stop".

Examples:
  $ tyr start
  $ tyr start --json    Print { ok, root, daemon: { pid, alreadyRunning } }`)
        .action(async (_options, command: Command) => {
            const globals = readGlobals(command);
            const reporter = createReporter({
                verbosity: verbosityOf(globals),
                stream: globals.json ? process.stderr : undefined,
            });
            const result = await runStart(reporter);
            reporter.stop();
            if (globals.json) {
                printJson(result);
            }
            if (!result.ok) {
                process.exitCode = 1;
            }
        });
}

async function runStart(reporter: Reporter): Promise<StartResult> {
    const root = await findProjectRoot();
    if ((await readConfig(root)) === null) {
        const error = `Tyr is not initialized in ${root}`;
        reporter.error(error);
        reporter.info('Run "tyr init" first (or "tyr init --start" to do both).');
        return { ok: false, root, error };
    }
    const daemon = await reportDaemonStart(reporter, root);
    if (daemon === null) {
        return { ok: false, root, error: "Failed to start the background process" };
    }
    return { ok: true, root, daemon };
}

/**
 * Start the daemon and report the outcome. Never throws: a failure is printed
 * as an error and returned as null, so callers decide the exit code.
 */
export async function reportDaemonStart(reporter: Reporter, root: string): Promise<DaemonSummary | null> {
    const task = reporter.task("Starting background process...");
    try {
        const result = await startDaemon(root);
        if (result.alreadyRunning) {
            task.skip(`Background process already running (pid ${result.pid})`);
        } else {
            task.succeed(`Background process started (pid ${result.pid})`);
            if (result.replacedStale) {
                reporter.debug("Replaced a stale PID file left by a previous process");
            }
            if (!result.ready) {
                reporter.warn(`The process has not confirmed startup yet; check ${resolveDaemonPaths(root).outputFile}`);
            }
        }
        return { pid: result.pid, alreadyRunning: result.alreadyRunning };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        task.fail(`Background process failed to start: ${message}`);
        return null;
    }
}
