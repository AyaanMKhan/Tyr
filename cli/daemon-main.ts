// Entry point of Tyr's background process, spawned by `startDaemon()` in
// cli/core/daemon.ts as `node daemon-main.js <project root>`.
//
// A separate entry rather than a hidden `tyr __daemon` command: the daemon
// needs none of commander, the banner or the global-option hooks, and keeping
// it out of cli/index.ts means `tyr --help` can never leak it.

import { runDaemon } from "./core/daemon.js";

const root = process.argv[2];
if (root === undefined || root === "") {
    process.stderr.write("usage: daemon-main.js <project root>\n");
    process.exit(2);
}

// runDaemon installs its own crash handlers; this catches a failure before then.
runDaemon(root).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
});
