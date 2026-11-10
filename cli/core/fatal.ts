// The CLI's last line of defence: one place that turns any error escaping a
// command, an uncaught exception, an unhandled rejection or Ctrl-C into
// consistent output and an exit code from errors.ts.
//
// The process is injected (`FatalProcess`) so tests can drive every path
// without exiting the test runner. The background process does not use this:
// cli/core/daemon.ts owns its own crash and signal handling, because it has to
// mark state.json and remove its PID file on the way out.

import * as fs from "node:fs/promises";
import { Command } from "commander";
import { findProjectRoot } from "./discovery.js";
import { EXIT_CODES, exitCodeName, formatFatal, isExpectedError, stackOf, type JsonError } from "./errors.js";
import { applyEnvGlobals } from "./env-settings.js";
import { isLogLevelEnabled, writeLog } from "./log.js";
import { resolveTyrPaths } from "./scaffold.js";

/** Environment variable that shows stacks of unexpected errors, like --verbose. */
export const DEBUG_ENV = "TYR_DEBUG";

/** How long logging an unexpected error may delay the exit. */
const DEFAULT_LOG_TIMEOUT_MS = 3000;
/** How long to wait for output to flush before exiting regardless. */
const FLUSH_TIMEOUT_MS = 1000;

export interface FatalStream {
    write(chunk: string, callback?: (error?: Error | null) => void): boolean;
    isTTY?: boolean;
}

/** The slice of `process` the handler uses. */
export interface FatalProcess {
    argv: readonly string[];
    env: Record<string, string | undefined>;
    stdout: FatalStream;
    stderr: FatalStream;
    exitCode?: number | string | null | undefined;
    on(event: "uncaughtException" | "unhandledRejection" | "SIGINT", listener: (error?: unknown) => void): unknown;
    exit(code: number): void;
}

export interface FatalHandlerDeps {
    proc: FatalProcess;
    /**
     * Append an unexpected error to the project's tyr.log. Returns the file
     * written, or null when there is no initialized project. Defaults to
     * `logToProjectLog`. A rejection here is ignored.
     */
    logUnexpected?: (message: string) => Promise<string | null>;
    logTimeoutMs?: number;
}

export interface FatalHandler {
    /**
     * Report `error` and set the exit code. With `exit: true` (uncaught
     * errors, whose process state can no longer be trusted) the process also
     * exits once the output is flushed; otherwise it is left to exit
     * naturally, which never cuts off a write still in flight.
     */
    handle(error: unknown, options?: { exit?: boolean }): Promise<number>;
    /** Ctrl-C: report and exit with INTERRUPTED. */
    interrupt(): void;
}

/** What the command line asked for, read from raw argv so it works even when parsing failed. */
export interface FatalContext {
    json: boolean;
    verbose: boolean;
}

/**
 * `--json` / `--verbose` / `--quiet` from argv (stopping at `--`, after which
 * flags are operands), layered over TYR_JSON / TYR_VERBOSE / TYR_QUIET exactly
 * as readGlobals() does (applyEnvGlobals: flag > env), plus `TYR_DEBUG`. Raw
 * argv rather than commander's parsed options, because a usage error means
 * parsing never finished. Without the env layer, `TYR_JSON=1 tyr --bogus`
 * would print text to a consumer that only reads JSON.
 */
export function readFatalContext(argv: readonly string[], env: Record<string, string | undefined>): FatalContext {
    const args = argv.slice(2);
    const end = args.indexOf("--");
    const flags = end === -1 ? args : args.slice(0, end);
    const flag = (...names: string[]): true | undefined => (names.some((n) => flags.includes(n)) ? true : undefined);
    const { options } = applyEnvGlobals(
        { json: flag("--json"), verbose: flag("--verbose"), quiet: flag("--quiet", "-q") },
        env,
    );
    return {
        json: options.json === true,
        verbose: options.verbose === true || isTruthy(env[DEBUG_ENV]),
    };
}

function isTruthy(value: string | undefined): boolean {
    if (value === undefined) return false;
    const normalized = value.trim().toLowerCase();
    return normalized !== "" && normalized !== "0" && normalized !== "false";
}

/**
 * Default `logUnexpected`: append to `.tyr/logs/tyr.log` of the project
 * containing the current directory (already moved by `--cwd`), but only when
 * that project is initialized. A crash must never be what creates `.tyr/`.
 */
export async function logToProjectLog(message: string): Promise<string | null> {
    if (!isLogLevelEnabled("error")) {
        return null;
    }
    const root = await findProjectRoot();
    const paths = resolveTyrPaths(root);
    const stat = await fs.stat(paths.tyrDir).catch(() => null);
    if (!stat?.isDirectory()) {
        return null;
    }
    await writeLog(paths.logFile, "error", message);
    return paths.logFile;
}

