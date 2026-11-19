// status.ts: collectStatus against temp projects — not initialized, a real
// `tyr init` (the compiled CLI), corrupt tyr.json, findings from reports and
// from findings.json, engine.json, drift after a commit, and a stale daemon.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDaemonPaths } from "../cli/core/daemon.js";
import { writeReport } from "../cli/core/reports.js";
import { readState, resolveTyrPaths, writeState } from "../cli/core/scaffold.js";
import { collectStatus, type InitializedStatus, type StatusReport } from "../cli/core/status.js";
import { makeFinding } from "../cli/engine/findings.js";
import type { CheckRun } from "../cli/engine/model.js";
import { applyCheckRun, emptyEngineState, writeEngineState } from "../cli/engine/repo-state.js";
import { FINDINGS_STATE_VERSION, findingsStateFile } from "../cli/engine/review.js";
import { makeProject, removeProject } from "./helpers.js";

const CLI = fileURLToPath(new URL("../cli/index.js", import.meta.url));
const NOW = new Date("2026-11-17T12:00:00.000Z");
const NOT_RUNNING = async () => ({ running: false, pid: null, startedAt: null, stale: false });

function git(root: string, ...args: string[]): string {
    return execFileSync("git", ["-c", "user.name=Tyr", "-c", "user.email=tyr@example.com", "-c", "commit.gpgsign=false", ...args], {
        cwd: root,
        encoding: "utf8",
    }).trim();
}

/** A git repo with one commit, initialized by the real `tyr init`. */
async function makeInitializedRepo(): Promise<{ root: string; cleanup: () => Promise<void> }> {
    const root = await makeProject({
        "package.json": JSON.stringify({ name: "status-fixture", scripts: { test: "node --test" } }),
        "src/index.ts": "export const a = 1;\n",
        "README.md": "# fixture\n",
    });
    // Keep the user's global settings out of the fixture.
    const configHome = await fs.mkdtemp(path.join(os.tmpdir(), "tyr-status-home-"));
    git(root, "init", "-q");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "initial");
    const result = spawnSync(process.execPath, [CLI, "init", "--no-verify", "--no-gitignore", "--no-color"], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, TYR_CONFIG_HOME: configHome, NO_COLOR: "1" },
    });
    assert.equal(result.status, 0, `tyr init failed:\n${result.stdout}\n${result.stderr}`);
    return {
        root,
        cleanup: async () => {
            await removeProject(root);
            await fs.rm(configHome, { recursive: true, force: true });
        },
    };
}

function initialized(report: StatusReport): InitializedStatus {
    assert.equal(report.initialized, true, JSON.stringify(report));
    return report as InitializedStatus;
}

/** A pid guaranteed dead: a child that has already exited. */
async function deadPid(): Promise<number> {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise((resolve) => child.once("exit", resolve));
    assert.ok(child.pid !== undefined);
    return child.pid;
}

test("collectStatus: no .tyr/ or no tyr.json reports not initialized", async () => {
    const root = await makeProject({ "package.json": "{}\n" });
    try {
        const none = await collectStatus(root, { now: NOW });
        assert.deepEqual(none, {
            statusVersion: 1,
            initialized: false,
            root,
            collectedAt: NOW.toISOString(),
            reason: "no-tyr-dir",
            suggestion: "tyr init",
        });

        await fs.mkdir(path.join(root, ".tyr", "state"), { recursive: true });
        const empty = await collectStatus(root, { now: NOW });
        assert.equal(empty.initialized, false);
        assert.equal(empty.initialized === false && empty.reason, "no-config");
        // Serializable as-is.
        assert.deepEqual(JSON.parse(JSON.stringify(empty)), empty);
    } finally {
        await removeProject(root);
    }
});

