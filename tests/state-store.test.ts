// state-store.ts: locked read-modify-write of state.json and named transitions.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { readState } from "../cli/core/scaffold.js";
import { markError, markRunning, markStopped, recordRun, updateState } from "../cli/core/state-store.js";
import type { TyrState } from "../cli/core/types.js";
import { makeProject, removeProject } from "./helpers.js";

function baseState(overrides: Partial<TyrState> = {}): TyrState {
    const now = "2026-01-01T00:00:00.000Z";
    return {
        version: 1,
        status: "initialized",
        createdAt: now,
        updatedAt: now,
        lastIndexedCommit: null,
        lastScanFileCount: 0,
        runCount: 0,
        lastRunAt: null,
        ...overrides,
    };
}

async function makeStateProject(overrides: Partial<TyrState> = {}): Promise<string> {
    return makeProject({
        ".tyr/tyr.json": "{}\n",
        ".tyr/state/state.json": JSON.stringify(baseState(overrides)),
        ".tyr/logs/tyr.log": "",
    });
}

test("updateState: null when there is no state.json, and nothing is written", async () => {
    const root = await makeProject({});
    try {
        let called = false;
        const result = await updateState(root, (s) => {
            called = true;
            return s;
        });
        assert.equal(result, null);
        assert.equal(called, false);
        assert.equal(await readState(root), null);
    } finally {
        await removeProject(root);
    }
});

test("updateState: mutate returning null leaves the file untouched", async () => {
    const root = await makeStateProject();
    try {
        const result = await updateState(root, () => null);
        assert.equal(result?.updatedAt, "2026-01-01T00:00:00.000Z");
        assert.equal((await readState(root))?.updatedAt, "2026-01-01T00:00:00.000Z");
    } finally {
        await removeProject(root);
    }
});

test("updateState: 20 concurrent increments are all kept", async () => {
    const root = await makeStateProject({ runCount: 5 });
    try {
        await Promise.all(
            Array.from({ length: 20 }, () => updateState(root, (s) => ({ ...s, runCount: s.runCount + 1 }))),
        );
        assert.equal((await readState(root))?.runCount, 25);
    } finally {
        await removeProject(root);
    }
});

test("markRunning: sets running, pid, startedAt, and bumps runCount/lastRunAt", async () => {
    const root = await makeStateProject({ runCount: 2 });
    try {
        const at = new Date("2026-05-05T12:00:00.000Z");
        const state = await markRunning(root, 4321, at);
        assert.equal(state?.status, "running");
        assert.equal(state?.pid, 4321);
        assert.equal(state?.startedAt, at.toISOString());
        assert.equal(state?.lastRunAt, at.toISOString());
        assert.equal(state?.runCount, 3);
        assert.deepEqual(await readState(root), state);
        assert.notEqual(state?.updatedAt, "2026-01-01T00:00:00.000Z");
    } finally {
        await removeProject(root);
    }
});

test("markRunning: null without state.json", async () => {
    const root = await makeProject({});
    try {
        assert.equal(await markRunning(root, 1), null);
    } finally {
        await removeProject(root);
    }
});

test("markStopped / markError: clear pid and set the status", async () => {
    const root = await makeStateProject({ status: "running", pid: 10, runCount: 1 });
    try {
        const stopped = await markStopped(root);
        assert.equal(stopped?.status, "stopped");
        assert.equal(stopped?.pid, null);
        assert.equal(stopped?.runCount, 1, "stopping is not a run");

        await markRunning(root, 11);
        const errored = await markError(root);
        assert.equal(errored?.status, "error");
        assert.equal(errored?.pid, null);
    } finally {
        await removeProject(root);
    }
});

test("onlyIfRunning: a non-running state is left alone", async () => {
    const root = await makeStateProject({ status: "initialized" });
    try {
        assert.equal(await markStopped(root, { onlyIfRunning: true }), null);
        assert.equal((await readState(root))?.status, "initialized");
    } finally {
        await removeProject(root);
    }
});

test("ownerPid: a late shutdown never clobbers a newer daemon's running state", async () => {
    const root = await makeStateProject();
    try {
        await markRunning(root, 100); // old daemon
        await markRunning(root, 200); // its replacement
        assert.equal(await markStopped(root, { ownerPid: 100 }), null);
        assert.equal(await markError(root, { ownerPid: 100 }), null);
        const state = await readState(root);
        assert.equal(state?.status, "running");
        assert.equal(state?.pid, 200);

        // The owner itself may stop it.
        assert.equal((await markStopped(root, { ownerPid: 200 }))?.status, "stopped");
        // And with nobody running, a late finisher may still record its outcome.
        assert.equal((await markError(root, { ownerPid: 100 }))?.status, "error");
    } finally {
        await removeProject(root);
    }
});

test("recordRun: bumps the counters without touching status", async () => {
    const root = await makeStateProject({ status: "stopped", runCount: 4 });
    try {
        const at = new Date("2026-06-01T00:00:00.000Z");
        const state = await recordRun(root, at);
        assert.equal(state?.status, "stopped");
        assert.equal(state?.runCount, 5);
        assert.equal(state?.lastRunAt, at.toISOString());
    } finally {
        await removeProject(root);
    }
});

test("concurrent transitions: interleaved starts and stops lose no runs", async () => {
    const root = await makeStateProject();
    try {
        await Promise.all([
            ...Array.from({ length: 10 }, (_, i) => markRunning(root, 1000 + i)),
            ...Array.from({ length: 10 }, () => recordRun(root)),
            ...Array.from({ length: 5 }, () => markStopped(root, { onlyIfRunning: true })),
        ]);
        assert.equal((await readState(root))?.runCount, 20);
    } finally {
        await removeProject(root);
    }
});
