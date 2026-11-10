// Options accepted by every command: `--cwd`, `--verbose` / `--quiet`,
// `--json` and `--log-level`. They are declared once on the root program and read by each
// command through `optsWithGlobals()`, so no command re-declares them.
//
// TYR_QUIET, TYR_VERBOSE and TYR_JSON stand in for the matching flags (for CI
// and scripts); readGlobals() layers them under the parsed flags, so every
// caller sees flag > env > default. See applyEnvGlobals() in env-settings.ts.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Command, Option } from "commander";
import { applyEnvGlobals } from "./env-settings.js";
import { LOG_LEVEL_ENV, LOG_THRESHOLDS, setLogLevel, type LogThreshold } from "./log.js";

export interface GlobalOptions {
    cwd?: string;
    verbose?: boolean;
    quiet?: boolean;
    json?: boolean;
    logLevel?: LogThreshold;
}

export type Verbosity = "quiet" | "normal" | "verbose";

export function registerGlobalOptions(program: Command): void {
    program
        .option("-C, --cwd <dir>", "Run as if Tyr was started in <dir>")
        .addOption(new Option("--verbose", "Show extra detail").conflicts("quiet"))
        .addOption(new Option("-q, --quiet", "Only print warnings and errors"))
        .option("--json", "Print machine-readable JSON to stdout instead of text")
        .addOption(
            new Option(
                "--log-level <level>",
                `Minimum level written to .tyr/logs/tyr.log (default: $${LOG_LEVEL_ENV} or "info"; --verbose implies "debug")`,
            ).choices(LOG_THRESHOLDS),
        )
        // Applied before any action runs, so every command (and
        // `findProjectRoot()`'s `process.cwd()` default) sees the new directory.
        .hook("preAction", async (_root, action) => {
            const options = readGlobals(action);
            // Report bad TYR_QUIET/TYR_VERBOSE/TYR_JSON values once, here,
            // rather than from every readGlobals() call. stderr, so --json
            // output stays parseable; a bad value is ignored, never fatal.
            for (const warning of applyEnvGlobals(action.optsWithGlobals<GlobalOptions>()).warnings) {
                process.stderr.write(`tyr: warning: ${warning}\n`);
            }
            const { cwd } = options;
            setLogLevel(logLevelOf(options));
            if (cwd !== undefined) {
                await changeDirectory(program, cwd);
            }
        });
}

/** The parsed global flags, with TYR_QUIET / TYR_VERBOSE / TYR_JSON filling in unset ones. */
export function readGlobals(command: Command, env: NodeJS.ProcessEnv = process.env): GlobalOptions {
    return applyEnvGlobals(command.optsWithGlobals<GlobalOptions>(), env).options;
}

/** `--json` implies quiet text output: stdout is reserved for the JSON. */
export function verbosityOf(options: GlobalOptions): Verbosity {
    if (options.quiet || options.json) {
        return "quiet";
    }
    return options.verbose ? "verbose" : "normal";
}

/**
 * The log threshold the command line asks for: `--log-level`, else "debug"
 * under `--verbose`, else undefined so log.ts falls back to TYR_LOG_LEVEL and
 * then "info". `--quiet` / `--json` only affect terminal output, not the log.
 */
export function logLevelOf(options: GlobalOptions): LogThreshold | undefined {
    if (options.logLevel !== undefined) {
        return options.logLevel;
    }
    return options.verbose ? "debug" : undefined;
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