export function createFatalHandler(deps: FatalHandlerDeps): FatalHandler {
    const { proc } = deps;
    const logUnexpected = deps.logUnexpected ?? logToProjectLog;
    const logTimeoutMs = deps.logTimeoutMs ?? DEFAULT_LOG_TIMEOUT_MS;
    let handling = false;

    /** Never rejects and never hangs: logging must not mask the original error. */
    const tryLog = async (error: unknown): Promise<string | null> => {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), logTimeoutMs);
            timer.unref?.();
        });
        try {
            return await Promise.race([logUnexpected(`Unexpected error: ${stackOf(error)}`), timeout]);
        } catch {
            return null;
        } finally {
            clearTimeout(timer);
        }
    };

    const exitAfterFlush = (code: number, writes: Promise<void>): void => {
        // A pipe may never drain (reader gone); exit anyway after a moment.
        const fallback = setTimeout(() => proc.exit(code), FLUSH_TIMEOUT_MS);
        fallback.unref?.();
        void writes.then(() => {
            clearTimeout(fallback);
            proc.exit(code);
        });
    };

    const handle = async (error: unknown, options: { exit?: boolean } = {}): Promise<number> => {
        if (handling) {
            // A second failure while reporting the first (a broken stdout, a
            // throwing logger). Say as little as possible and get out.
            const code = EXIT_CODES.FAILURE;
            proc.exitCode = code;
            try {
                proc.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
            } catch {
                // Nothing left to report to.
            }
            if (options.exit) proc.exit(code);
            return code;
        }
        handling = true;

        const context = readFatalContext(proc.argv, proc.env);
        const logFile = isExpectedError(error) ? null : await tryLog(error);
        const output = formatFatal(error, { ...context, logFile: logFile ?? undefined });
        proc.exitCode = output.exitCode;
        const writes = writeAll(proc, output.stdout, output.stderr);
        if (options.exit) {
            exitAfterFlush(output.exitCode, writes);
        } else {
            await writes;
            handling = false;
        }
        return output.exitCode;
    };

    const interrupt = (): void => {
        const code = EXIT_CODES.INTERRUPTED;
        proc.exitCode = code;
        const { json } = readFatalContext(proc.argv, proc.env);
        let stdout = "";
        let stderr = "";
        if (json) {
            const body: JsonError = {
                ok: false,
                error: { message: "Interrupted", code: exitCodeName(code), exitCode: code },
            };
            stdout = JSON.stringify(body, null, 2) + "\n";
        } else if (proc.stderr.isTTY) {
            // Move the shell prompt off the line holding "^C" (and any
            // half-drawn spinner). The cursor itself is restored by the
            // reporter's own `exit` hook, which process.exit() still fires.
            stderr = "\n";
        }
        exitAfterFlush(code, writeAll(proc, stdout, stderr));
    };

    return { handle, interrupt };
}

/**
 * Create the handler and register it for uncaught exceptions, unhandled
 * rejections and SIGINT. Registered at startup, so it runs before the
 * reporter's own SIGINT hook (which would otherwise re-raise the signal and
 * let the process die without an exit code of our choosing).
 */
export function installFatalHandlers(deps: FatalHandlerDeps): FatalHandler {
    const handler = createFatalHandler(deps);
    deps.proc.on("uncaughtException", (error) => void handler.handle(error, { exit: true }));
    deps.proc.on("unhandledRejection", (reason) => void handler.handle(reason, { exit: true }));
    deps.proc.on("SIGINT", () => handler.interrupt());
    return handler;
}

/**
 * Make every command (and subcommand) throw commander's errors instead of
 * calling process.exit(), so usage errors reach the handler and exit with
 * USAGE. Applied recursively at run time, so it covers commands registered
 * before or after this call order would otherwise matter.
 */
export function applyExitOverride(command: Command): void {
    command.exitOverride();
    for (const sub of command.commands) {
        applyExitOverride(sub);
    }
}

/**
 * Parse and run the CLI with the handler installed. Errors from a command
 * end here; the exit code is set and the process exits naturally.
 */
export async function runCli(program: Command, deps: FatalHandlerDeps): Promise<FatalHandler> {
    const handler = installFatalHandlers(deps);
    applyExitOverride(program);
    try {
        await program.parseAsync([...deps.proc.argv]);
    } catch (error) {
        await handler.handle(error);
    }
    return handler;
}

function writeAll(proc: FatalProcess, stdout: string, stderr: string): Promise<void> {
    return Promise.all([writeTo(proc.stdout, stdout), writeTo(proc.stderr, stderr)]).then(() => undefined);
}

/** Resolves once `text` is flushed, or failed to be; never rejects. */
function writeTo(stream: FatalStream, text: string): Promise<void> {
    if (text === "") return Promise.resolve();
    return new Promise((resolve) => {
        try {
            stream.write(text, () => resolve());
        } catch {
            resolve();
        }
    });
}