test("collectStatus: a freshly initialized repo has a profile, state and no drift", async () => {
    const { root, cleanup } = await makeInitializedRepo();
    try {
        const head = git(root, "rev-parse", "HEAD");
        const report = initialized(await collectStatus(root, { now: NOW, daemonStatus: NOT_RUNNING }));

        assert.deepEqual(report.warnings, []);
        assert.equal(report.root, root);
        assert.ok(report.project !== null);
        assert.equal(report.project.name, "status-fixture");
        assert.equal(report.project.packageManager, "npm");
        assert.ok(report.project.languages.some((language) => language.name === "TypeScript"));
        assert.equal(report.project.commands.test?.command, "npm test");
        assert.equal(report.project.git.isRepo, true);
        assert.ok(report.project.tyrVersion.length > 0);

        assert.ok(report.state !== null);
        assert.equal(report.state.status, "initialized");
        assert.equal(report.state.runCount, 0);
        assert.equal(report.lastRun.lastRunAt, null);
        assert.equal(report.lastRun.reportCount, 0);

        assert.deepEqual(report.daemon, { running: false, pid: null, startedAt: null, uptimeMs: null, stale: false });
        assert.equal(report.findings.source, "none");
        assert.equal(report.findings.total, 0);
        assert.deepEqual(report.findings.counts, { critical: 0, error: 0, warning: 0, info: 0 });
        assert.equal(report.engine, null);

        assert.equal(report.drift.isRepo, true);
        assert.equal(report.drift.indexedHead, head);
        assert.equal(report.drift.currentHead, head);
        assert.equal(report.drift.headChanged, false);
        assert.equal(report.drift.commitsSinceIndex, 0);
        assert.equal(report.drift.indexedFileCount, 3);
        assert.equal(report.drift.currentFileCount, 3);
        assert.equal(report.drift.fileCountDelta, 0);
        assert.equal(report.drift.filesAdded, 0);
        assert.equal(report.drift.filesRemoved, 0);

        assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
    } finally {
        await cleanup();
    }
});

test("collectStatus: drift after a new commit and added files", async () => {
    const { root, cleanup } = await makeInitializedRepo();
    try {
        const indexed = git(root, "rev-parse", "HEAD");
        await fs.writeFile(path.join(root, "src", "b.ts"), "export const b = 2;\n");
        git(root, "add", "src/b.ts");
        git(root, "commit", "-q", "-m", "add b");
        // Untracked but not ignored: counted by the scan, like init would.
        await fs.writeFile(path.join(root, "notes.md"), "draft\n");
        await fs.rm(path.join(root, "README.md"));

        const report = initialized(await collectStatus(root, { now: NOW, daemonStatus: NOT_RUNNING }));
        const head = git(root, "rev-parse", "HEAD");
        assert.equal(report.drift.indexedHead, indexed);
        assert.equal(report.drift.currentHead, head);
        assert.equal(report.drift.headChanged, true);
        assert.equal(report.drift.commitsSinceIndex, 1);
        assert.equal(report.drift.indexedFileCount, 3);
        assert.equal(report.drift.currentFileCount, 4);
        assert.equal(report.drift.fileCountDelta, 1);
        assert.equal(report.drift.filesAdded, 2);
        assert.equal(report.drift.filesRemoved, 1);

        const skipped = initialized(await collectStatus(root, { now: NOW, daemonStatus: NOT_RUNNING, scanFiles: false }));
        assert.equal(skipped.drift.currentFileCount, null);
        assert.equal(skipped.drift.fileCountDelta, null);
        assert.equal(skipped.drift.headChanged, true);
    } finally {
        await cleanup();
    }
});

test("collectStatus: drift outside a git repo has null heads", async () => {
    const { root, cleanup } = await makeInitializedRepo();
    try {
        await fs.rm(path.join(root, ".git"), { recursive: true, force: true });
        const report = initialized(await collectStatus(root, { now: NOW, daemonStatus: NOT_RUNNING }));
        assert.equal(report.drift.isRepo, false);
        assert.equal(report.drift.currentHead, null);
        assert.equal(report.drift.currentBranch, null);
        assert.equal(report.drift.headChanged, null);
        assert.equal(report.drift.commitsSinceIndex, null);
        assert.equal(typeof report.drift.currentFileCount, "number");
    } finally {
        await cleanup();
    }
});

test("collectStatus: a corrupt tyr.json is a warning, not a crash", async () => {
    const { root, cleanup } = await makeInitializedRepo();
    try {
        await fs.writeFile(resolveTyrPaths(root).configFile, "{ not json");
        const report = initialized(await collectStatus(root, { now: NOW, daemonStatus: NOT_RUNNING }));
        assert.equal(report.project, null);
        const configWarnings = report.warnings.filter((warning) => warning.source === "config");
        assert.equal(configWarnings.length, 1);
        assert.match(configWarnings[0].message, /^tyr\.json: malformed JSON/);
        // The rest still comes through.
        assert.ok(report.state !== null);
        assert.equal(report.drift.headChanged, false);

        await fs.writeFile(resolveTyrPaths(root).configFile, JSON.stringify({ version: 999 }));
        const newer = initialized(await collectStatus(root, { now: NOW, daemonStatus: NOT_RUNNING, scanFiles: false }));
        assert.equal(newer.project, null);
        assert.ok(newer.warnings.some((warning) => warning.source === "config"));
    } finally {
        await cleanup();
    }
});

