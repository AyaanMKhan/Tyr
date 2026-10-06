// Options accepted by every command: `--cwd`, `--verbose` / `--quiet` and
// `--json`. They are declared once on the root program and read by each
// command through `optsWithGlobals()`, so no command re-declares them.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Command, Option } from "commander";

export interface GlobalOptions {
    cwd?: string;
    verbose?: boolean;
    quiet?: boolean;
    json?: boolean;
}

export type Verbosity = "quiet" | "normal" | "verbose";

export function registerGlobalOptions(program: Command): void {
    program
        .option("-C, --cwd <dir>", "Run as if Tyr was started in <dir>")
        .addOption(new Option("--verbose", "Show extra detail").conflicts("quiet"))
        .addOption(new Option("-q, --quiet", "Only print warnings and errors"))
        .option("--json", "Print machine-readable JSON to stdout instead of text")
        // Applied before any action runs, so every command (and
        // `findProjectRoot()`'s `process.cwd()` default) sees the new directory.
        .hook("preAction", async (_root, action) => {
            const { cwd } = readGlobals(action);
            if (cwd !== undefined) {
                await changeDirectory(program, cwd);
            }
        });
}

export function readGlobals(command: Command): GlobalOptions {
    return command.optsWithGlobals<GlobalOptions>();
}

/** `--json` implies quiet text output: stdout is reserved for the JSON. */
export function verbosityOf(options: GlobalOptions): Verbosity {
    if (options.quiet || options.json) {
        return "quiet";
    }
    return options.verbose ? "verbose" : "normal";
}

/** Writes one JSON document to stdout. */
export function printJson(value: unknown): void {
    process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

async function changeDirectory(program: Command, dir: string): Promise<void> {
    const target = path.resolve(dir);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat?.isDirectory()) {
        program.error(`error: --cwd directory does not exist: ${target}`);
    }
    process.chdir(target);
}
