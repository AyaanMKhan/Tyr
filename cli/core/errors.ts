// Tyr's exit codes and the error type commands throw for expected failures.
//
// Everything here is pure: deciding an exit code and rendering a fatal error
// into text or JSON. Writing it out, logging it and exiting is fatal.ts's job,
// so this module can be tested without touching a real process.

import { CommanderError } from "commander";

/**
 * Every exit code Tyr uses. Scripts may rely on these; never renumber one.
 *
 * Kept deliberately small: a code earns its place only when a script would
 * plausibly branch on it rather than just on "non-zero".
 *
 * - `OK` (0): success, including `--help` and `--version`.
 * - `FAILURE` (1): the command ran and failed (a background process that
 *   would not start or stop, a crash). The catch-all for anything unexpected.
 * - `USAGE` (2): the command line itself is wrong: unknown option or command,
 *   missing argument, invalid option value, a bad `--cwd`. Retrying the same
 *   invocation can never succeed. 2 is the POSIX/shell-builtin convention.
 * - `NOT_INITIALIZED` (3): the project has no `.tyr/` yet. Distinct so
 *   scripts can do `tyr start || [ $? -eq 3 ] && tyr init --start` without
 *   parsing text.
 * - `CONFIG` (4): `.tyr/` or a settings file exists but is invalid, or was
 *   written by a newer Tyr. Distinct from NOT_INITIALIZED because the fix is
 *   to repair the file, and running `tyr init` blindly would be wrong.
 * - `INTERRUPTED` (130): stopped by Ctrl-C (SIGINT). 128 + signal number is
 *   what shells report for a signal death, so `$?` reads the same whether
 *   Tyr handled the signal or not.
 */
export const EXIT_CODES = {
    OK: 0,
    FAILURE: 1,
    USAGE: 2,
    NOT_INITIALIZED: 3,
    CONFIG: 4,
    INTERRUPTED: 130,
} as const;

export type ExitCodeName = keyof typeof EXIT_CODES;
export type ExitCode = (typeof EXIT_CODES)[ExitCodeName];

/** The symbolic name for a code, as reported in `--json` errors. */
export function exitCodeName(code: number): ExitCodeName {
    for (const [name, value] of Object.entries(EXIT_CODES)) {
        if (value === code) {
            return name as ExitCodeName;
        }
    }
    return "FAILURE";
}

export interface TyrErrorOptions {
    /** Defaults to `EXIT_CODES.FAILURE`. */
    exitCode?: ExitCode;
    /** One line telling the user what to do next, printed after the message. */
    hint?: string;
    cause?: unknown;
}

/**
 * An expected failure: something the user can act on, not a bug. Thrown from
 * a command, it is printed as `error: <message>` (plus the hint) with no stack
 * trace and exits with `exitCode`. Anything else that escapes a command is
 * treated as a bug and reported with a pointer to its stack.
 */
export class TyrError extends Error {
    readonly exitCode: ExitCode;
    readonly hint: string | undefined;

    constructor(message: string, options: TyrErrorOptions = {}) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = "TyrError";
        this.exitCode = options.exitCode ?? EXIT_CODES.FAILURE;
        this.hint = options.hint;
    }
}

/**
 * The exit code for an error that reached the top level.
 *
 * Commander reports help/version as an "error" with code 0, and every usage
 * problem with its default code 1; the latter is remapped to USAGE so all
 * command-line mistakes exit 2. A CommanderError raised with an explicit
 * non-default code keeps it.
 */
export function exitCodeFor(error: unknown): number {
    if (error instanceof TyrError) {
        return error.exitCode;
    }
    if (error instanceof CommanderError) {
        return error.exitCode === 1 ? EXIT_CODES.USAGE : error.exitCode;
    }
    return EXIT_CODES.FAILURE;
}

/** Whether `error` is a failure Tyr anticipated (so no stack is worth showing). */
export function isExpectedError(error: unknown): boolean {
    return error instanceof TyrError || error instanceof CommanderError;
}

