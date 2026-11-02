import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Command } from "commander";
import {
    formatLogLine,
    getLogLevel,
    isLogLevelEnabled,
    LOG_LEVEL_ENV,
    parseLogLevel,
    rotateFileIfLarge,
    setLogLevel,
    writeLog,
} from "../cli/core/log.js";
import { appendLog, resolveTyrPaths } from "../cli/core/scaffold.js";
import { registerGlobalOptions } from "../cli/core/globals.js";
import { makeProject, removeProject } from "./helpers.js";

const savedEnv = process.env[LOG_LEVEL_ENV];

afterEach(() => {
    setLogLevel(undefined);
    if (savedEnv === undefined) {
        delete process.env[LOG_LEVEL_ENV];
    } else {
        process.env[LOG_LEVEL_ENV] = savedEnv;
    }
});

async function readOrEmpty(file: string): Promise<string> {
    return fs.readFile(file, "utf8").catch(() => "");
}

/* ----------------------------- levels ----------------------------- */

test("parseLogLevel accepts every level case-insensitively and rejects others", () => {
    assert.equal(parseLogLevel("debug"), "debug");
    assert.equal(parseLogLevel(" WARN "), "warn");
    assert.equal(parseLogLevel("silent"), "silent");
    assert.throws(() => parseLogLevel("verbose"), /Invalid log level "verbose"/);
    assert.throws(() => parseLogLevel(""), /Expected one of: debug, info, warn, error, silent/);
});

test("level resolution: explicit > TYR_LOG_LEVEL > info", () => {
    delete process.env[LOG_LEVEL_ENV];
    assert.equal(getLogLevel(), "info");

    process.env[LOG_LEVEL_ENV] = "error";
    assert.equal(getLogLevel(), "error");

    setLogLevel("debug");
    assert.equal(getLogLevel(), "debug");

    setLogLevel(undefined);
    assert.equal(getLogLevel(), "error");

    process.env[LOG_LEVEL_ENV] = "nonsense";
    assert.equal(getLogLevel(), "info", "an invalid env value falls back to the default");
});

test("isLogLevelEnabled compares against the threshold", () => {
    assert.equal(isLogLevelEnabled("debug", "info"), false);
    assert.equal(isLogLevelEnabled("info", "info"), true);
    assert.equal(isLogLevelEnabled("error", "warn"), true);
    assert.equal(isLogLevelEnabled("error", "silent"), false);
});

test("appendLog filters messages below the threshold", async () => {
    const root = await makeProject({});
    try {
        setLogLevel("warn");
        await appendLog(root, "debug", "debug-line");
        await appendLog(root, "info", "info-line");
        await appendLog(root, "warn", "warn-line");
        await appendLog(root, "error", "error-line");
        const text = await readOrEmpty(resolveTyrPaths(root).logFile);
        assert.doesNotMatch(text, /debug-line|info-line/);
        assert.match(text, /\] WARN warn-line\n/);
        assert.match(text, /\] ERROR error-line\n/);

        setLogLevel("silent");
        await appendLog(root, "error", "silenced");
        assert.doesNotMatch(await readOrEmpty(resolveTyrPaths(root).logFile), /silenced/);
    } finally {
        await removeProject(root);
    }
});

test("--log-level and --verbose set the threshold in the preAction hook", async () => {
    const run = async (args: string[]): Promise<string> => {
        setLogLevel(undefined);
        const program = new Command().exitOverride();
        registerGlobalOptions(program);
        let seen = "";
        program.command("noop").action(() => {
            seen = getLogLevel();
        });
        await program.parseAsync(["node", "tyr", ...args]);
        return seen;
    };

    delete process.env[LOG_LEVEL_ENV];
    assert.equal(await run(["noop"]), "info");
    assert.equal(await run(["--log-level", "error", "noop"]), "error");
    assert.equal(await run(["--verbose", "noop"]), "debug");
    assert.equal(await run(["--verbose", "--log-level", "warn", "noop"]), "warn");

    process.env[LOG_LEVEL_ENV] = "warn";
    assert.equal(await run(["noop"]), "warn");
    assert.equal(await run(["--log-level", "debug", "noop"]), "debug");

    await assert.rejects(
        run(["--log-level", "loud", "noop"]),
        (error: Error & { code?: string }) => error.code === "commander.invalidArgument",
    );
});

/* ---------------------------- formatting --------------------------- */

