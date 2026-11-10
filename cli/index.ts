#!/usr/bin/env node

import {Command} from "commander";

//import * as fs from "fs";
//import * as path from "path";
import { bannerText, isInteractive, printBanner, wantsBanner } from "./ui/banner.js";
import { registerInitCommand } from "./commands/init.js";
import { registerStartCommand } from "./commands/start.js";
import { registerStopCommand } from "./commands/stop.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerWatchCommand } from "./commands/watch.js";
import { registerRunCommand } from "./commands/run.js";
import { registerConfigCommand } from "./commands/config.js";
import { TYR_VERSION } from "./core/version.js";
import { readGlobals, registerGlobalOptions } from "./core/globals.js";
import { runCli } from "./core/fatal.js";

const program = new Command();

registerGlobalOptions(program);

program
    .name("tyr")
    .description("A background engineering manager and reviewer for your repository.")
    .version(TYR_VERSION, "-v, --version", "Output version of Tyr")
    .addHelpText("after", `
Typical workflow:
  $ tyr init          Inspect the repo and create .tyr/
  $ tyr start         Launch the background process
  $ tyr watch         Follow what Tyr is doing
  $ tyr status        See what Tyr knows
  $ tyr config        See (and change) Tyr's settings
  $ tyr stop          Stop the background process

Global options work with every command:
  $ tyr --cwd ../api status       Act on another directory
  $ tyr init --quiet              Only print warnings and errors
  $ tyr init --json | jq .root    Machine-readable output
  $ tyr start --log-level debug   Write debug detail to .tyr/logs/tyr.log

Run "tyr <command> --help" for details and examples for a command.`)
    // Help is written to stderr when it accompanies an error, so check
    // whichever stream it is actually going to.
    .addHelpText("beforeAll", ({ error }) =>
        isInteractive(error ? process.stderr : process.stdout) ? bannerText() : "",
    )
    // Runs only once parsing succeeded and a command action is about to run,
    // so `--version` and usage errors never print the banner. `--quiet` and
    // `--json` keep stdout free of decoration, and so do commands whose
    // stdout is data (`tyr config`).
    .hook("preAction", (_root, action) => {
        const { quiet, json } = readGlobals(action);
        if (!quiet && !json && wantsBanner(action)) {
            printBanner();
        }
    });


registerInitCommand(program);
registerStartCommand(program);
registerStopCommand(program);
registerWatchCommand(program);
registerStatusCommand(program);
registerRunCommand(program);
registerConfigCommand(program);

// parseAsync, not parse: the actions are async, and only an awaited parse
// lets their failures reach the top-level handler instead of surfacing as
// unhandled rejections. runCli also turns commander's usage errors, uncaught
// exceptions and Ctrl-C into the exit codes documented in core/errors.ts.
await runCli(program, { proc: process });