export interface FatalFormatOptions {
    /** `--json`: stdout gets one JSON error object. */
    json: boolean;
    /** `--verbose` or `TYR_DEBUG`: include the stack of unexpected errors. */
    verbose: boolean;
    /** Where an unexpected error was also logged, mentioned in the text output. */
    logFile?: string;
}

/** What to print for a fatal error, and the code to exit with. */
export interface FatalOutput {
    exitCode: number;
    stdout: string;
    stderr: string;
}

/** The `--json` shape of every top-level failure. */
export interface JsonError {
    ok: false;
    error: { message: string; code: ExitCodeName; exitCode: number; hint?: string };
}

/**
 * Render an error that reached the top level. Pure: the caller writes the
 * strings and exits.
 *
 * - TyrError: `error: <message>` and `hint: <hint>`, no stack.
 * - CommanderError: nothing in text mode, because commander has already
 *   written its own message (or the help/version text) to the terminal.
 * - Anything else: the message plus either the stack (verbose) or a pointer
 *   to how to see it.
 *
 * Under `--json` stdout always gets exactly one JSON error object (except for
 * a successful `--help` / `--version`), so a consumer piping into `jq` never
 * sees an empty or text stdout on failure.
 */
export function formatFatal(error: unknown, options: FatalFormatOptions): FatalOutput {
    const exitCode = exitCodeFor(error);
    const expected = isExpectedError(error);
    const message = messageOf(error);
    const hint = error instanceof TyrError ? error.hint : undefined;

    if (error instanceof CommanderError && exitCode === EXIT_CODES.OK) {
        return { exitCode, stdout: "", stderr: "" };
    }

    let stdout = "";
    let stderr = "";

    if (options.json) {
        const body: JsonError = { ok: false, error: { message, code: exitCodeName(exitCode), exitCode } };
        if (hint !== undefined) {
            body.error.hint = hint;
        }
        stdout = JSON.stringify(body, null, 2) + "\n";
    } else if (!(error instanceof CommanderError)) {
        stderr += `error: ${message}\n`;
        if (hint !== undefined) {
            stderr += `hint: ${hint}\n`;
        }
    }

    if (!expected) {
        // The stack goes to stderr in JSON mode too: stdout is reserved for JSON.
        if (options.verbose) {
            stderr += `${stackOf(error)}\n`;
        } else if (!options.json) {
            stderr += "This was unexpected. Re-run with --verbose (or TYR_DEBUG=1) to see the stack trace.\n";
        }
        if (options.logFile !== undefined && !options.json) {
            stderr += `Details were appended to ${options.logFile}\n`;
        }
    }

    return { exitCode, stdout, stderr };
}

/** A one-line message for any thrown value, commander's `error: ` prefix removed. */
export function messageOf(error: unknown): string {
    let message: string;
    if (error instanceof Error) {
        message = error.message;
    } else if (typeof error === "string") {
        message = error;
    } else {
        try {
            message = `Non-error value thrown: ${JSON.stringify(error)}`;
        } catch {
            message = `Non-error value thrown: ${String(error)}`;
        }
    }
    // Commander bakes "error: " into its messages; keep the JSON message clean.
    message = message.replace(/^error:\s*/i, "");
    return message === "" ? "Unknown error" : message;
}

/** The full stack of an error, following `cause` chains, for logs and --verbose. */
export function stackOf(error: unknown): string {
    const parts: string[] = [];
    let current: unknown = error;
    // Bounded, in case of a cyclic cause chain.
    for (let depth = 0; depth < 5 && current !== undefined; depth++) {
        const text = current instanceof Error ? (current.stack ?? `${current.name}: ${current.message}`) : String(current);
        parts.push(depth === 0 ? text : `Caused by: ${text}`);
        current = current instanceof Error ? current.cause : undefined;
    }
    return parts.join("\n");
}
