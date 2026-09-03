// init command

import { Command } from "commander";
//import * as fs from "fs";
//import * as path from "path";


export function registerWatchCommand(program: Command){
    program
        .command("watch")
        .description("Allows user to see the progress Tyr is making")
        
        .action(() => {
            console.log("Watching Project ...");
        })
}