test("collectStatus: findings come from the newest review report when the engine has none", async () => {
    const root = await makeProject({ ".tyr/tyr.json": "{}\n" });
    try {
        await writeReport(
            root,
            { kind: "review", title: "old", findings: [{ severity: "info", title: "old note" }] },
            { now: new Date("2026-11-01T00:00:00Z"), retention: false },
        );
        const written = await writeReport(
            root,
            {
                kind: "review",
                title: "2 findings",
                findings: [
                    { severity: "warning", title: "unused variable", file: "src/a.ts", line: 3, rule: "no-unused" },
                    { severity: "critical", title: "leaked key", file: "src/b.ts", line: 1 },
                ],
            },
            { now: new Date("2026-11-02T00:00:00Z"), retention: false },
        );
        const report = initialized(await collectStatus(root, { now: NOW, daemonStatus: NOT_RUNNING, scanFiles: false }));
        assert.equal(report.findings.source, "report");
        assert.equal(report.findings.reportId, written.id);
        assert.equal(report.findings.total, 2);
        assert.deepEqual(report.findings.counts, { critical: 1, error: 0, warning: 1, info: 0 });
        assert.equal(report.findings.items[0].title, "leaked key");
        assert.deepEqual(report.findings.items[1], { severity: "warning", title: "unused variable", file: "src/a.ts", line: 3, rule: "no-unused" });

        assert.equal(report.lastRun.reportCount, 2);
        assert.equal(report.lastRun.recentReports[0].id, written.id);
        assert.deepEqual(report.lastRun.recentReports[0].findingCounts, { critical: 1, error: 0, warning: 1, info: 0 });

        // tyr.json "{}" is invalid: reported, not thrown.
        assert.equal(report.project, null);
        assert.ok(report.warnings.some((warning) => warning.source === "config"));
    } finally {
        await removeProject(root);
    }
});

test("collectStatus: findings.json is authoritative, threshold-filtered and capped", async () => {
    const root = await makeProject({ ".tyr/tyr.json": "{}\n" });
    try {
        await writeReport(root, { kind: "review", title: "stale", findings: [{ severity: "error", title: "fixed long ago" }] }, { retention: false });
        const findings = [
            makeFinding({ source: "check", checkKind: "test", severity: "error", title: "test failed", file: "a.test.ts", regression: true }),
            makeFinding({ source: "diff", severity: "warning", title: "console.log left in", file: "src/a.ts", line: 4 }),
            makeFinding({ source: "diff", severity: "warning", title: "TODO added", file: "src/b.ts", line: 9 }),
            makeFinding({ source: "diff", severity: "info", title: "large change" }),
        ];
        await fs.mkdir(resolveTyrPaths(root).stateDir, { recursive: true });
        await fs.writeFile(
            findingsStateFile(root),
            JSON.stringify({ version: FINDINGS_STATE_VERSION, updatedAt: "2026-11-17T11:00:00.000Z", findings, reportId: null }),
        );

        const report = initialized(await collectStatus(root, { now: NOW, daemonStatus: NOT_RUNNING, scanFiles: false, threshold: "warning", maxFindings: 2 }));
        assert.equal(report.findings.source, "engine");
        assert.equal(report.findings.updatedAt, "2026-11-17T11:00:00.000Z");
        assert.equal(report.findings.threshold, "warning");
        assert.equal(report.findings.total, 3);
        assert.deepEqual(report.findings.counts, { critical: 0, error: 1, warning: 2, info: 0 });
        assert.equal(report.findings.regressions, 1);
        assert.equal(report.findings.items.length, 2);
        assert.equal(report.findings.truncated, true);
        assert.equal(report.findings.items[0].title, "test failed");
        assert.equal(report.findings.items[0].source, "check");
        assert.equal(report.findings.items[0].regression, true);
        assert.equal(typeof report.findings.items[0].fingerprint, "string");

        const all = initialized(await collectStatus(root, { now: NOW, daemonStatus: NOT_RUNNING, scanFiles: false, threshold: "info" }));
        assert.equal(all.findings.total, 4);
        assert.equal(all.findings.truncated, false);
    } finally {
        await removeProject(root);
    }
});

