// daemon.ts: PID-file liveness, stale detection, and a real start/stop cycle.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import {
    isProcessAlive,
    readDaemonStatus,
    resolveDaemonPaths,
    startDaemon,
    stopDaemon,
} from "../cli/core/daemon.js";
import { readState, resolveTyrPaths } from "../cli/core/scaffold.js";
import type { TyrState } from "../cli/core/types.js";
import { makeProject, removeProject } from "./helpers.js";

/** A minimal initialized project: just enough of `.tyr/` for the daemon. */
async function makeInitializedProject(): Promise<string> {
    const now = new Date().toISOString();
    const state: TyrState = {
        version: 1,
        status: "initialized",
        createdAt: now,
        updatedAt: now,
        lastIndexedCommit: null,
        lastScanFileCount: 0,
        runCount: 0,
        lastRunAt: null,
    };
    return makeProject({
        ".tyr/tyr.json": "{}\n",
        ".tyr/state/state.json": JSON.stringify(state),
        ".tyr/logs/tyr.log": "",
    });
}

/** A pid guaranteed dead: a child that has already exited. */
async function deadPid(): Promise<number> {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise((resolve) => child.once("exit", resolve));
    assert.ok(child.pid !== undefined);
    return child.pid;
}

test("isProcessAlive: true for this process, false for an exited one", async () => {
    assert.equal(isProcessAlive(process.pid), true);
    assert.equal(isProcessAlive(await deadPid()), false);
});

test("readDaemonStatus: no PID file means not running and not stale", async () => {
    const root = await makeInitializedProject();
    try {
        assert.deepEqual(await readDaemonStatus(root), { running: false, pid: null, startedAt: null, stale: false });
    } finally {
        await removeProject(root);
    }
});

test("readDaemonStatus: a live pid is running, a dead or garbled one is stale", async () => {
    const root = await makeInitializedProject();
    const { pidFile } = resolveDaemonPaths(root);
    try {
        await fs.writeFile(pidFile, JSON.stringify({ pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z" }));
        const live = await readDaemonStatus(root);
        assert.equal(live.running, true);
        assert.equal(live.stale, false);
        assert.equal(live.pid, process.pid);
        assert.equal(live.startedAt, "2026-01-01T00:00:00.000Z");

        const dead = await deadPid();
        await fs.writeFile(pidFile, JSON.stringify({ pid: dead, startedAt: "" }));
        assert.deepEqual(await readDaemonStatus(root), { running: false, pid: dead, startedAt: null, stale: true });

        await fs.writeFile(pidFile, "not json");
        assert.deepEqual(await readDaemonStatus(root), { running: false, pid: null, startedAt: null, stale: true });
    } finally {
        await removeProject(root);
    }
});

test("startDaemon: a live PID file is reported as already running, nothing is spawned", async () => {
    const root = await makeInitializedProject();
    try {
        // This test process stands in for a running daemon.
        await fs.writeFile(resolveDaemonPaths(root).pidFile, JSON.stringify({ pid: process.pid, startedAt: "" }));
        const result = await startDaemon(root);
        assert.equal(result.alreadyRunning, true);
        assert.equal(result.pid, process.pid);
        assert.equal((await readState(root))?.status, "initialized");
    } finally {
        await removeProject(root);
    }
});

test("stopDaemon: clears a stale PID file and a state left at running", async () => {
    const root = await makeInitializedProject();
    try {
        const stateFile = resolveTyrPaths(root).stateFile;
        const state = JSON.parse(await fs.readFile(stateFile, "utf8")) as TyrState;
        await fs.writeFile(stateFile, JSON.stringify({ ...state, status: "running", pid: 1 }));
        await fs.writeFile(resolveDaemonPaths(root).pidFile, JSON.stringify({ pid: await deadPid(), startedAt: "" }));

        const result = await stopDaemon(root);
        assert.deepEqual(result, { pid: null, graceful: true, staleCleared: true });
        assert.equal((await readDaemonStatus(root)).stale, false);
        assert.equal((await readState(root))?.status, "stopped");
    } finally {
        await removeProject(root);
    }
});

test("startDaemon + stopDaemon: real background process lifecycle", { timeout: 30_000 }, async () => {
    const root = await makeInitializedProject();
    let pid: number | null = null;
    try {
        // A dead daemon's leftover PID file must not block a fresh start.
        await fs.writeFile(resolveDaemonPaths(root).pidFile, JSON.stringify({ pid: await deadPid(), startedAt: "" }));

        const started = await startDaemon(root, { readyTimeoutMs: 10_000 });
        pid = started.pid;
        assert.equal(started.alreadyRunning, false);
        assert.equal(started.replacedStale, true);
        assert.equal(started.ready, true);
        assert.equal(isProcessAlive(pid), true);

        const state = await readState(root);
        assert.equal(state?.status, "running");
        assert.equal(state?.pid, pid);
        assert.equal(state?.runCount, 1);
        assert.equal((await readDaemonStatus(root)).pid, pid);

        // Duplicate prevention against a real daemon.
        const again = await startDaemon(root);
        assert.deepEqual([again.alreadyRunning, again.pid], [true, pid]);

        const stopped = await stopDaemon(root, { timeoutMs: 10_000 });
        assert.equal(stopped.pid, pid);
        assert.equal(stopped.graceful, true);
        assert.equal(isProcessAlive(pid), false);
        pid = null;

        const after = await readState(root);
        assert.equal(after?.status, "stopped");
        assert.equal(after?.pid, null);
        assert.deepEqual(await readDaemonStatus(root), { running: false, pid: null, startedAt: null, stale: false });

        const log = await fs.readFile(resolveTyrPaths(root).logFile, "utf8");
        assert.match(log, /Background process started/);
        assert.match(log, /Background process stopped \(tyr stop\)/);
    } finally {
        // Never leave a daemon behind, even when an assertion failed.
        if (pid !== null && isProcessAlive(pid)) {
            try {
                process.kill(pid);
            } catch {
                // Already gone.
            }
        }
        await removeProject(root);
    }
});
