import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

import { appendEvent, readEvents } from "../cli/core/events.js";
import { buildConfig } from "../cli/core/scaffold.js";
import type { InitSnapshot, ProjectCommand } from "../cli/core/types.js";
import { startEngine, type Engine } from "../cli/engine/engine.js";
import type { CheckKind, CheckRun } from "../cli/engine/model.js";
import { readEngineState } from "../cli/engine/repo-state.js";
import type { ReviewPassResult } from "../cli/engine/review.js";
import { listReports } from "../cli/core/reports.js";
import type { TyrNotification } from "../cli/integrations/notify.js";
import { makeProject, removeProject } from "./helpers.js";

const NODE = JSON.stringify(process.execPath);
const node = (code: string): string => `${NODE} -e ${JSON.stringify(code)}`;

function snapshot(root: string, commands: Partial<Record<CheckKind, string>>): InitSnapshot {
    const cmd = (command: string | undefined): ProjectCommand | null => (command === undefined ? null : { tool: "t", command, evidence: "package.json" });
    return {
        discovery: { root, alreadyInitialized: false, files: [], fileCount: 0, skippedDirs: [] },
        git: { isRepo: false, branch: null, detached: false, headCommit: null, status: null, statusTimedOut: false, remotes: [], defaultRemote: null },
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

async function project(commands: Partial<Record<CheckKind, string>>): Promise<string> {
    const root = await makeProject({});
    await fs.mkdir(path.join(root, ".tyr", "state"), { recursive: true });
    await fs.writeFile(path.join(root, ".tyr", "tyr.json"), JSON.stringify(buildConfig(snapshot(root, commands), "1.0.0")), "utf8");
    return root;
}

/** Start an engine with fast timings; resolves runs as they finish. */
async function start(root: string, expectRuns: number): Promise<{ engine: Engine; runs: Promise<CheckRun[]> }> {
    const finished: CheckRun[] = [];
    let resolve!: (runs: CheckRun[]) => void;
    const runs = new Promise<CheckRun[]>((r) => (resolve = r));
    const engine = await startEngine(root, {
        notifier: false,
        log: () => undefined,
        scheduler: { idleMs: 50, commitDelayMs: 10, settleMs: 0 },
        journal: { forcePolling: true, pollIntervalMs: 20 },
        onRun: (run) => {
            finished.push(run);
            if (finished.length === expectRuns) resolve(finished);
        },
    });
    return { engine, runs };
}

function editEvent(root: string) {
    return appendEvent(root, {
        source: "fs",
        kind: "fs.changed",
        message: "1 file changed: a.ts",
        data: { added: [], modified: ["a.ts"], removed: [], total: 1, truncated: false },
    });
}

describe("engine", () => {
    let configHome: string;
    const previous = process.env.TYR_CONFIG_HOME;
    before(async () => {
        // Keep the user's real global settings out of loadCheckCommands.
        configHome = await makeProject({});
        process.env.TYR_CONFIG_HOME = configHome;
    });
    after(async () => {
        if (previous === undefined) delete process.env.TYR_CONFIG_HOME;
        else process.env.TYR_CONFIG_HOME = previous;
        await removeProject(configHome);
    });

    it("runs checks after an edit, records problems and journals results", async () => {
        const root = await project({ build: node("process.exit(0)"), test: node("console.error('1 test failed'); process.exit(1)") });
        const { engine, runs } = await start(root, 2);
        try {
            await editEvent(root);
            const [build, test] = await runs;
            assert.equal(build!.kind, "build");
            assert.equal(build!.outcome, "passed");
            assert.equal(test!.kind, "test");
            assert.equal(test!.outcome, "failed");
            assert.equal(test!.trigger.reason, "idle");

            const state = await readEngineState(root);
            assert.equal(state.checks.build?.lastGood?.id, build!.id);
            assert.equal(state.checks.test?.last?.outcome, "failed");
            assert.deepEqual(
                state.problems.map((p) => p.key),
                ["check:test"],
            );
            assert.match(state.problems[0]!.detail, /1 test failed/);

            const kinds = (await readEvents(root, { sources: ["check"] })).map((e) => e.kind);
            assert.deepEqual(kinds.sort(), ["check.failed", "check.passed", "check.started", "check.started"]);
        } finally {
            await engine.close();
            await removeProject(root);
        }
    });

    it("skips tests when the build fails", async () => {
        const root = await project({ build: node("process.exit(2)"), lint: node("process.exit(0)"), test: node("process.exit(0)") });
        const { engine, runs } = await start(root, 2);
        try {
            engine.scheduler.requestRun("manual");
            const finished = await runs;
            await engine.scheduler.idle();
            assert.deepEqual(
                finished.map((r) => `${r.kind}:${r.outcome}`),
                ["build:failed", "lint:passed"],
            );
        } finally {
            await engine.close();
            await removeProject(root);
        }
    });

    it("close() cancels a check in progress", async () => {
        const root = await project({ test: node("setTimeout(() => {}, 60000)") });
        const { engine, runs } = await start(root, 1);
        try {
            engine.scheduler.requestRun("manual");
            // Wait until the check has started.
            for (let i = 0; i < 100; i++) {
                if ((await readEvents(root, { kinds: ["check.started"] })).length > 0) break;
                await new Promise((r) => setTimeout(r, 20));
            }
            const began = Date.now();
            await engine.close();
            const [run] = await runs;
            assert.equal(run!.outcome, "cancelled");
            assert.ok(Date.now() - began < 10_000);
            assert.deepEqual((await readEngineState(root)).problems, [], "a cancelled run opens no problem");
        } finally {
            await removeProject(root);
        }
    });

    it("reviews each pass: findings from output, a regression after a pass, a report", async () => {
        const root = await project({ typecheck: node("process.exit(Number(require('fs').readFileSync('mode','utf8')))") });
        await fs.writeFile(path.join(root, "mode"), "0");
        const reviews: ReviewPassResult[] = [];
        const engine = await startEngine(root, {
            notifier: false,
            log: () => undefined,
            scheduler: { idleMs: 50, commitDelayMs: 10, settleMs: 0 },
            journal: { forcePolling: true, pollIntervalMs: 20 },
            onReview: (result) => reviews.push(result),
        });
        try {
            engine.scheduler.requestRun("manual");
            await engine.scheduler.idle();
            assert.equal(reviews[0]!.findings.length, 0, "passing pass: nothing to report");
            assert.equal(reviews[0]!.report, null);

            await fs.writeFile(path.join(root, "mode"), "1");
            engine.scheduler.requestRun("manual");
            await engine.scheduler.idle();
            const failing = reviews[1]!;
            assert.equal(failing.findings.length, 1);
            assert.equal(failing.findings[0]!.checkKind, "typecheck");
            assert.equal(failing.regressions.length, 1, "it passed before: a regression");
            assert.ok(failing.report);
            assert.equal((await listReports(root)).length, 1);
            assert.equal((await readEvents(root, { kinds: ["review.completed"] })).length, 2);
        } finally {
            await engine.close();
            await removeProject(root);
        }
    });

    it("notifies once when a check regresses, and again when it recovers", async () => {
        const root = await project({ typecheck: node("process.exit(Number(require('fs').readFileSync('mode','utf8')))") });
        await fs.writeFile(path.join(root, "mode"), "0");
        const sent: TyrNotification[] = [];
        const engine = await startEngine(root, {
            notifier: { notify: async (note) => (sent.push(note), { sent: true, results: [], event: null }) },
            log: () => undefined,
            scheduler: { idleMs: 50, commitDelayMs: 10, settleMs: 0 },
            journal: { forcePolling: true, pollIntervalMs: 20 },
        });
        try {
            engine.scheduler.requestRun("manual");
            await engine.scheduler.idle();
            assert.equal(sent.length, 0, "passing from the start: nothing to say");

            await fs.writeFile(path.join(root, "mode"), "1");
            engine.scheduler.requestRun("manual");
            await engine.scheduler.idle();
            assert.equal(sent.length, 1);
            assert.equal(sent[0]!.title, "Tyr: typecheck regressed");
            assert.equal(sent[0]!.severity, "error");

            engine.scheduler.requestRun("manual");
            await engine.scheduler.idle();
            assert.equal(sent.length, 1, "still failing: no news");

            await fs.writeFile(path.join(root, "mode"), "0");
            engine.scheduler.requestRun("manual");
            await engine.scheduler.idle();
            assert.equal(sent.length, 2);
            assert.equal(sent[1]!.title, "Tyr: typecheck passing again");
            assert.equal(sent[1]!.severity, "info");
        } finally {
            await engine.close();
            await removeProject(root);
        }
    });

    it("does nothing without enabled checks", async () => {
        const root = await project({});
        const { engine } = await start(root, 1);
        try {
            engine.scheduler.requestRun("manual");
            await engine.scheduler.idle();
            assert.deepEqual(await readEvents(root, { sources: ["check"] }), []);
        } finally {
            await engine.close();
            await removeProject(root);
        }
    });
});
