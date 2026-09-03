// init command

import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";


const program = new Command();

program.command("init")
    .description("Initializes the Tyr project, will scan and read files of your project and be ready to help")
    .argument("-s", "Inititalize and start the process");