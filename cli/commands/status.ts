import { Command } from "commander";
//import * as fs from "fs";
//import * as path from "path";


export function registerStatusCommand(program: Command){
    program
        .command("status")
        .description("Tells user what Tyr knows / is doing")
        .action(() => {
            console.log("Status of Project ...");
        })
}