import {Command} from "commander";

import * as fs from "fs";
import * as path from "path";
import figlet from "figlet";

const program = new Command();

console.log(figlet.textSync("Tyr"));

console.log()
program
    .name("Tyr")
    .version("1.0.0");


program.parse();
