// init command

import { Command } from "commander";
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
        .action(() => {
            console.log("Starting the process...");
        });
}