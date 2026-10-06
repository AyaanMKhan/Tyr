#!/usr/bin/env node

import {Command} from "commander";

//import * as fs from "fs";
//import * as path from "path";
import { bannerText, isInteractive, printBanner } from "./ui/banner.js";
import { registerInitCommand } from "./commands/init.js";
import { registerStartCommand } from "./commands/start.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerWatchCommand } from "./commands/watch.js";
import { registerRunCommand } from "./commands/run.js";
import { TYR_VERSION } from "./core/version.js";

const program = new Command();

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

Run "tyr <command> --help" for details and examples for a command.`)
    // Help is written to stderr when it accompanies an error, so check
    // whichever stream it is actually going to.
    .addHelpText("beforeAll", ({ error }) =>
        isInteractive(error ? process.stderr : process.stdout) ? bannerText() : "",
    )
    // Runs only once parsing succeeded and a command action is about to run,
    // so `--version` and usage errors never print the banner.
    .hook("preAction", () => printBanner());


registerInitCommand(program);
registerStartCommand(program);
registerWatchCommand(program);
registerStatusCommand(program);
registerRunCommand(program);

program.parse();
