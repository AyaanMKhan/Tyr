// init command

import { Command } from "commander";
//import * as fs from "fs";
//import * as path from "path";


export function registerRunCommand(program: Command){
    program
        .command("run")
        .description("Explicitly tell Tyr to perform something")
        .argument("<prompt>", "What you want Tyr to do, in plain language")
        .addHelpText("after", `
Examples:
  $ tyr run "review my last commit"
  $ tyr run "why is the build failing?"`)
        .action((prompt: string) => {
            console.log(`Running the user command... ${prompt}`);
        });
}