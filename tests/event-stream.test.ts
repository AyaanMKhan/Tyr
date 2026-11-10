// event-stream.ts and daemon-requests.ts: the live journal reader and the
// CLI -> daemon request channel.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { appendEvent, eventsFile, type TyrEvent } from "../cli/core/events.js";
import { followEvents, type EventFollower, type FollowEventsOptions } from "../cli/core/event-stream.js";
import {
    daemonRequestsDir,
    pingDaemon,
    readDaemonRequests,
    sendDaemonRequest,
    serviceDaemonRequests,
} from "../cli/core/daemon-requests.js";
import { isProcessAlive, startDaemon, stopDaemon } from "../cli/core/daemon.js";
import type { TyrState } from "../cli/core/types.js";
import { makeProject, removeProject } from "./helpers.js";

/** Collect events from a follower; `until` resolves once `n` have arrived. */
async function collect(
    root: string,
    options: Omit<FollowEventsOptions, "onEvent"> = {},
): Promise<{ events: TyrEvent[]; follower: EventFollower; until: (n: number, ms?: number) => Promise<void> }> {
    const events: TyrEvent[] = [];
    // Not persistent: a failed assertion that skips close() must not keep the test process alive.
    const follower = await followEvents(root, {
        pollIntervalMs: 20,
        persistent: false,
        ...options,
        onEvent: (event) => events.push(event),
    });
    const until = async (n: number, ms = 5000): Promise<void> => {
        const deadline = Date.now() + ms;
        while (events.length < n) {
            if (Date.now() > deadline) {
                throw new Error(`timed out with ${events.length}/${n} events: ${events.map((e) => e.kind).join(",")}`);
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    };
    return { events, follower, until };
}

const settle = (ms = 150): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

for (const forcePolling of [false, true]) {
    const mode = forcePolling ? "poll" : "watch";

    test(`followEvents (${mode}): delivers appended events live, not the existing history`, async () => {
        const root = await makeProject({});
        try {
            await appendEvent(root, { source: "tyr", kind: "old.one" });
            const { events, follower, until } = await collect(root, { forcePolling });
            assert.equal(follower.mode, mode);
            await appendEvent(root, { source: "tyr", kind: "new.one" });
            await appendEvent(root, { source: "git", kind: "new.two" });
            await until(2);
            await settle();
            assert.deepEqual(events.map((e) => e.kind), ["new.one", "new.two"]);
            follower.close();
            await follower.done;
        } finally {
            await removeProject(root);
        }
    });

    test(`followEvents (${mode}): rotation mid-follow loses and duplicates nothing`, async () => {
        const root = await makeProject({});
        try {
            const { events, follower, until } = await collect(root, { forcePolling });
            // Every append rotates; keep enough rotated files that none is
            // deleted before the follower reaches it.
            const opts = { maxBytes: 1, keep: 50 };
            for (let i = 0; i < 20; i++) {
                await appendEvent(root, { source: "tyr", kind: `n.${i}` }, opts);
                if (i % 5 === 0) await settle(30); // Let some rotations be seen one at a time.
            }
            await until(20);
            await settle();
            assert.deepEqual(
                events.map((e) => e.kind),
                Array.from({ length: 20 }, (_, i) => `n.${i}`),
            );
            follower.close();
            await follower.done;
        } finally {
            await removeProject(root);
        }
    });

    test(`followEvents (${mode}): a rotation storm racing the reader stays exact`, async () => {
        const root = await makeProject({});
        try {
            // A 1ms poll makes directory listings overlap rotations constantly,
            // which is where a stale listing could skip a whole file.
            const { events, follower, until } = await collect(root, { forcePolling, pollIntervalMs: 1 });
            const opts = { maxBytes: 1, keep: 500 };
            for (let i = 0; i < 120; i++) await appendEvent(root, { source: "tyr", kind: `s.${i}` }, opts);
            await until(120, 15_000);
            await settle();
            assert.deepEqual(
                events.map((e) => e.kind),
                Array.from({ length: 120 }, (_, i) => `s.${i}`),
            );
            follower.close();
            await follower.done;
        } finally {
            await removeProject(root);
        }
    });
}

test("followEvents: a line split across writes is delivered once, when complete", async () => {
    const root = await makeProject({ ".tyr/state/events.jsonl": "" });
    try {
        const { events, follower, until } = await collect(root);
        const event = { v: 1, id: "split-1", ts: new Date().toISOString(), source: "tyr", kind: "split.line", message: "héllo ✓" };
        const bytes = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
        // Cut inside the multi-byte "✓" to prove bytes, not strings, are buffered.
        const cut = bytes.indexOf(Buffer.from("✓", "utf8")) + 1;
        await fs.appendFile(eventsFile(root), bytes.subarray(0, cut));
        await settle(200);
        assert.equal(events.length, 0, "no event until the newline arrives");
        await fs.appendFile(eventsFile(root), bytes.subarray(cut));
        await until(1);
        assert.equal(events[0].message, "héllo ✓");
        assert.equal(events[0].id, "split-1");
        follower.close();
        await follower.done;
    } finally {
        await removeProject(root);
    }
});

test("followEvents: backlog and since replay history, then go live without duplicates", async () => {
    const root = await makeProject({});
    try {
        const t = (s: number) => new Date(Date.UTC(2026, 10, 1, 0, 0, s));
        for (let i = 0; i < 5; i++) await appendEvent(root, { source: "tyr", kind: `h.${i}`, ts: t(i) });

        const last = await collect(root, { backlog: 2 });
        await appendEvent(root, { source: "tyr", kind: "live.0" });
        await last.until(3);
        await settle();
        assert.deepEqual(last.events.map((e) => e.kind), ["h.3", "h.4", "live.0"]);
        last.follower.close();

        const since = await collect(root, { since: t(2) });
        await appendEvent(root, { source: "tyr", kind: "live.1" });
        await since.until(5);
        await settle();
        assert.deepEqual(since.events.map((e) => e.kind), ["h.2", "h.3", "h.4", "live.0", "live.1"]);
        since.follower.close();
        await Promise.all([last.follower.done, since.follower.done]);
    } finally {
        await removeProject(root);
    }
});

test("followEvents: events racing the backlog read are delivered exactly once", async () => {
    const root = await makeProject({});
    try {
        for (let i = 0; i < 50; i++) await appendEvent(root, { source: "tyr", kind: "pre" });
        // Appends run concurrently with the backlog read and the tail start.
        const writer = (async () => {
            for (let i = 0; i < 50; i++) await appendEvent(root, { source: "tyr", kind: "race" });
        })();
        const { events, follower, until } = await collect(root, { backlog: 1000 });
        await writer;
        await until(100);
        await settle();
        assert.equal(events.length, 100);
        assert.equal(new Set(events.map((e) => e.id)).size, 100);
        follower.close();
        await follower.done;
    } finally {
        await removeProject(root);
    }
});

test("followEvents: sources and kinds filter both backlog and live events", async () => {
    const root = await makeProject({});
    try {
        await appendEvent(root, { source: "git", kind: "git.head" });
        await appendEvent(root, { source: "tyr", kind: "daemon.started" });
        const { events, follower, until } = await collect(root, { backlog: 10, sources: ["git", "tyr"], kinds: ["git.", "daemon"] });
        await appendEvent(root, { source: "claude", kind: "git.fake" }); // wrong source
        await appendEvent(root, { source: "tyr", kind: "daemon.stopped" });
        await appendEvent(root, { source: "tyr", kind: "daemonish" }); // not a dotted child
        await appendEvent(root, { source: "git", kind: "git.refs" });
        await until(4);
        await settle();
        assert.deepEqual(events.map((e) => e.kind), ["git.head", "daemon.started", "daemon.stopped", "git.refs"]);
        follower.close();
        await follower.done;
    } finally {
        await removeProject(root);
    }
});

test("followEvents: waits for a missing state dir and file, then reads from the start", async () => {
    const root = await makeProject({});
    try {
        const { events, follower, until } = await collect(root);
        await settle(100);
        await appendEvent(root, { source: "tyr", kind: "first" });
        await appendEvent(root, { source: "tyr", kind: "second" });
        await until(2);
        assert.deepEqual(events.map((e) => e.kind), ["first", "second"]);
        follower.close();
        await follower.done;
    } finally {
        await removeProject(root);
    }
});

test("followEvents: close() and AbortSignal stop delivery and resolve done", async () => {
    const root = await makeProject({});
    try {
        const closed = await collect(root);
        closed.follower.close();
        closed.follower.close(); // idempotent
        await closed.follower.done;

        const controller = new AbortController();
        const aborted = await collect(root, { signal: controller.signal });
        controller.abort();
        await aborted.follower.done;

        const pre = new AbortController();
        pre.abort();
        await appendEvent(root, { source: "tyr", kind: "history" });
        const never = await collect(root, { signal: pre.signal, backlog: 10 });
        await never.follower.done;

        await appendEvent(root, { source: "tyr", kind: "after.close" });
        await settle(200);
        assert.deepEqual([closed.events, aborted.events, never.events], [[], [], []]);
    } finally {
        await removeProject(root);
    }
});

test("followEvents: an exception in onEvent does not stop the stream", async () => {
    const root = await makeProject({});
    try {
        const seen: string[] = [];
        const follower = await followEvents(root, {
            pollIntervalMs: 20,
            persistent: false,
            onEvent: (event) => {
                seen.push(event.kind);
                throw new Error("consumer bug");
            },
        });
        await appendEvent(root, { source: "tyr", kind: "a" });
        await appendEvent(root, { source: "tyr", kind: "b" });
        const deadline = Date.now() + 5000;
        while (seen.length < 2 && Date.now() < deadline) await settle(10);
        assert.deepEqual(seen, ["a", "b"]);
        follower.close();
        await follower.done;
    } finally {
        await removeProject(root);
    }
});

/* -------------------------------------------------------------------------
 * Requests
 * ---------------------------------------------------------------------- */

test("requests: written atomically, consumed exactly once, stale and malformed ones dropped", async () => {
    const root = await makeProject({});
    try {
        assert.deepEqual(await readDaemonRequests(root), [], "no directory yet");
        const stop = await sendDaemonRequest(root, { type: "stop" });
        const ping = await sendDaemonRequest(root, { type: "ping" });
        assert.ok(stop !== null && ping !== null);
        assert.equal(await sendDaemonRequest(root, { type: "bogus" as "ping" }), null);

        const dir = daemonRequestsDir(root);
        await fs.writeFile(path.join(dir, "1-abc.json"), "not json");
        await fs.writeFile(path.join(dir, ".in-flight.json.123.tmp"), "{}"); // a write in progress

        const read = await readDaemonRequests(root);
        assert.deepEqual(read.map((r) => r.type).sort(), ["ping", "stop"]);
        assert.deepEqual(await readDaemonRequests(root), [], "consumed");
        assert.deepEqual(await fs.readdir(dir), [".in-flight.json.123.tmp"]);

        await sendDaemonRequest(root, { type: "stop" });
        const later = Date.now() + 10 * 60 * 1000;
        assert.deepEqual(await readDaemonRequests(root, { now: () => later }), [], "stale stop is ignored");
    } finally {
        await removeProject(root);
    }
});

test("requests: serviceDaemonRequests answers a ping and reports a stop", async () => {
    const root = await makeProject({});
    try {
        // Stand-in daemon: services the request directory on a short timer.
        const daemon = setInterval(() => void serviceDaemonRequests(root), 20);
        try {
            const rtt = await pingDaemon(root, 5000);
            assert.ok(rtt !== null && rtt >= 0, `expected a round trip, got ${rtt}`);
        } finally {
            clearInterval(daemon);
        }

        await sendDaemonRequest(root, { type: "stop" });
        const result = await serviceDaemonRequests(root);
        assert.equal(result.stop, true);
        assert.deepEqual(result.handled.map((r) => r.type), ["stop"]);

        // Nobody answering: null, and the request is withdrawn.
        assert.equal(await pingDaemon(root, 150), null);
        assert.deepEqual(await fs.readdir(daemonRequestsDir(root)), []);
    } finally {
        await removeProject(root);
    }
});

test("requests: ping round-trip and stop request against a real daemon", { timeout: 30_000 }, async () => {
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
    const root = await makeProject({
        ".tyr/tyr.json": "{}\n",
        ".tyr/state/state.json": JSON.stringify(state),
        ".tyr/logs/tyr.log": "",
    });
    let pid: number | null = null;
    try {
        // A leftover request from before the start must not be acted on.
        await sendDaemonRequest(root, { type: "stop" });
        const started = await startDaemon(root, { readyTimeoutMs: 10_000 });
        pid = started.pid;
        assert.equal(started.ready, true);

        const rtt = await pingDaemon(root, 5000);
        assert.ok(rtt !== null, "daemon answered");
        assert.ok(isProcessAlive(pid), "the leftover stop was cleared at start");

        const { events, follower, until } = await collect(root, { kinds: ["daemon.stopped"] });
        await sendDaemonRequest(root, { type: "stop" });
        await until(1, 10_000);
        follower.close();
        await follower.done;
        assert.equal(events[0].data?.pid, pid);

        const deadline = Date.now() + 10_000;
        while (isProcessAlive(pid) && Date.now() < deadline) await settle(50);
        assert.equal(isProcessAlive(pid), false);
        pid = null;
    } finally {
        if (pid !== null && isProcessAlive(pid)) await stopDaemon(root, { timeoutMs: 5000 }).catch(() => undefined);
        await removeProject(root);
    }
});
