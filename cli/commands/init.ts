// init command

import { Command } from "commander";
import * as fs from "fs/promises";
import * as path from "path";
import {exec} from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);


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
        .description("Initializes the Tyr project...")
        .option("-s, --start", "Initialize and start the process")
        .action(async (options) => {
                    
            const root = await findProjectRoot();
            const tyrPath = path.join(root, ".tyr");

            //Check if already initialized
            try {
                await fs.access(tyrPath);
                console.log("⚠️ Project is already initialized! (.tyr folder exists)");
                
                if(options.start){
                    console.log("Starting the process...");
                }
                return;
            } catch(error){
                
            }

            console.log("Initializing Project ...");
            const files = await getFilesRecursive(root);
            console.log(`Found ${files.length} files:`);
            
            // Note: Added an await here since readFile is async
            for (const file of files) {
                await readFile(path.resolve(root, file)); 
            }
            
            await createTyrDirectory(root);
            await detectGitRepository(root);
            
            if(options.start){
                console.log("Starting the process...");
            }
        })
}


async function findProjectRoot() {
    try {
      // Destructure stdout from the returned object
      const { stdout } = await execAsync('git rev-parse --show-toplevel');
      
      // Trim the trailing newline character (\n) from the path string
      return stdout.trim(); 
    } catch (error) {
      console.error('Error finding root directory', error);
      return process.cwd(); // Return a fallback so the calling code knows it failed
    }
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


async function detectGitRepository(root: string){
    
    try {
        // Executes the command in the specified directory
        await execAsync('git rev-parse --is-inside-work-tree', { cwd: root });
        return true;
      } catch (error) {
        // If the command fails, it's not a git repository (or git isn't installed)
        return false;
    }
}

async function createTyrDirectory(root: string){
    const dirPath = path.join(root, ".tyr");
    try {
        await fs.mkdir(dirPath, { recursive: true });
    } catch(error) {
        console.error('Error creating directory:', error);
    }
}