test("collectStatus: engine.json is summarized", async () => {
    const root = await makeProject({ ".tyr/tyr.json": "{}\n" });
    try {
        const run = (outcome: CheckRun["outcome"], finishedAt: string, exitCode: number): CheckRun => ({
            id: `run-${finishedAt}`,
            kind: "test",
            command: "npm test",
            cwd: root,
            trigger: { reason: "idle" },
            startedAt: finishedAt,
            finishedAt,
            durationMs: 1200,
            outcome,
            exitCode,
            signal: null,
            stdout: "",
            stderr: "1 failing",
            outputTruncated: false,
            headCommit: null,
        });
        let state = applyCheckRun(emptyEngineState(), run("passed", "2026-11-17T10:00:00.000Z", 0), new Date("2026-11-17T10:00:00Z"));
        state = applyCheckRun(state, run("failed", "2026-11-17T11:00:00.000Z", 1), new Date("2026-11-17T11:00:00Z"));
        await writeEngineState(root, state);

        const report = initialized(await collectStatus(root, { now: NOW, daemonStatus: NOT_RUNNING, scanFiles: false }));
        assert.ok(report.engine !== null);
        assert.equal(report.engine.healthy, false);
        assert.equal(report.engine.checks.length, 1);
        assert.equal(report.engine.checks[0].kind, "test");
        assert.equal(report.engine.checks[0].outcome, "failed");
        assert.equal(report.engine.checks[0].trigger, "idle");
        assert.equal(report.engine.checks[0].lastPassedAt, "2026-11-17T10:00:00.000Z");
        assert.equal(report.engine.problems.length, 1);
        assert.equal(report.engine.problems[0].key, "check:test");
        assert.equal(report.engine.problems[0].regression, true);

        await fs.writeFile(path.join(resolveTyrPaths(root).stateDir, "engine.json"), "garbage");
        const broken = initialized(await collectStatus(root, { now: NOW, daemonStatus: NOT_RUNNING, scanFiles: false }));
        assert.equal(broken.engine, null);
        assert.ok(broken.warnings.some((warning) => warning.source === "engine"));
    } finally {
        await removeProject(root);
    }
});

test("collectStatus: a stale PID file shows the daemon as not running", async () => {
    const { root, cleanup } = await makeInitializedRepo();
    try {
        const pid = await deadPid();
        await fs.writeFile(resolveDaemonPaths(root).pidFile, JSON.stringify({ pid, startedAt: "2026-11-17T09:00:00.000Z" }));
        const state = await readState(root);
        assert.ok(state !== null);
        await writeState(root, { ...state, status: "running", pid, runCount: 3, lastRunAt: "2026-11-17T09:30:00.000Z" });

        const report = initialized(await collectStatus(root, { now: NOW, scanFiles: false }));
        assert.equal(report.daemon.running, false);
        assert.equal(report.daemon.stale, true);
        assert.equal(report.daemon.pid, pid);
        assert.equal(report.daemon.uptimeMs, null);
        assert.equal(report.state?.status, "running");
        assert.equal(report.lastRun.runCount, 3);
        assert.equal(report.lastRun.lastRunAt, "2026-11-17T09:30:00.000Z");
        const daemonWarnings = report.warnings.filter((warning) => warning.source === "daemon").map((w) => w.message);
        assert.equal(daemonWarnings.length, 2);
        assert.match(daemonWarnings[0], /stale PID file/);
        assert.match(daemonWarnings[1], /says running/);

        // A live daemon reports uptime from the injected clock.
        const live = initialized(
            await collectStatus(root, {
                now: NOW,
                scanFiles: false,
                daemonStatus: async () => ({ running: true, pid: process.pid, startedAt: "2026-11-17T11:00:00.000Z", stale: false }),
            }),
        );
        assert.equal(live.daemon.uptimeMs, 60 * 60 * 1000);
        assert.ok(!live.warnings.some((warning) => warning.source === "daemon"));
    } finally {
        await cleanup();
    }
});
