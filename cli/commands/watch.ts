// init command

import { Command } from "commander";
//import * as fs from "fs";
//import * as path from "path";


export function registerWatchCommand(program: Command){
    program
        .command("watch")
        .description("Allows user to see the progress Tyr is making")
        .addHelpText("after", `
Streams what the background process is doing until you press Ctrl-C.

Examples:
  $ tyr watch`)
        .action(() => {
            console.log("Watching Project ...");
        })
}