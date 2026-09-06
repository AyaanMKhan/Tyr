// init command

import { Command } from "commander";
import { mkdir } from "fs/promises";
import * as fs from "fs/promises";
import * as path from "path";




// Directories we never want to walk into when scanning a project.
const IGNORED_DIRS = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    "coverage",
    "__pycache__",
    ".venv",
]);

export async function registerInitCommand(program: Command){
    program
        .command("init")
        .description("Initializes the Tyr project, will scan and read files of your project and be ready to help")
        .option("-s, --start", "Initialize and start the process")
        .action(async (options) => {
            console.log("Initialiazing Project ...");
            const root = process.cwd();
            const files = await getFilesRecursive(root);
            console.log(`Found ${files.length} files:`);
            for (const file of files) {
                readFile(path.relative(root, file));
            }
            createTyrDirectory();
            if(options.start){
                console.log("Starting the process...");
            }
        })
}

async function getFilesRecursive(source: string): Promise<string[]> {
    const entries = await fs.readdir(source, { withFileTypes: true });

    const files: string[] = [];
    const dirs: string[] = [];

    for (const entry of entries) {
        const fullPath = path.join(source, entry.name);
        if (entry.isDirectory()) {
            if (!IGNORED_DIRS.has(entry.name)) {
                dirs.push(fullPath);
            }
        } else if (entry.isFile()) {
            files.push(fullPath);
        }
    }

    // Walk the subdirectories in parallel, then wait for all of them.
    const nested = await Promise.all(dirs.map(dir => getFilesRecursive(dir)));

    return [...files, ...nested.flat()];
}


async function readFile(filePath: string){
    const content = await fs.readFile(filePath, 'utf-8');

    return content;
}


async function createTyrDirectory(){
    const dirPath = path.join(process.cwd(), ".tyr");
    try {
        await mkdir(dirPath, { recursive: true });
        console.log("./tyr file made!");
    } catch(error) {
        console.error('Error creating directory:', error);
    }
}