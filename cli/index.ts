#!/usr/bin/env node

import {Command} from "commander";

//import * as fs from "fs";
//import * as path from "path";
import figlet from "figlet";
import { registerInitCommand } from "./commands/init.js";
import { registerStartCommand } from "./commands/start.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerWatchCommand } from "./commands/watch.js";
import { registerRunCommand } from "./commands/run.js";
import { TYR_VERSION } from "./core/version.js";

const program = new Command();

console.log(figlet.textSync("Tyr"));
console.log();

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

Run "tyr <command> --help" for details and examples for a command.`);


registerInitCommand(program);
registerStartCommand(program);
registerWatchCommand(program);
registerStatusCommand(program);
registerRunCommand(program);

program.parse();
