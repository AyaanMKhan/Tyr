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

const program = new Command();

console.log(figlet.textSync("Tyr"));
console.log();

program
    .name("Tyr")
    .version("1.0.0", "-v, --version", "Output version of Tyr");


registerInitCommand(program);
registerStartCommand(program);
registerWatchCommand(program);
registerStatusCommand(program);
registerRunCommand(program);

program.parse();
