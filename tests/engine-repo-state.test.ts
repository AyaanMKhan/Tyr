// engine/repo-state.ts: the check-run reducer, engine.json persistence, and
// working-tree snapshots against real throwaway repos.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CheckKind, CheckOutcome, CheckRun } from "../cli/engine/model.js";
import {
    MAX_SNAPSHOT_FILES,
    PROBLEM_DETAIL_MAX_CHARS,
    PROBLEM_DETAIL_MAX_LINES,
    applyCheckRun,
    emptyEngineState,
    engineStateFile,
    isHealthy,
    openProblems,
    readEngineState,
    recordCheckRun,
    refreshWorkingTree,
    snapshotWorkingTree,
    updateEngineState,
    writeEngineState,
} from "../cli/engine/repo-state.js";
import { makeProject, removeProject } from "./helpers.js";

let counter = 0;

function run(kind: CheckKind, outcome: CheckOutcome, at: string, extra: Partial<CheckRun> = {}): CheckRun {
    counter += 1;
    return {
        id: `run-${counter}`,
        kind,
        command: `npm run ${kind}`,
        cwd: "/project",
        trigger: { reason: "manual" },
        startedAt: at,
        finishedAt: at,
        durationMs: 10,
        outcome,
        exitCode: outcome === "passed" ? 0 : outcome === "failed" ? 1 : null,
        signal: null,
        stdout: "out\n",
        stderr: outcome === "failed" ? "boom\n" : "",
        outputTruncated: false,
        headCommit: null,
        ...extra,
    };
}

const T1 = "2026-01-01T00:00:01.000Z";
const T2 = "2026-01-01T00:00:02.000Z";
const T3 = "2026-01-01T00:00:03.000Z";
const NOW = new Date("2026-01-02T00:00:00.000Z");

function git(root: string, ...args: string[]): string {
    return execFileSync("git", ["-c", "user.name=Tyr", "-c", "user.email=tyr@example.com", ...args], {
        cwd: root,
        encoding: "utf8",
    });
}

/* -------------------------------------------------------------------------
 * Reducer
 * ---------------------------------------------------------------------- */

test("a failing run from scratch opens a non-regression problem", () => {
    const failed = run("test", "failed", T1);
    const state = applyCheckRun(emptyEngineState(), failed, NOW);

    assert.equal(state.updatedAt, NOW.toISOString());
    assert.equal(state.checks.test?.last?.id, failed.id);
    assert.equal(state.checks.test?.lastGood, null);
    assert.ok(!("stdout" in (state.checks.test?.last ?? {})));
    assert.ok(!("stderr" in (state.checks.test?.last ?? {})));

    assert.equal(state.problems.length, 1);
    const problem = state.problems[0];
    assert.equal(problem.key, "check:test");
    assert.equal(problem.kind, "test");
    assert.equal(problem.regression, false);
    assert.equal(problem.firstSeenRunId, failed.id);
    assert.equal(problem.lastSeenRunId, failed.id);
    assert.equal(problem.firstSeenAt, T1);
    assert.equal(problem.detail, "boom");
    assert.equal(isHealthy(state), false);
});

test("a pass records lastGood and closes the problem", () => {
    let state = applyCheckRun(emptyEngineState(), run("test", "failed", T1), NOW);
    const passed = run("test", "passed", T2);
    state = applyCheckRun(state, passed, NOW);

    assert.deepEqual(state.problems, []);
    assert.equal(state.checks.test?.last?.id, passed.id);
    assert.equal(state.checks.test?.lastGood?.id, passed.id);
    assert.equal(isHealthy(state), true);
});

test("a fail after a pass is a regression", () => {
    let state = applyCheckRun(emptyEngineState(), run("build", "passed", T1), NOW);
    state = applyCheckRun(state, run("build", "failed", T2), NOW);
    assert.equal(state.problems[0].regression, true);
    // lastGood survives the failure.
    assert.equal(state.checks.build?.lastGood?.finishedAt, T1);
});

test("a timeout opens a problem and the detail falls back to stdout", () => {
    const timedOut = run("lint", "timeout", T1, { stdout: "partial lint output\n", stderr: "" });
    const state = applyCheckRun(emptyEngineState(), timedOut, NOW);
    assert.equal(state.problems.length, 1);
    assert.match(state.problems[0].title, /timed out/);
    assert.equal(state.problems[0].detail, "partial lint output");
});

