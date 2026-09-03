// -v, -version?


import {Command} from "commander";

import * as fs from "fs";
import * as path from "path";
import figlet from "figlet";

const program = new Command();


program.option("-v, -version", "Version");


program.parse();