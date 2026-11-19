// The execution engine (cli/engine/executor.ts): outcome classification,
// bounded output capture, process-tree killing on timeout/abort, the
// configured-command loader and the journal event builders. Commands are real
// `node` scripts written into a temp project, so the shell, pipes and signals
// are all exercised for real; timeouts are kept short.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { buildConfig } from "../cli/core/scaffold.js";
import type { InitSnapshot, ProjectCommand } from "../cli/core/types.js";
import {
    TailBuffer,
    checkRunToEvent,
    checkStartedEvent,
    loadCheckCommands,
    notRunnableReason,
    runCheck,
    runCheckSerialized,
    type CheckStart,
    type RunCheckOptions,
} from "../cli/engine/executor.js";
import { CHECK_FAILED_KIND, CHECK_PASSED_KIND, CHECK_STARTED_KIND, type CheckRun } from "../cli/engine/model.js";
import { makeProject, removeProject } from "./helpers.js";

const NODE = JSON.stringify(process.execPath);
const isWindows = process.platform === "win32";

/** Fast defaults: no git lookup, short timeout. */
const base: RunCheckOptions = { headCommit: async () => "abc123", timeoutMs: 10_000, killGraceMs: 200 };

async function withScripts(
    scripts: Record<string, string>,
    fn: (root: string, run: (script: string, opts?: RunCheckOptions) => Promise<CheckRun>) => Promise<void>,
): Promise<void> {
    const root = await makeProject(scripts);
    try {
        await fn(root, (script, opts = {}) => runCheck(root, "test", `${NODE} ${script}`, { ...base, ...opts }));
    } finally {
        await removeProject(root);
    }
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (await predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return predicate();
}

/* -------------------------------------------------------------------------
 * Outcomes
 * ---------------------------------------------------------------------- */

test("exit 0 is passed, with output, metadata and the env defaults", async () => {
    await withScripts({ "ok.js": "console.log('hello', process.env.CI, process.env.FORCE_COLOR); console.error('warn');" }, async (root, run) => {
        let started: CheckStart | null = null;
        const result = await run("ok.js", { trigger: { reason: "idle", eventId: "e1" }, onStart: (s) => (started = s) });
        assert.equal(result.outcome, "passed");
        assert.equal(result.exitCode, 0);
        assert.equal(result.signal, null);
        assert.equal(result.stdout.trim(), "hello 1 0");
        assert.equal(result.stderr.trim(), "warn");
        assert.equal(result.outputTruncated, false);
        assert.equal(result.cwd, root);
        assert.equal(result.kind, "test");
        assert.equal(result.headCommit, "abc123");
        assert.deepEqual(result.trigger, { reason: "idle", eventId: "e1" });
        assert.ok(result.durationMs >= 0);
        assert.equal(result.error, undefined);
        assert.ok(started !== null);
        assert.equal((started as CheckStart).id, result.id);
    });
});

test("non-zero exit is failed and keeps the code; opts.env overrides the defaults", async () => {
    await withScripts({ "fail.js": "console.error('boom', process.env.CI); process.exit(3);" }, async (_root, run) => {
        const result = await run("fail.js", { env: { CI: "custom" } });
        assert.equal(result.outcome, "failed");
        assert.equal(result.exitCode, 3);
        assert.equal(result.stderr.trim(), "boom custom");
        const event = checkRunToEvent(result);
        assert.equal(event.kind, CHECK_FAILED_KIND);
        assert.equal(event.source, "check");
        assert.equal(event.message, "test failed (exit 3)");
        assert.equal((event.data as { run: CheckRun }).run, result);
    });
});

test("a command that does not exist is an error, not a failure", async () => {
    const root = await makeProject({});
    try {
        const result = await runCheck(root, "lint", "tyr-definitely-not-a-command-xyz --flag", base);
        assert.equal(result.outcome, "error");
        assert.ok(result.error !== undefined && /not found/.test(result.error), String(result.error));
        // cmd /d /s /c exits 1 (not 9009) for an unknown command; stderr tells it apart.
        assert.equal(result.exitCode, isWindows ? 1 : 127);
        assert.match(checkRunToEvent(result).message ?? "", /^lint could not run: command not found/);
    } finally {
        await removeProject(root);
    }
});

test("notRunnableReason: shell codes per platform, cmd.exe's message on Windows", () => {
    assert.equal(notRunnableReason(127, "linux"), "command not found (exit 127)");
    assert.equal(notRunnableReason(126, "darwin"), "command not executable (exit 126)");
    assert.equal(notRunnableReason(1, "linux"), null);
    assert.equal(notRunnableReason(9009, "win32"), "command not found (exit 9009)");
    const cmdMessage = "'eslint' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n";
    assert.equal(notRunnableReason(1, "win32", cmdMessage), "command not found (exit 1)");
    assert.equal(notRunnableReason(1, "win32", "2 tests failed"), null, "a real failure stays a failure");
    assert.equal(notRunnableReason(2, "win32", cmdMessage), null, "only cmd's own exit code 1");
});

test("a missing working directory is an error", async () => {
    const result = await runCheck("/nonexistent/tyr-executor-test", "build", "echo hi", base);
    assert.equal(result.outcome, "error");
    assert.ok(result.error !== undefined && result.error.length > 0);
    assert.equal(result.exitCode, null);
});

test("an empty command is an error and spawns nothing", async () => {
    const result = await runCheck("/", "build", "   ", base);
    assert.equal(result.outcome, "error");
    assert.equal(result.error, "empty command");
});

/* -------------------------------------------------------------------------
 * Output capture
 * ---------------------------------------------------------------------- */

test("output is cut to the last N bytes of each stream", async () => {
    await withScripts(
        {
            "loud.js": [
                "for (let i = 0; i < 2000; i++) process.stdout.write('line ' + i + '\\n');",
                "process.stdout.write('END');",
                "process.stderr.write('short');",
            ].join("\n"),
        },
        async (_root, run) => {
            const result = await run("loud.js", { outputTailBytes: 100 });
            assert.equal(result.outcome, "passed");
            assert.equal(result.outputTruncated, true);
            assert.ok(Buffer.byteLength(result.stdout) <= 100);
            assert.ok(result.stdout.endsWith("line 1999\nEND"), result.stdout);
            assert.equal(result.stderr, "short");
        },
    );
});

test("TailBuffer cuts at a UTF-8 boundary and tracks truncation", () => {
    const buffer = new TailBuffer(4);
    buffer.push(Buffer.from("ab"));
    assert.equal(buffer.text(), "ab");
    assert.equal(buffer.truncated, false);
    // "é" is 2 bytes and "€" 3, so a 4-byte tail starts mid-"é".
    buffer.push(Buffer.from("xé€"));
    assert.equal(buffer.truncated, true);
    assert.equal(buffer.text(), "€");

    const big = new TailBuffer(4);
    big.push(Buffer.from("0123456789"));
    assert.equal(big.text(), "6789");
    assert.equal(big.truncated, true);

    const none = new TailBuffer(0);
    none.push(Buffer.from("x"));
    assert.equal(none.text(), "");
    assert.equal(none.truncated, true);
});

/* -------------------------------------------------------------------------
 * Timeouts and cancellation
 * ---------------------------------------------------------------------- */

// The child spawns a grandchild that ignores SIGTERM and records its pid once
// that handler is installed; then both hang. Killing only the shell (or only
// the child) would leave the grandchild alive, and so would SIGTERM alone.
const TREE_SCRIPTS = {
    "tree.js": [
        "require('node:child_process').spawn(process.execPath, ['grandchild.js'], { stdio: 'inherit' });",
        "console.log('spawned');",
        "setInterval(() => {}, 1000);",
    ].join("\n"),
    "grandchild.js": [
        "process.on('SIGTERM', () => {});",
        "require('node:fs').writeFileSync('grandchild.pid', String(process.pid));",
        "setInterval(() => {}, 1000);",
    ].join("\n"),
};

async function readPid(root: string): Promise<number> {
    const file = path.join(root, "grandchild.pid");
    assert.ok(await waitFor(async () => (await fs.readFile(file, "utf8").catch(() => "")) !== "", 5000));
    return Number(await fs.readFile(file, "utf8"));
}

test("a timeout kills the whole process tree, grandchild included", { skip: isWindows }, async () => {
    await withScripts(TREE_SCRIPTS, async (root, run) => {
        const result = await run("tree.js", { timeoutMs: 1000 });
        assert.equal(result.outcome, "timeout");
        assert.equal(result.stdout.trim(), "spawned");
        assert.match(checkRunToEvent(result).message ?? "", /^test timed out after/);
        const pid = await readPid(root);
        assert.ok(await waitFor(() => !isAlive(pid), 3000), `grandchild ${pid} survived`);
    });
});

test("aborting a run cancels it and kills the tree", { skip: isWindows }, async () => {
    await withScripts(TREE_SCRIPTS, async (root, run) => {
        const controller = new AbortController();
        const pending = run("tree.js", { signal: controller.signal });
        const pid = await readPid(root);
        controller.abort();
        const result = await pending;
        assert.equal(result.outcome, "cancelled");
        assert.equal(checkRunToEvent(result).kind, CHECK_FAILED_KIND);
        assert.ok(await waitFor(() => !isAlive(pid), 3000), `grandchild ${pid} survived`);
    });
});

test("an already-aborted signal cancels without spawning", async () => {
    await withScripts({ "ok.js": "require('fs').writeFileSync('ran', '1')" }, async (root, run) => {
        const result = await run("ok.js", { signal: AbortSignal.abort() });
        assert.equal(result.outcome, "cancelled");
        await assert.rejects(fs.access(path.join(root, "ran")));
    });
});

/* -------------------------------------------------------------------------
 * Serialization
 * ---------------------------------------------------------------------- */

test("runCheckSerialized never overlaps two runs of the same kind", async () => {
    const script = [
        "const fs = require('fs');",
        "if (fs.existsSync('lock')) { console.log('overlap'); process.exit(1); }",
        "fs.writeFileSync('lock', '');",
        "setTimeout(() => fs.unlinkSync('lock'), 150);",
    ].join("\n");
    await withScripts({ "excl.js": script }, async (root) => {
        const command = `${NODE} excl.js`;
        const runs = await Promise.all([
            runCheckSerialized(root, "test", command, base),
            runCheckSerialized(root, "test", command, base),
            runCheckSerialized(root, "test", command, base),
        ]);
        assert.deepEqual(
            runs.map((r) => r.outcome),
            ["passed", "passed", "passed"],
        );
    });
});

/* -------------------------------------------------------------------------
 * Events
 * ---------------------------------------------------------------------- */

test("event builders produce check.* journal inputs", () => {
    const start: CheckStart = {
        id: "r1",
        kind: "test",
        command: "npm test",
        cwd: "/p",
        trigger: { reason: "commit" },
        startedAt: "2026-01-01T00:00:00.000Z",
        headCommit: null,
    };
    const started = checkStartedEvent(start);
    assert.equal(started.kind, CHECK_STARTED_KIND);
    assert.equal(started.source, "check");
    assert.equal(started.data?.runId, "r1");

    const run: CheckRun = {
        ...start,
        finishedAt: "2026-01-01T00:00:04.200Z",
        durationMs: 4200,
        outcome: "passed",
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        outputTruncated: false,
    };
    const passed = checkRunToEvent(run);
    assert.equal(passed.kind, CHECK_PASSED_KIND);
    assert.equal(passed.message, "test passed in 4.2s");
    assert.deepEqual(passed.data, { run });
});

/* -------------------------------------------------------------------------
 * loadCheckCommands
 * ---------------------------------------------------------------------- */

function snapshot(root: string, commands: Partial<Record<"build" | "test" | "lint" | "format" | "typecheck", string>>): InitSnapshot {
    const cmd = (command: string | undefined): ProjectCommand | null => (command === undefined ? null : { tool: "t", command, evidence: "package.json" });
    return {
        discovery: { root, alreadyInitialized: false, files: [], fileCount: 0, skippedDirs: [] },
        git: {
            isRepo: false,
            branch: null,
            detached: false,
            headCommit: null,
            status: null,
            statusTimedOut: false,
            remotes: [],
            defaultRemote: null,
        },
        project: {
            name: "app",
            nameSource: "package.json",
            languages: [],
            primaryLanguage: null,
            frameworks: [],
            packageManager: null,
            build: cmd(commands.build),
            test: cmd(commands.test),
            lint: cmd(commands.lint),
            format: cmd(commands.format),
            typecheck: cmd(commands.typecheck),
            readme: null,
            claudeMd: null,
            workspace: null,
        },
    } as InitSnapshot;
}

test("loadCheckCommands returns enabled, detected commands only", async () => {
    const root = await makeProject({});
    const home = await makeProject({});
    try {
        const config = buildConfig(snapshot(root, { build: "npm run build", test: "npm test", lint: "eslint .", format: "prettier --check ." }), "1.0.0");
        await fs.mkdir(path.join(root, ".tyr"), { recursive: true });
        await fs.writeFile(path.join(root, ".tyr", "tyr.json"), JSON.stringify(config), "utf8");
        // Project layer turns lint off; format is off by default; typecheck was never detected.
        await fs.writeFile(path.join(root, ".tyr", "settings.json"), JSON.stringify({ checks: { lint: false } }), "utf8");
        const env = { TYR_CONFIG_HOME: home };

        assert.deepEqual(await loadCheckCommands(root, { env }), { build: "npm run build", test: "npm test" });
        // The env layer outranks the project file.
        assert.deepEqual(await loadCheckCommands(root, { env: { ...env, TYR_CHECKS_TEST: "false" } }), {
            build: "npm run build",
        });
        assert.deepEqual(await loadCheckCommands(home, { env }), {});
    } finally {
        await removeProject(root);
        await removeProject(home);
    }
});
