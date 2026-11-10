import { test } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import {
    EXIT_CODES,
    TyrError,
    exitCodeFor,
    exitCodeName,
    formatFatal,
    messageOf,
    stackOf,
} from "../cli/core/errors.js";
import {
    createFatalHandler,
    installFatalHandlers,
    readFatalContext,
    runCli,
    type FatalProcess,
} from "../cli/core/fatal.js";
import { makeProject, removeProject } from "./helpers.js";

/* -------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------- */

interface FakeProcess extends FatalProcess {
    out: string;
    err: string;
    exits: number[];
    listeners: Map<string, (error?: unknown) => void>;
}

function fakeProcess(args: string[] = [], env: Record<string, string | undefined> = {}): FakeProcess {
    const proc: FakeProcess = {
        argv: ["node", "tyr", ...args],
        env,
        out: "",
        err: "",
        exits: [],
        listeners: new Map(),
        exitCode: undefined,
        stdout: {
            write(chunk, callback) {
                proc.out += chunk;
                callback?.();
                return true;
            },
        },
        stderr: {
            write(chunk, callback) {
                proc.err += chunk;
                callback?.();
                return true;
            },
        },
        on(event, listener) {
            proc.listeners.set(event, listener);
            return proc;
        },
        exit(code) {
            proc.exits.push(code);
        },
    };
    return proc;
}

/** Lets exitAfterFlush's `writes.then(exit)` run. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function usageError(message = "error: unknown option '--bogus'"): CommanderError {
    return new CommanderError(1, "commander.unknownOption", message);
}

/* -------------------------------------------------------------------------
 * Exit-code table
 * ---------------------------------------------------------------------- */

test("EXIT_CODES: the documented values never change", () => {
    assert.deepEqual(EXIT_CODES, {
        OK: 0,
        FAILURE: 1,
        USAGE: 2,
        NOT_INITIALIZED: 3,
        CONFIG: 4,
        INTERRUPTED: 130,
    });
});

test("exitCodeName: maps codes back to names, unknown codes to FAILURE", () => {
    assert.equal(exitCodeName(2), "USAGE");
    assert.equal(exitCodeName(130), "INTERRUPTED");
    assert.equal(exitCodeName(99), "FAILURE");
});

test("exitCodeFor: TyrError, commander errors and anything else", () => {
    assert.equal(exitCodeFor(new TyrError("x")), EXIT_CODES.FAILURE);
    assert.equal(exitCodeFor(new TyrError("x", { exitCode: EXIT_CODES.NOT_INITIALIZED })), 3);
    assert.equal(exitCodeFor(usageError()), EXIT_CODES.USAGE);
    assert.equal(exitCodeFor(new CommanderError(0, "commander.version", "1.0.0")), EXIT_CODES.OK);
    assert.equal(exitCodeFor(new CommanderError(0, "commander.helpDisplayed", "(outputHelp)")), EXIT_CODES.OK);
    // An explicit, non-default commander code is kept.
    assert.equal(exitCodeFor(new CommanderError(4, "custom", "x")), 4);
    assert.equal(exitCodeFor(new Error("boom")), EXIT_CODES.FAILURE);
    assert.equal(exitCodeFor("a string"), EXIT_CODES.FAILURE);
    assert.equal(exitCodeFor(undefined), EXIT_CODES.FAILURE);
});

test("TyrError: carries hint and cause", () => {
    const cause = new Error("root cause");
    const error = new TyrError("outer", { hint: "do this", cause });
    assert.equal(error.name, "TyrError");
    assert.equal(error.hint, "do this");
    assert.equal(error.cause, cause);
    assert.ok(error instanceof Error);
});

/* -------------------------------------------------------------------------
 * formatFatal
 * ---------------------------------------------------------------------- */

test("formatFatal: an expected TyrError prints message and hint, no stack", () => {
    const error = new TyrError("Tyr is not initialized", { exitCode: 3, hint: 'Run "tyr init"' });
    const output = formatFatal(error, { json: false, verbose: true });
    assert.equal(output.exitCode, 3);
    assert.equal(output.stdout, "");
    assert.equal(output.stderr, 'error: Tyr is not initialized\nhint: Run "tyr init"\n');
});

