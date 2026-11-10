// `tyr stop` — stop the background process started by `tyr start`.
//
// Wiring only; the stop protocol (request file, then a hard kill fallback)
// is documented and implemented in cli/core/daemon.ts.

import { Command } from "commander";
import { findProjectRoot } from "../core/discovery.js";
import { stopDaemon, type StopDaemonResult } from "../core/daemon.js";
import { printJson, readGlobals, verbosityOf } from "../core/globals.js";
import { createReporter } from "../ui/reporter.js";
import { EXIT_CODES } from "../core/errors.js";

type StopResult = ({ ok: true; root: string } & StopDaemonResult) | { ok: false; root?: string; error: string };

export function registerStopCommand(program: Command) {
    program
        .command("stop")
        .description("Stop Tyr's background process")
        .addHelpText("after", `
Asks the background process to shut down, waits for it to mark state.json
"stopped" and remove .tyr/state/daemon.pid, and kills it if it does not exit
within a few seconds. Stopping when nothing is running is not an error; a
stale PID file left by a crash is cleaned up.

Examples:
  $ tyr stop
  $ tyr stop --json     Print { ok, root, pid, graceful, staleCleared }`)
        .action(async (_options, command: Command) => {
            const globals = readGlobals(command);
            const reporter = createReporter({
                verbosity: verbosityOf(globals),
                stream: globals.json ? process.stderr : undefined,
            });
            let result: StopResult;
            const task = reporter.task("Stopping background process...");
            try {
                const root = await findProjectRoot();
                const outcome = await stopDaemon(root);
                if (outcome.pid === null) {
                    task.skip(
                        outcome.staleCleared
                            ? "Background process was not running (cleared a stale PID file)"
                            : "Background process is not running",
                    );
                } else if (outcome.graceful) {
                    task.succeed(`Background process stopped (pid ${outcome.pid})`);
                } else {
                    task.succeed(`Background process killed (pid ${outcome.pid}); it did not stop in time`);
                }
                result = { ok: true, root, ...outcome };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                task.fail(`Could not stop the background process: ${message}`);
                result = { ok: false, error: message };
            }
            reporter.stop();
            if (globals.json) {
                printJson(result);
            }
            if (!result.ok) {
                process.exitCode = EXIT_CODES.FAILURE;
            }
        });
}
