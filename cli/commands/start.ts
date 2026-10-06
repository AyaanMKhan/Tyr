// init command

import { Command } from "commander";
import { reportPlaceholder } from "./placeholder.js";
//import * as fs from "fs";
//import * as path from "path";


export function registerStartCommand(program: Command){
    program
        .command("start")
        .description("Starts Tyr")
        .addHelpText("after", `
Launches Tyr's background process for the current project. Run "tyr init" first.

Examples:
  $ tyr start`)
        .action((_options, command: Command) => {
            reportPlaceholder(command, "Starting the process...");
        });
}