test("formatFatal: --json prints one JSON error object to stdout", () => {
    const error = new TyrError("bad config", { exitCode: EXIT_CODES.CONFIG, hint: "fix it" });
    const output = formatFatal(error, { json: true, verbose: false });
    assert.equal(output.stderr, "");
    assert.deepEqual(JSON.parse(output.stdout), {
        ok: false,
        error: { message: "bad config", code: "CONFIG", exitCode: 4, hint: "fix it" },
    });
});

test("formatFatal: an unexpected error points at the stack unless verbose", () => {
    const error = new Error("boom");
    const quiet = formatFatal(error, { json: false, verbose: false });
    assert.equal(quiet.exitCode, 1);
    assert.match(quiet.stderr, /^error: boom\n/);
    assert.match(quiet.stderr, /--verbose \(or TYR_DEBUG=1\)/);
    assert.doesNotMatch(quiet.stderr, /\n\s+at /);

    const verbose = formatFatal(error, { json: false, verbose: true });
    assert.match(verbose.stderr, /\n\s+at /);
});

test("formatFatal: mentions the log file an unexpected error was written to", () => {
    const output = formatFatal(new Error("boom"), { json: false, verbose: false, logFile: "/p/.tyr/logs/tyr.log" });
    assert.match(output.stderr, /Details were appended to \/p\/\.tyr\/logs\/tyr\.log/);
    // Expected errors are never logged, so never mention it.
    const expected = formatFatal(new TyrError("x"), { json: false, verbose: false, logFile: "/p/x" });
    assert.doesNotMatch(expected.stderr, /appended/);
});

test("formatFatal: --json with an unexpected error keeps stdout pure JSON, stack on stderr", () => {
    const output = formatFatal(new TypeError("nope"), { json: true, verbose: true });
    assert.deepEqual(JSON.parse(output.stdout), {
        ok: false,
        error: { message: "nope", code: "FAILURE", exitCode: 1 },
    });
    assert.match(output.stderr, /TypeError: nope/);
});

test("formatFatal: commander usage errors are not printed twice in text mode", () => {
    const output = formatFatal(usageError(), { json: false, verbose: false });
    assert.deepEqual(output, { exitCode: 2, stdout: "", stderr: "" });
});

test("formatFatal: commander usage errors still produce JSON under --json", () => {
    const output = formatFatal(usageError(), { json: true, verbose: false });
    assert.equal(output.exitCode, 2);
    assert.deepEqual(JSON.parse(output.stdout).error, {
        message: "unknown option '--bogus'",
        code: "USAGE",
        exitCode: 2,
    });
});

test("formatFatal: --help and --version print nothing and exit 0, even under --json", () => {
    for (const json of [false, true]) {
        const output = formatFatal(new CommanderError(0, "commander.helpDisplayed", "(outputHelp)"), {
            json,
            verbose: false,
        });
        assert.deepEqual(output, { exitCode: 0, stdout: "", stderr: "" });
    }
});

test("messageOf: strips commander's prefix and handles non-errors", () => {
    assert.equal(messageOf(new Error("error: unknown command 'x'")), "unknown command 'x'");
    assert.equal(messageOf("plain"), "plain");
    assert.equal(messageOf({ a: 1 }), 'Non-error value thrown: {"a":1}');
    assert.equal(messageOf(new Error("")), "Unknown error");
});

test("stackOf: follows the cause chain", () => {
    const error = new Error("outer", { cause: new Error("inner") });
    const stack = stackOf(error);
    assert.match(stack, /Error: outer/);
    assert.match(stack, /Caused by: Error: inner/);
});

/* -------------------------------------------------------------------------
 * Context
 * ---------------------------------------------------------------------- */

