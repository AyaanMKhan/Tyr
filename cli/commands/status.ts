import { Command } from "commander";
import { reportPlaceholder } from "./placeholder.js";
//import * as fs from "fs";
//import * as path from "path";


export function registerStatusCommand(program: Command){
    program
        .command("status")
        .description("Tells user what Tyr knows / is doing")
        .addHelpText("after", `
Reports the state recorded in .tyr/ and whether the background process is running.

Examples:
  $ tyr status`)
        .action((_options, command: Command) => {
            reportPlaceholder(command, "Status of Project ...");
        })
}