test("refreshing a problem keeps firstSeen and regression, updates lastSeen and detail", () => {
    const first = run("test", "failed", T1, { stderr: "first failure\n" });
    let state = applyCheckRun(emptyEngineState(), first, NOW);
    // A later pass on another kind must not disturb it.
    state = applyCheckRun(state, run("lint", "passed", T2), NOW);
    const second = run("test", "failed", T3, { stderr: "second failure\n" });
    state = applyCheckRun(state, second, NOW);

    assert.equal(state.problems.length, 1);
    const problem = state.problems[0];
    assert.equal(problem.firstSeenRunId, first.id);
    assert.equal(problem.firstSeenAt, T1);
    assert.equal(problem.lastSeenRunId, second.id);
    assert.equal(problem.lastSeenAt, T3);
    assert.equal(problem.detail, "second failure");
    assert.equal(problem.regression, false);
});

test("error and cancelled runs update last but never open or close problems", () => {
    for (const outcome of ["error", "cancelled"] as const) {
        // Healthy stays healthy.
        const fromClean = applyCheckRun(emptyEngineState(), run("test", outcome, T1), NOW);
        assert.deepEqual(fromClean.problems, []);
        assert.equal(fromClean.checks.test?.last?.outcome, outcome);
        assert.equal(fromClean.checks.test?.lastGood, null);

        // An open problem stays open, unchanged.
        const failing = applyCheckRun(emptyEngineState(), run("test", "failed", T1), NOW);
        const after = applyCheckRun(failing, run("test", outcome, T2), NOW);
        assert.deepEqual(after.problems, failing.problems);
        assert.equal(after.checks.test?.last?.outcome, outcome);
    }
});

test("problem detail keeps only the last lines, bounded in size", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const state = applyCheckRun(emptyEngineState(), run("test", "failed", T1, { stderr: lines }), NOW);
    const detail = state.problems[0].detail.split("\n");
    assert.equal(detail.length, PROBLEM_DETAIL_MAX_LINES);
    assert.equal(detail.at(-1), "line 49");

    const huge = `${"x".repeat(10_000)}\nend`;
    const big = applyCheckRun(emptyEngineState(), run("test", "failed", T1, { stderr: huge }), NOW);
    assert.ok(big.problems[0].detail.length <= PROBLEM_DETAIL_MAX_CHARS);
    assert.ok(big.problems[0].detail.endsWith("end"));
});

test("openProblems sorts by firstSeenAt", () => {
    let state = applyCheckRun(emptyEngineState(), run("test", "failed", T3), NOW);
    state = applyCheckRun(state, run("build", "failed", T1), NOW);
    state = applyCheckRun(state, run("lint", "failed", T2), NOW);
    assert.deepEqual(
        openProblems(state).map((problem) => problem.kind),
        ["build", "lint", "test"],
    );
});

/* -------------------------------------------------------------------------
 * Persistence
 * ---------------------------------------------------------------------- */

test("engine state round-trips through engine.json", async () => {
    const root = await makeProject({});
    try {
        assert.deepEqual(await readEngineState(root), emptyEngineState());

        const state = applyCheckRun(emptyEngineState(), run("test", "failed", T1), NOW);
        await writeEngineState(root, state);
        assert.equal(engineStateFile(root), path.join(root, ".tyr", "state", "engine.json"));
        assert.deepEqual(await readEngineState(root), state);
    } finally {
        await removeProject(root);
    }
});

test("corrupt or wrong-version engine.json reads as the empty state", async () => {
    const root = await makeProject({});
    try {
        const file = engineStateFile(root);
        await fs.mkdir(path.dirname(file), { recursive: true });

        await fs.writeFile(file, "{ not json", "utf8");
        assert.deepEqual(await readEngineState(root), emptyEngineState());

        await fs.writeFile(file, "[]", "utf8");
        assert.deepEqual(await readEngineState(root), emptyEngineState());

        await fs.writeFile(file, JSON.stringify({ ...emptyEngineState(), version: 99 }), "utf8");
        assert.deepEqual(await readEngineState(root), emptyEngineState());

        await fs.writeFile(file, JSON.stringify({ version: 1, updatedAt: T1, checks: {}, problems: "nope" }), "utf8");
        assert.deepEqual(await readEngineState(root), emptyEngineState());
    } finally {
        await removeProject(root);
    }
});