test("readFatalContext: reads --json/--verbose from raw argv, stops at --", () => {
    assert.deepEqual(readFatalContext(["node", "tyr", "init", "--json"], {}), { json: true, verbose: false });
    assert.deepEqual(readFatalContext(["node", "tyr", "run", "--", "--json"], {}), { json: false, verbose: false });
    assert.deepEqual(readFatalContext(["node", "tyr", "--verbose"], {}), { json: false, verbose: true });
    assert.equal(readFatalContext(["node", "tyr"], { TYR_DEBUG: "1" }).verbose, true);
    assert.equal(readFatalContext(["node", "tyr"], { TYR_DEBUG: "0" }).verbose, false);
    assert.equal(readFatalContext(["node", "tyr"], { TYR_DEBUG: "" }).verbose, false);
    // The env layer for the global flags applies here too (flag > env).
    assert.deepEqual(readFatalContext(["node", "tyr", "--bogus"], { TYR_JSON: "1" }), { json: true, verbose: false });
    assert.equal(readFatalContext(["node", "tyr"], { TYR_VERBOSE: "yes" }).verbose, true);
    assert.equal(readFatalContext(["node", "tyr", "-q"], { TYR_VERBOSE: "1" }).verbose, false);
});

/* -------------------------------------------------------------------------
 * Handler
 * ---------------------------------------------------------------------- */

test("handle: an expected error sets the exit code without logging or exiting", async () => {
    const proc = fakeProcess();
    let logged = false;
    const handler = createFatalHandler({
        proc,
        logUnexpected: async () => {
            logged = true;
            return null;
        },
    });
    const code = await handler.handle(new TyrError("nope", { exitCode: 3 }));
    assert.equal(code, 3);
    assert.equal(proc.exitCode, 3);
    assert.equal(proc.err, "error: nope\n");
    assert.deepEqual(proc.exits, []);
    assert.equal(logged, false);
});

test("handle: an unexpected error is logged with its stack and the log is mentioned", async () => {
    const proc = fakeProcess();
    const messages: string[] = [];
    const handler = createFatalHandler({
        proc,
        logUnexpected: async (message) => {
            messages.push(message);
            return "/proj/.tyr/logs/tyr.log";
        },
    });
    await handler.handle(new Error("kaput"));
    assert.equal(proc.exitCode, 1);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /^Unexpected error: Error: kaput\n\s+at /);
    assert.match(proc.err, /Details were appended to \/proj\/\.tyr\/logs\/tyr\.log/);
});

test("handle: a failing or hanging logger never masks the original error", async () => {
    const failing = fakeProcess();
    await createFatalHandler({
        proc: failing,
        logUnexpected: async () => {
            throw new Error("disk full");
        },
    }).handle(new Error("original"));
    assert.match(failing.err, /^error: original\n/);
    assert.doesNotMatch(failing.err, /disk full|appended/);
    assert.equal(failing.exitCode, 1);

    const hanging = fakeProcess();
    await createFatalHandler({
        proc: hanging,
        logUnexpected: () => new Promise(() => undefined),
        logTimeoutMs: 10,
    }).handle(new Error("original"));
    assert.match(hanging.err, /^error: original\n/);
});

test("handle: exit: true exits with the code once output is written", async () => {
    const proc = fakeProcess(["--json"]);
    const handler = createFatalHandler({ proc, logUnexpected: async () => null });
    await handler.handle(new Error("crash"), { exit: true });
    await tick();
    assert.deepEqual(proc.exits, [1]);
    assert.equal(JSON.parse(proc.out).error.message, "crash");
});

test("installFatalHandlers: routes uncaught exceptions and rejections to an exit", async () => {
    const proc = fakeProcess();
    installFatalHandlers({ proc, logUnexpected: async () => null });
    assert.deepEqual([...proc.listeners.keys()].sort(), ["SIGINT", "uncaughtException", "unhandledRejection"]);

    proc.listeners.get("unhandledRejection")?.(new TyrError("rejected", { exitCode: 4 }));
    await tick();
    await tick();
    assert.deepEqual(proc.exits, [4]);
    assert.equal(proc.err, "error: rejected\n");
});

