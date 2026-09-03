// init command

import { Command } from "commander";
//import * as fs from "fs";
//import * as path from "path";


export function registerInitCommand(program: Command){
    program
        .command("init")
        .description("Initializes the Tyr project, will scan and read files of your project and be ready to help")
        .option("-s. --start", "Initialize and start the process")
        .action((options) => {
            console.log("Initialiazing Project ...");
            if(options.start){
                console.log("Starting the process...");
            }
        })
}