test("formatLogLine indents continuation lines of multi-line messages", () => {
    const now = new Date("2026-01-02T03:04:05.000Z");
    assert.equal(formatLogLine("info", "hello", now), "[2026-01-02T03:04:05.000Z] INFO hello\n");
    assert.equal(
        formatLogLine("error", "boom\r\n    at a (x.js:1)\nat b (y.js:2)\n\n", now),
        "[2026-01-02T03:04:05.000Z] ERROR boom\n        at a (x.js:1)\n    at b (y.js:2)\n",
    );
});

/* ----------------------------- rotation ---------------------------- */

test("rotateFileIfLarge leaves small or missing files alone", async () => {
    const root = await makeProject({ "a.log": "tiny\n" });
    try {
        assert.equal(await rotateFileIfLarge(path.join(root, "a.log"), { maxBytes: 100 }), false);
        assert.equal(await rotateFileIfLarge(path.join(root, "missing.log"), { maxBytes: 1 }), false);
        assert.deepEqual(await fs.readdir(root), ["a.log"]);
    } finally {
        await removeProject(root);
    }
});

test("writeLog rotates, keeps N generations, drops the oldest, and the current line lands in the fresh file", async () => {
    const root = await makeProject({});
    const file = path.join(root, "logs", "tyr.log");
    const options = { maxBytes: 10, keep: 2, threshold: "debug" as const };
    try {
        // Each record is well over 10 bytes, so every write after the first rotates.
        for (const n of [1, 2, 3, 4]) {
            await writeLog(file, "info", `line-${n}`, options);
        }
        assert.match(await readOrEmpty(file), /line-4\n$/);
        assert.doesNotMatch(await readOrEmpty(file), /line-3/);
        assert.match(await readOrEmpty(`${file}.1`), /line-3/);
        assert.match(await readOrEmpty(`${file}.2`), /line-2/);
        assert.deepEqual((await fs.readdir(path.dirname(file))).sort(), ["tyr.log", "tyr.log.1", "tyr.log.2"]);
    } finally {
        await removeProject(root);
    }
});

test("keep: 0 discards the old log instead of rotating it", async () => {
    const root = await makeProject({ "a.log": "x".repeat(50) });
    const file = path.join(root, "a.log");
    try {
        await writeLog(file, "warn", "fresh", { maxBytes: 10, keep: 0, threshold: "info" });
        assert.match(await readOrEmpty(file), /^\[[^\]]+\] WARN fresh\n$/);
        assert.deepEqual(await fs.readdir(root), ["a.log"]);
    } finally {
        await removeProject(root);
    }
});

test("concurrent writers rotating at once never throw or lose a line", async () => {
    const root = await makeProject({});
    const file = path.join(root, "tyr.log");
    const count = 30;
    try {
        await Promise.all(
            Array.from({ length: count }, (_, n) =>
                writeLog(file, "info", `concurrent-${n}`, { maxBytes: 64, keep: 100, threshold: "info" }),
            ),
        );
        let all = "";
        for (const name of await fs.readdir(root)) {
            all += await readOrEmpty(path.join(root, name));
        }
        for (let n = 0; n < count; n++) {
            assert.match(all, new RegExp(`concurrent-${n}\\n`), `line ${n} missing`);
        }
    } finally {
        await removeProject(root);
    }
});

/* --------------------------- best-effort --------------------------- */

test("writeLog creates a missing logs directory", async () => {
    const root = await makeProject({});
    try {
        await appendLog(root, "info", "created");
        assert.match(await readOrEmpty(resolveTyrPaths(root).logFile), /INFO created/);
    } finally {
        await removeProject(root);
    }
});

test("writeLog and rotateFileIfLarge never throw when the directory cannot be written", async () => {
    // A regular file where the logs directory should be makes mkdir and
    // appendFile fail on every platform.
    const root = await makeProject({ ".tyr/logs": "not a directory" });
    try {
        await appendLog(root, "error", "dropped");
        await writeLog(path.join(root, ".tyr", "logs", "tyr.log"), "error", "dropped", { threshold: "debug" });
        assert.equal(await rotateFileIfLarge(path.join(root, ".tyr", "logs", "tyr.log"), { maxBytes: 0 }), false);
        assert.equal(await fs.readFile(path.join(root, ".tyr", "logs"), "utf8"), "not a directory");
    } finally {
        await removeProject(root);
    }
});