test("installFatalHandlers: a failure while reporting a failure still exits", async () => {
    const proc = fakeProcess();
    installFatalHandlers({ proc, logUnexpected: () => new Promise(() => undefined), logTimeoutMs: 50 });
    proc.listeners.get("uncaughtException")?.(new Error("first"));
    // Arrives while the first is still waiting on the logger.
    proc.listeners.get("uncaughtException")?.(new Error("second"));
    assert.deepEqual(proc.exits, [1]);
    assert.match(proc.err, /error: second/);
});

test("SIGINT: exits 130, with a JSON error under --json", async () => {
    const text = fakeProcess();
    installFatalHandlers({ proc: text });
    text.listeners.get("SIGINT")?.();
    await tick();
    assert.deepEqual(text.exits, [130]);
    assert.equal(text.out, "");

    const json = fakeProcess(["status", "--json"]);
    installFatalHandlers({ proc: json });
    json.listeners.get("SIGINT")?.();
    await tick();
    assert.deepEqual(json.exits, [130]);
    assert.deepEqual(JSON.parse(json.out).error, { message: "Interrupted", code: "INTERRUPTED", exitCode: 130 });
    // A single NDJSON-compatible line, so `tyr watch --json` streams stay line-parseable.
    assert.equal(json.out.trimEnd().split("\n").length, 1);
});

/* -------------------------------------------------------------------------
 * runCli with a real commander program
 * ---------------------------------------------------------------------- */

function testProgram(sink: { out: string; err: string }): Command {
    const program = new Command().name("tyr").option("--json").option("--verbose").version("9.9.9", "-v, --version");
    program.configureOutput({
        writeOut: (text) => void (sink.out += text),
        writeErr: (text) => void (sink.err += text),
    });
    program.command("ok").action(async () => undefined);
    program.command("fail").action(async () => {
        throw new TyrError("Tyr is not initialized", { exitCode: EXIT_CODES.NOT_INITIALIZED });
    });
    return program;
}

test("runCli: usage errors exit 2, help and version exit 0, TyrErrors keep their code", async () => {
    const cases: Array<[string[], number]> = [
        [["ok"], 0],
        [["--bogus"], 2],
        [["ok", "--bogus"], 2],
        [["nope"], 2],
        [[], 2], // no command: help on stderr, a usage error
        [["--help"], 0],
        [["ok", "--help"], 0],
        [["--version"], 0],
        [["fail"], 3],
    ];
    for (const [args, expected] of cases) {
        const sink = { out: "", err: "" };
        const proc = fakeProcess(args);
        await runCli(testProgram(sink), { proc, logUnexpected: async () => null });
        assert.equal(proc.exitCode ?? 0, expected, `tyr ${args.join(" ")}`);
        assert.deepEqual(proc.exits, [], "runCli itself never force-exits");
    }
});

/* -------------------------------------------------------------------------
 * End to end: the compiled CLI
 * ---------------------------------------------------------------------- */

// Compiled to .test-build/tests/; the CLI is compiled beside it.
const CLI = fileURLToPath(new URL("../cli/index.js", import.meta.url));

test("tyr (built): unknown option exits 2; --json gets a JSON error; --version exits 0", async () => {
    const cwd = await makeProject({});
    try {
        const run = (...args: string[]) =>
            spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, TYR_DEBUG: "" } });

        const unknown = run("--bogus");
        assert.equal(unknown.status, 2);
        assert.match(unknown.stderr, /unknown option '--bogus'/);
        assert.equal(unknown.stdout, "");

        const json = run("--json", "--bogus");
        assert.equal(json.status, 2);
        assert.equal(JSON.parse(json.stdout).error.code, "USAGE");

        const version = run("--version");
        assert.equal(version.status, 0);
        assert.match(version.stdout, /^\d+\.\d+\.\d+/);
    } finally {
        await removeProject(cwd);
    }
});
