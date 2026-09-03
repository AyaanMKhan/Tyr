// init command

import { Command } from "commander";
//import * as fs from "fs";
//import * as path from "path";


export function registerStartCommand(program: Command){
    program
        .command("start")
        .description("Starts Tyr")
        .action(() => {
            console.log("Starting the process...");
        });
}