// init command

import { Command } from "commander";
//import * as fs from "fs";
//import * as path from "path";


export function registerRunCommand(program: Command){
    program
        .command("run <prompt>")
        .description("Explicitly tell Tyr to perform something")
        .action((prompt: string) => {
            console.log(`Running the user command... ${prompt}`);
        });
}