test("updateEngineState stamps updatedAt, and recordCheckRun persists the reducer", async () => {
    const root = await makeProject({});
    try {
        const later = new Date("2026-03-03T00:00:00.000Z");
        const untouched = await updateEngineState(root, () => null, later);
        assert.deepEqual(untouched, emptyEngineState());
        await assert.rejects(fs.access(engineStateFile(root)));

        const stored = await recordCheckRun(root, run("test", "failed", T1), later);
        assert.equal(stored.updatedAt, later.toISOString());
        assert.equal(stored.problems.length, 1);
        assert.deepEqual(await readEngineState(root), stored);

        // Concurrent updates serialize under the lock: nothing is lost.
        await Promise.all([
            recordCheckRun(root, run("lint", "failed", T2)),
            recordCheckRun(root, run("build", "failed", T3)),
        ]);
        const final = await readEngineState(root);
        assert.deepEqual(final.problems.map((problem) => problem.kind).sort(), ["build", "lint", "test"]);
    } finally {
        await removeProject(root);
    }
});

/* -------------------------------------------------------------------------
 * Working tree
 * ---------------------------------------------------------------------- */

test("snapshotWorkingTree reports uncommitted changes against HEAD", async () => {
    const root = await makeProject({ "a.txt": "one\ntwo\n", "b.txt": "b\n" });
    try {
        git(root, "init", "-q", "-b", "main");
        git(root, "add", ".");
        git(root, "commit", "-q", "-m", "first");
        const head = git(root, "rev-parse", "HEAD").trim();

        const clean = await snapshotWorkingTree(root, NOW);
        assert.ok(clean !== null);
        assert.deepEqual(clean, {
            headCommit: head,
            branch: "main",
            totals: { files: 0, additions: 0, deletions: 0 },
            untracked: 0,
            files: [],
            takenAt: NOW.toISOString(),
        });

        await fs.writeFile(path.join(root, "a.txt"), "one\nTWO\nthree\n");
        await fs.writeFile(path.join(root, "staged.txt"), "s\n");
        git(root, "add", "staged.txt");
        await fs.writeFile(path.join(root, "new.txt"), "n\n");

        const dirty = await snapshotWorkingTree(root, NOW);
        assert.ok(dirty !== null);
        assert.deepEqual(dirty.totals, { files: 2, additions: 3, deletions: 1 });
        assert.equal(dirty.untracked, 1);
        assert.deepEqual([...dirty.files].sort(), ["a.txt", "new.txt", "staged.txt"]);
        assert.equal(dirty.files.at(-1), "new.txt"); // untracked listed after tracked
    } finally {
        await removeProject(root);
    }
});

test("snapshotWorkingTree caps the file list", async () => {
    const files: Record<string, string> = { "seed.txt": "seed\n" };
    const root = await makeProject(files);
    try {
        git(root, "init", "-q");
        git(root, "add", ".");
        git(root, "commit", "-q", "-m", "first");
        for (let i = 0; i < MAX_SNAPSHOT_FILES + 25; i++) {
            await fs.writeFile(path.join(root, `u${i}.txt`), "x\n");
        }
        const snapshot = await snapshotWorkingTree(root, NOW);
        assert.ok(snapshot !== null);
        assert.equal(snapshot.untracked, MAX_SNAPSHOT_FILES + 25);
        assert.equal(snapshot.files.length, MAX_SNAPSHOT_FILES);
    } finally {
        await removeProject(root);
    }
});

test("snapshotWorkingTree handles a repo with no commits", async () => {
    const root = await makeProject({ "a.txt": "x\ny\n", "loose.txt": "l\n" });
    try {
        git(root, "init", "-q", "-b", "trunk");
        git(root, "add", "a.txt");

        const snapshot = await snapshotWorkingTree(root, NOW);
        assert.ok(snapshot !== null);
        assert.equal(snapshot.headCommit, null);
        assert.equal(snapshot.branch, "trunk");
        assert.deepEqual(snapshot.totals, { files: 1, additions: 2, deletions: 0 });
        assert.equal(snapshot.untracked, 1);
        assert.deepEqual(snapshot.files, ["a.txt", "loose.txt"]);
    } finally {
        await removeProject(root);
    }
});

test("snapshotWorkingTree is null outside a repo, and refreshWorkingTree stores the result", async () => {
    const plain = await makeProject({ "a.txt": "x\n" });
    try {
        assert.equal(await snapshotWorkingTree(plain, NOW), null);
        const stored = await refreshWorkingTree(plain, NOW);
        assert.equal(stored.workingTree, null);
        assert.equal(stored.updatedAt, NOW.toISOString());
    } finally {
        await removeProject(plain);
    }

    const repo = await makeProject({ "a.txt": "x\n" });
    try {
        git(repo, "init", "-q");
        const stored = await refreshWorkingTree(repo, NOW);
        assert.ok(stored.workingTree !== null);
        assert.deepEqual((await readEngineState(repo)).workingTree, stored.workingTree);
    } finally {
        await removeProject(repo);
    }
});
