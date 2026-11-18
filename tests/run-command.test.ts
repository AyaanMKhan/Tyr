// The `tyr run` command end to end: the compiled CLI against temp projects,
// in text and --json modes, checking routing, output and exit codes. The
// model is never called: no API key is set.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runExitCode } from "../cli/commands/run.js";
import { EXIT_CODES } from "../cli/core/errors.js";
import { resolveTyrPaths } from "../cli/core/scaffold.js";
import type { RunResult } from "../cli/engine/run.js";
import { makeProject, removeProject } from "./helpers.js";

const CLI = fileURLToPath(new URL("../cli/index.js", import.meta.url));

function cliEnv(configHome: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", TYR_CONFIG_HOME: configHome };
    for (const name of Object.keys(env)) if (name.startsWith("TYR_") && name !== "TYR_CONFIG_HOME") delete env[name];
    delete env.ANTHROPIC_API_KEY;
    return env;
}

function tyr(root: string, env: NodeJS.ProcessEnv, ...args: string[]) {
    return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8", env, timeout: 60_000 });
}

function git(root: string, ...args: string[]): void {
    execFileSync("git", ["-c", "user.name=Tyr", "-c", "user.email=tyr@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root });
}

async function withProject(fn: (root: string, env: NodeJS.ProcessEnv) => Promise<void>, init: boolean): Promise<void> {
    const root = await makeProject({ "package.json": JSON.stringify({ name: "run-cli-fixture" }), "src/index.ts": "export const a = 1;\n" });
    const configHome = await fs.mkdtemp(path.join(os.tmpdir(), "tyr-run-cli-home-"));
    const env = cliEnv(configHome);
    try {
        if (init) {
            git(root, "init", "-q");
            git(root, "add", "-A");
            git(root, "commit", "-q", "-m", "initial");
            const result = tyr(root, env, "init", "--no-verify", "--no-gitignore", "--no-color");
            assert.equal(result.status, 0, `tyr init failed:\n${result.stdout}\n${result.stderr}`);
            const { configFile } = resolveTyrPaths(root);
            const config = JSON.parse(await fs.readFile(configFile, "utf8"));
            for (const kind of ["build", "test", "lint", "typecheck", "format"]) config.commands[kind] = null;
            config.commands.build = { command: `node -e "process.exit(0)"`, tool: "node", evidence: "package.json", source: "user" };
            config.commands.test = { command: `node -e "process.exit(2)"`, tool: "node", evidence: "package.json", source: "user" };
            await fs.writeFile(configFile, `${JSON.stringify(config, null, 4)}\n`);
        }
        await fn(root, env);
    } finally {
        await removeProject(root);
        await fs.rm(configHome, { recursive: true, force: true });
    }
}

test("tyr run: not initialized exits NOT_INITIALIZED with a hint", async () => {
    await withProject(async (root, env) => {
        const result = tyr(root, env, "run", "run the tests");
        assert.equal(result.status, EXIT_CODES.NOT_INITIALIZED, result.stderr);
        assert.match(result.stderr, /not initialized/);
        assert.match(result.stderr, /tyr init/);
    }, false);
});

test("tyr run: a passing check exits 0, a failing one exits 1", async () => {
    await withProject(async (root, env) => {
        const build = tyr(root, env, "run", "build");
        assert.equal(build.status, EXIT_CODES.OK, build.stdout + build.stderr);
        assert.match(build.stdout, /Tyr will run build\./);
        assert.match(build.stdout, /build passed/);
        assert.match(build.stdout, /1\/1 checks passed/);
        assert.match(build.stdout, /Report: .*\.tyr[/\\]reports[/\\].*-run-build\.md/);

        const test = tyr(root, env, "run", "run the tests");
        assert.equal(test.status, EXIT_CODES.FAILURE, test.stdout + test.stderr);
        assert.match(test.stdout + test.stderr, /test failed with exit code 2/);
    }, true);
});

test("tyr run --json prints one RunResult on stdout and nothing else", async () => {
    await withProject(async (root, env) => {
        const result = tyr(root, env, "run", "build", "--json");
        assert.equal(result.status, EXIT_CODES.OK, result.stderr);
        const parsed = JSON.parse(result.stdout) as RunResult;
        assert.equal(parsed.runVersion, 1);
        assert.equal(parsed.status, "succeeded");
        assert.deepEqual(parsed.intent, { mode: "checks", checks: ["build"], all: false });
        assert.equal(parsed.checks[0]!.outcome, "passed");
        assert.ok(parsed.report !== null);
        assert.doesNotMatch(result.stdout, /build passed/);
    }, true);
});

test("tyr run: --mode overrides the route; questions without a key fail clearly", async () => {
    await withProject(async (root, env) => {
        const ask = tyr(root, env, "run", "--mode", "ask", "build");
        assert.equal(ask.status, EXIT_CODES.FAILURE);
        assert.match(ask.stdout + ask.stderr, /Cannot answer: no API key/);

        const bad = tyr(root, env, "run", "--mode", "nope", "build");
        assert.equal(bad.status, EXIT_CODES.USAGE);

        const empty = tyr(root, env, "run", "   ");
        assert.equal(empty.status, EXIT_CODES.USAGE);
        assert.match(empty.stderr, /prompt is empty/);
    }, true);
});

test("tyr run --agent: flag validation, no key, and the --json record", async () => {
    await withProject(async (root, env) => {
        const stray = tyr(root, env, "run", "--apply", "fix it");
        assert.equal(stray.status, EXIT_CODES.USAGE);
        assert.match(stray.stderr, /--apply only works with --agent/);

        const both = tyr(root, env, "run", "--agent", "reviewer", "--mode", "ask", "hi");
        assert.equal(both.status, EXIT_CODES.USAGE);
        assert.match(both.stderr, /--agent and --mode/);

        const unknown = tyr(root, env, "run", "--agent", "janitor", "hi");
        assert.equal(unknown.status, EXIT_CODES.USAGE);

        const text = tyr(root, env, "run", "--agent", "reviewer", "review my changes");
        assert.equal(text.status, EXIT_CODES.FAILURE, text.stdout + text.stderr);
        assert.match(text.stdout + text.stderr, /Tyr will run the reviewer agent\./);
        assert.match(text.stdout + text.stderr, /Cannot run the reviewer agent: no API key/);

        const json = tyr(root, env, "run", "--agent", "fixer", "--apply", "--isolate", "fix the tests", "--json");
        assert.equal(json.status, EXIT_CODES.FAILURE, json.stderr);
        const parsed = JSON.parse(json.stdout) as RunResult;
        assert.deepEqual(parsed.intent, { mode: "agent", role: "fixer", task: "fix the tests" });
        assert.equal(parsed.status, "error");
        assert.equal((parsed.agent as { status?: string } | null)?.status, "skipped");
        assert.ok(parsed.report !== null);
    }, true);
});

test("tyr agents list --json shows the roles and no worktrees", async () => {
    await withProject(async (root, env) => {
        const result = tyr(root, env, "agents", "list", "--json");
        assert.equal(result.status, EXIT_CODES.OK, result.stderr);
        const parsed = JSON.parse(result.stdout) as { ok: boolean; roles: Array<{ id: string; permission: string }>; worktrees: unknown[] };
        assert.equal(parsed.ok, true);
        assert.deepEqual(
            parsed.roles.map((r) => [r.id, r.permission]),
            [
                ["reviewer", "read"],
                ["fixer", "write"],
                ["test-runner", "execute"],
            ],
        );
        assert.deepEqual(parsed.worktrees, []);

        const clean = tyr(root, env, "agents", "clean", "--json");
        assert.equal(clean.status, EXIT_CODES.OK, clean.stderr);
        assert.deepEqual(JSON.parse(clean.stdout), { ok: true, removed: [], failed: [] });
    }, true);
});

test("runExitCode maps statuses", () => {
    assert.equal(runExitCode({ status: "succeeded" }), EXIT_CODES.OK);
    assert.equal(runExitCode({ status: "failed" }), EXIT_CODES.FAILURE);
    assert.equal(runExitCode({ status: "error" }), EXIT_CODES.FAILURE);
    assert.equal(runExitCode({ status: "cancelled" }), EXIT_CODES.INTERRUPTED);
});
