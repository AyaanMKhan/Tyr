// The `tyr status` command end to end: the compiled CLI against temp
// projects (not initialized, a real `tyr init`, a corrupt tyr.json), in text,
// --quiet and --json modes, checking output and exit codes.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { statusExitCode } from "../cli/commands/status.js";
import { EXIT_CODES } from "../cli/core/errors.js";
import { resolveTyrPaths } from "../cli/core/scaffold.js";
import type { InitializedStatus, StatusReport } from "../cli/core/status.js";
import { makeProject, removeProject } from "./helpers.js";

const CLI = fileURLToPath(new URL("../cli/index.js", import.meta.url));

function cliEnv(configHome: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", TYR_CONFIG_HOME: configHome };
    for (const name of Object.keys(env)) if (name.startsWith("TYR_") && name !== "TYR_CONFIG_HOME") delete env[name];
    return env;
}

function tyr(root: string, env: NodeJS.ProcessEnv, ...args: string[]) {
    return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8", env, timeout: 30_000 });
}

function git(root: string, ...args: string[]): void {
    execFileSync("git", ["-c", "user.name=Tyr", "-c", "user.email=tyr@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root });
}

async function withProject(fn: (root: string, env: NodeJS.ProcessEnv) => Promise<void>, init: boolean): Promise<void> {
    const root = await makeProject({
        "package.json": JSON.stringify({ name: "status-cli-fixture", scripts: { test: "node --test" } }),
        "src/index.ts": "export const a = 1;\n",
    });
    const configHome = await fs.mkdtemp(path.join(os.tmpdir(), "tyr-status-cli-home-"));
    const env = cliEnv(configHome);
    try {
        if (init) {
            git(root, "init", "-q");
            git(root, "add", "-A");
            git(root, "commit", "-q", "-m", "initial");
            const result = tyr(root, env, "init", "--no-verify", "--no-gitignore", "--no-color");
            assert.equal(result.status, 0, `tyr init failed:\n${result.stdout}\n${result.stderr}`);
        }
        await fn(root, env);
    } finally {
        await removeProject(root);
        await fs.rm(configHome, { recursive: true, force: true });
    }
}

test("tyr status: not initialized prints a hint and exits NOT_INITIALIZED", async () => {
    await withProject(async (root, env) => {
        const text = tyr(root, env, "status");
        assert.equal(text.status, EXIT_CODES.NOT_INITIALIZED, text.stderr);
        assert.match(text.stdout, new RegExp(`Tyr is not initialized in ${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
        assert.match(text.stdout, /Run "tyr init" to set it up\./);

        const json = tyr(root, env, "status", "--json");
        assert.equal(json.status, EXIT_CODES.NOT_INITIALIZED, json.stderr);
        const report = JSON.parse(json.stdout) as StatusReport;
        assert.equal(report.initialized, false);
        assert.equal(report.root, root);
        assert.equal(report.statusVersion, 1);
        assert.ok(!report.initialized && report.reason === "no-tyr-dir" && report.suggestion === "tyr init");

        const quiet = tyr(root, env, "status", "--quiet");
        assert.equal(quiet.status, EXIT_CODES.NOT_INITIALIZED);
        assert.match(quiet.stdout, /not initialized.*run "tyr init"/);
        assert.doesNotMatch(quiet.stdout, /Run "tyr init" to set it up/);
    }, false);
});

test("tyr status: an initialized repo reports its profile and exits OK", async () => {
    await withProject(async (root, env) => {
        const json = tyr(root, env, "status", "--json");
        assert.equal(json.status, EXIT_CODES.OK, json.stderr);
        const report = JSON.parse(json.stdout) as InitializedStatus;
        assert.equal(report.initialized, true);
        assert.equal(report.statusVersion, 1);
        assert.equal(report.root, root);
        assert.equal(report.project?.name, "status-cli-fixture");
        assert.equal(report.daemon.running, false);
        assert.equal(report.drift.isRepo, true);
        assert.equal(report.drift.headChanged, false);
        assert.equal(typeof report.drift.currentFileCount, "number");
        for (const key of ["state", "lastRun", "findings", "engine", "warnings", "collectedAt"]) {
            assert.ok(key in report, `missing ${key}`);
        }

        const noScan = JSON.parse(tyr(root, env, "status", "--json", "--no-scan").stdout) as InitializedStatus;
        assert.equal(noScan.drift.currentFileCount, null);

        const text = tyr(root, env, "status");
        assert.equal(text.status, EXIT_CODES.OK, text.stderr);
        assert.match(text.stdout, /^Tyr status: status-cli-fixture$/m);
        assert.match(text.stdout, /^Background\s+\S not running/m);
        assert.match(text.stdout, /^Drift\s+\S up to date with the index/m);
        assert.doesNotMatch(text.stdout, /\x1b\[/);

        const quiet = tyr(root, env, "status", "--quiet");
        assert.equal(quiet.status, EXIT_CODES.OK);
        assert.equal(quiet.stdout, "");

        const verbose = tyr(root, env, "status", "--verbose");
        assert.equal(verbose.status, EXIT_CODES.OK, verbose.stderr);
        assert.match(verbose.stdout, /^\s+lint\s+not configured$/m);
    }, true);
});

test("tyr status: an unusable tyr.json exits CONFIG but still reports", async () => {
    await withProject(async (root, env) => {
        await fs.writeFile(resolveTyrPaths(root).configFile, "{ not json");
        const json = tyr(root, env, "status", "--json", "--no-scan");
        assert.equal(json.status, EXIT_CODES.CONFIG, json.stderr);
        const report = JSON.parse(json.stdout) as InitializedStatus;
        assert.equal(report.project, null);
        assert.ok(report.warnings.some((warning) => warning.source === "config"));

        const text = tyr(root, env, "status", "--no-scan");
        assert.equal(text.status, EXIT_CODES.CONFIG);
        assert.match(text.stdout, /profile unavailable/);
        assert.match(text.stdout, /^Warnings \(\d+\)$/m);

        const quiet = tyr(root, env, "status", "--quiet", "--no-scan");
        assert.match(quiet.stdout, /tyr\.json/);
    }, true);
});

test("statusExitCode maps report shapes to exit codes", () => {
    const base = { statusVersion: 1 as const, root: "/x", collectedAt: "" };
    assert.equal(statusExitCode({ ...base, initialized: false, reason: "no-config", suggestion: "tyr init" }), EXIT_CODES.NOT_INITIALIZED);
});
