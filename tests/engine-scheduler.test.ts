import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { createScheduler, type SchedulerTimers } from "../cli/engine/scheduler.js";
import type { CheckTrigger, EngineEvent } from "../cli/engine/model.js";
import type { TyrEvent } from "../cli/core/events.js";

/** Manual clock: advance() fires due timers in order. */
function fakeTimers(): SchedulerTimers & { advance(ms: number): Promise<void> } {
    let now = 0;
    let seq = 0;
    const pending = new Map<number, { at: number; fn: () => void }>();
    return {
        now: () => now,
        setTimeout(fn, ms) {
            const id = ++seq;
            pending.set(id, { at: now + ms, fn });
            return id;
        },
        clearTimeout(handle) {
            pending.delete(handle as number);
        },
        async advance(ms) {
            const target = now + ms;
            for (;;) {
                const due = [...pending.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
                if (due === undefined) break;
                pending.delete(due[0]);
                now = due[1].at;
                due[1].fn();
                await flush();
            }
            now = target;
            await flush();
        },
    };
}

async function flush(): Promise<void> {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

let counter = 0;
function raw(kind: string): TyrEvent {
    return { v: 1, id: `e${++counter}`, ts: new Date(0).toISOString(), source: "tyr", kind };
}

function fileChanged(cause: "edit" | "git" = "edit"): EngineEvent {
    const r = raw("fs.changed");
    return { type: "file.changed", id: r.id, ts: r.ts, raw: r, added: [], modified: ["a.ts"], removed: [], total: 1, cause };
}

function commit(): EngineEvent {
    const r = raw("git.head");
    return { type: "commit.made", id: r.id, ts: r.ts, raw: r, commit: "abc", previousCommit: "def", branch: "main", branchChanged: false };
}

function tool(sessionId = "s1"): EngineEvent {
    const r = raw("claude.tool_use");
    return { type: "claude.tool", id: r.id, ts: r.ts, raw: r, phase: "use", sessionId, tool: "Edit" };
}

function stop(sessionId = "s1"): EngineEvent {
    const r = raw("claude.stop");
    return { type: "claude.stop", id: r.id, ts: r.ts, raw: r, sessionId, sessionEnded: false };
}

/** runChecks that records triggers and finishes when release() is called (or instantly). */
function recorder(manual = false) {
    const triggers: CheckTrigger[] = [];
    const releases: (() => void)[] = [];
    const runChecks = (trigger: CheckTrigger): Promise<void> => {
        triggers.push(trigger);
        if (!manual) return Promise.resolve();
        return new Promise((resolve) => releases.push(resolve));
    };
    return { triggers, runChecks, release: () => releases.shift()?.() };
}

const opts = { idleMs: 1000, commitDelayMs: 100, settleMs: 500, claudeActiveTimeoutMs: 10_000 };

describe("engine scheduler", () => {
    it("runs on idle after edits, once per quiet period", async () => {
        const timers = fakeTimers();
        const rec = recorder();
        const s = createScheduler({ ...opts, timers, runChecks: rec.runChecks });
        s.handle(fileChanged());
        await timers.advance(600);
        s.handle(fileChanged());
        await timers.advance(600);
        assert.equal(rec.triggers.length, 0, "the second edit restarts the idle timer");
        await timers.advance(500);
        assert.deepEqual(rec.triggers.map((t) => t.reason), ["idle"]);
        await timers.advance(5000);
        assert.equal(rec.triggers.length, 1);
        s.close();
    });

    it("ignores file changes made by git operations", async () => {
        const timers = fakeTimers();
        const rec = recorder();
        const s = createScheduler({ ...opts, timers, runChecks: rec.runChecks });
        s.handle(fileChanged("git"));
        await timers.advance(5000);
        assert.equal(rec.triggers.length, 0);
        s.close();
    });

    it("runs on commit, coalescing bursts", async () => {
        const timers = fakeTimers();
        const rec = recorder();
        const s = createScheduler({ ...opts, timers, runChecks: rec.runChecks });
        const first = commit();
        const last = commit();
        s.handle(first);
        await timers.advance(50);
        s.handle(last);
        await timers.advance(200);
        assert.deepEqual(rec.triggers, [{ reason: "commit", eventId: last.id }]);
        s.close();
    });

    it("defers to Claude's Stop while a session is mid-turn", async () => {
        const timers = fakeTimers();
        const rec = recorder();
        const s = createScheduler({ ...opts, timers, runChecks: rec.runChecks });
        s.handle(tool());
        s.handle(fileChanged());
        await timers.advance(3000);
        assert.equal(rec.triggers.length, 0, "no idle run while Claude is working");
        assert.deepEqual(s.status().activeSessions, ["s1"]);
        const end = stop();
        s.handle(end);
        await flush();
        assert.deepEqual(rec.triggers, [{ reason: "claude-stop", eventId: end.id }]);
        assert.deepEqual(s.status().activeSessions, []);
        s.close();
    });

    it("does not run on Stop when nothing changed", async () => {
        const timers = fakeTimers();
        const rec = recorder();
        const s = createScheduler({ ...opts, timers, runChecks: rec.runChecks });
        s.handle(tool());
        s.handle(stop());
        await timers.advance(5000);
        assert.equal(rec.triggers.length, 0);
        s.close();
    });

    it("stops deferring to a session that went silent", async () => {
        const timers = fakeTimers();
        const rec = recorder();
        const s = createScheduler({ ...opts, timers, runChecks: rec.runChecks });
        s.handle(tool());
        s.handle(fileChanged());
        await timers.advance(12_000);
        assert.deepEqual(rec.triggers.map((t) => t.reason), ["idle"]);
        s.close();
    });

    it("never overlaps runs and queues the highest-priority trigger", async () => {
        const timers = fakeTimers();
        const rec = recorder(true);
        const s = createScheduler({ ...opts, timers, runChecks: rec.runChecks });
        s.requestRun("startup");
        assert.equal(s.status().running?.reason, "startup");
        s.requestRun("idle");
        s.requestRun("commit");
        s.requestRun("idle");
        assert.equal(s.status().queued?.reason, "commit");
        assert.equal(rec.triggers.length, 1);
        rec.release();
        await flush();
        assert.deepEqual(rec.triggers.map((t) => t.reason), ["startup", "commit"]);
        rec.release();
        await s.idle();
        assert.equal(rec.triggers.length, 2);
        s.close();
    });

    it("ignores the checks' own output, but not Claude's edits during a run", async () => {
        const timers = fakeTimers();
        const rec = recorder(true);
        const s = createScheduler({ ...opts, timers, runChecks: rec.runChecks });
        s.requestRun("manual");
        s.handle(fileChanged()); // a build writing artifacts
        rec.release();
        await flush();
        await timers.advance(100);
        s.handle(fileChanged()); // still within settleMs
        await timers.advance(5000);
        assert.equal(rec.triggers.length, 1, "check output must not retrigger");

        s.requestRun("manual");
        s.handle(tool());
        s.handle(fileChanged()); // Claude edited while checks ran
        rec.release();
        await flush();
        s.handle(stop());
        await flush();
        assert.deepEqual(rec.triggers.map((t) => t.reason), ["manual", "manual", "claude-stop"]);
        rec.release();
        await s.idle();
        s.close();
    });

    it("reports a failing runChecks and keeps scheduling", async () => {
        const timers = fakeTimers();
        const errors: unknown[] = [];
        let calls = 0;
        const s = createScheduler({
            ...opts,
            timers,
            onError: (error) => errors.push(error),
            runChecks: () => {
                calls++;
                throw new Error("boom");
            },
        });
        s.requestRun("manual");
        await s.idle();
        s.requestRun("manual");
        await s.idle();
        assert.equal(calls, 2);
        assert.equal(errors.length, 2);
        s.close();
    });

    it("close() cancels pending triggers", async () => {
        const timers = fakeTimers();
        const rec = recorder();
        const s = createScheduler({ ...opts, timers, runChecks: rec.runChecks });
        s.handle(fileChanged());
        s.handle(commit());
        s.close();
        await timers.advance(5000);
        s.requestRun("manual");
        assert.equal(rec.triggers.length, 0);
    });
});
