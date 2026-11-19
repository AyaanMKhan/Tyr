// cli/engine/bus.ts: journal normalization, the in-process bus, and the
// journal bridge.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { fsBatchToTyrEvent, gitEventToTyrEvent, type TyrEvent, type TyrEventInput } from "../cli/core/events.js";
import { normalizeHookPayload } from "../cli/core/claude-hooks.js";
import { attachJournal, EventBus, normalizeEvent, publish } from "../cli/engine/bus.js";
import type { CheckRun, EngineEvent } from "../cli/engine/model.js";
import { makeProject, removeProject } from "./helpers.js";

/** A hook payload as the journal would store it; fails the test if not recognised. */
function hook(payload: Record<string, unknown>): TyrEventInput {
    const input = normalizeHookPayload(payload);
    assert.ok(input, `hook not recognised: ${JSON.stringify(payload)}`);
    return input;
}

let seq = 0;
function journal(input: TyrEventInput): TyrEvent {
    seq++;
    return {
        v: 1,
        id: `id-${seq}`,
        ts: "2026-11-17T10:00:00.000Z",
        source: input.source,
        kind: input.kind,
        ...(input.message !== undefined ? { message: input.message } : {}),
        ...(input.data !== undefined ? { data: input.data } : {}),
    };
}

function sampleRun(overrides: Partial<CheckRun> = {}): CheckRun {
    return {
        id: "run-1",
        kind: "test",
        command: "npm test",
        cwd: "/tmp/project",
        trigger: { reason: "idle", eventId: "evt-1" },
        startedAt: "2026-11-17T10:00:00.000Z",
        finishedAt: "2026-11-17T10:00:02.000Z",
        durationMs: 2000,
        outcome: "failed",
        exitCode: 1,
        signal: null,
        stdout: "",
        stderr: "1 failing",
        outputTruncated: false,
        headCommit: "abc123",
        ...overrides,
    };
}

/* --------------------------------- normalizeEvent --------------------------------- */

test("normalizeEvent: fs.changed -> file.changed with cause edit", () => {
    const raw = journal(fsBatchToTyrEvent({ added: ["a.ts"], modified: ["b.ts"], removed: [], total: 2, truncated: false }));
    const event = normalizeEvent(raw);
    assert.deepEqual(event, {
        id: raw.id,
        ts: raw.ts,
        raw,
        type: "file.changed",
        added: ["a.ts"],
        modified: ["b.ts"],
        removed: [],
        total: 2,
        cause: "edit",
    });
});

test("normalizeEvent: fs.changed with data.cause git -> cause git; total never below listed", () => {
    const raw = journal({
        source: "fs",
        kind: "fs.changed",
        data: { added: [], modified: ["x", "y"], removed: ["z"], total: 1, cause: "git", gitKind: "head" },
    });
    const event = normalizeEvent(raw);
    assert.equal(event.type, "file.changed");
    if (event.type !== "file.changed") return;
    assert.equal(event.cause, "git");
    assert.equal(event.total, 3);
    // Capped lists: total above the listed count is kept.
    const capped = normalizeEvent(journal({ source: "fs", kind: "fs.changed", data: { modified: ["a"], total: 400 } }));
    assert.equal(capped.type === "file.changed" && capped.total, 400);
    assert.deepEqual(capped.type === "file.changed" && capped.added, []);
});

test("normalizeEvent: git.head with commitChanged -> commit.made", () => {
    const raw = journal(
        gitEventToTyrEvent({
            kind: "head",
            previous: { commit: "aaa", branch: "main", detached: false },
            current: { commit: "bbb", branch: "feature", detached: false },
            commitChanged: true,
            branchChanged: true,
        }),
    );
    const event = normalizeEvent(raw);
    assert.deepEqual(event, {
        id: raw.id,
        ts: raw.ts,
        raw,
        type: "commit.made",
        commit: "bbb",
        previousCommit: "aaa",
        branch: "feature",
        branchChanged: true,
    });
});

test("normalizeEvent: git.head without a commit change, and other git kinds -> other", () => {
    const branchOnly = journal(
        gitEventToTyrEvent({
            kind: "head",
            previous: { commit: "aaa", branch: "main", detached: false },
            current: { commit: "aaa", branch: "other", detached: false },
            commitChanged: false,
            branchChanged: true,
        }),
    );
    assert.equal(normalizeEvent(branchOnly).type, "other");
    assert.equal(normalizeEvent(journal(gitEventToTyrEvent({ kind: "index", staged: ["a"] }))).type, "other");
});

test("normalizeEvent: git.head on an unborn branch keeps null commits", () => {
    const raw = journal({
        source: "git",
        kind: "git.head",
        data: { previous: { commit: null, branch: "main" }, current: { commit: "c1", branch: "main" }, commitChanged: true },
    });
    const event = normalizeEvent(raw);
    assert.equal(event.type, "commit.made");
    if (event.type !== "commit.made") return;
    assert.equal(event.previousCommit, null);
    assert.equal(event.commit, "c1");
    assert.equal(event.branchChanged, false);
});

test("normalizeEvent: claude tool hooks -> claude.tool", () => {
    const use = normalizeEvent(
        journal(
            hook({
                hook_event_name: "PreToolUse",
                session_id: "s1",
                tool_name: "Edit",
                tool_input: { file_path: "/x/a.ts" },
            }),
        ),
    );
    assert.equal(use.type, "claude.tool");
    if (use.type !== "claude.tool") return;
    assert.equal(use.phase, "use");
    assert.equal(use.sessionId, "s1");
    assert.equal(use.tool, "Edit");
    assert.equal("success" in use, false);

    const ok = normalizeEvent(journal(hook({ hook_event_name: "PostToolUse", session_id: "s1", tool_name: "Bash", tool_response: {} })));
    assert.equal(ok.type === "claude.tool" && ok.phase, "result");
    assert.equal(ok.type === "claude.tool" && ok.success, true);

    const failed = normalizeEvent(journal(hook({ hook_event_name: "PostToolUseFailure", session_id: "s1", tool_name: "Bash", error: "boom" })));
    assert.equal(failed.type === "claude.tool" && failed.success, false);
});

test("normalizeEvent: claude.stop and claude.session_end -> claude.stop", () => {
    const stop = normalizeEvent(journal(hook({ hook_event_name: "Stop", session_id: "s2" })));
    assert.equal(stop.type, "claude.stop");
    assert.equal(stop.type === "claude.stop" && stop.sessionId, "s2");
    assert.equal(stop.type === "claude.stop" && stop.sessionEnded, false);

    const end = normalizeEvent(journal(hook({ hook_event_name: "SessionEnd", session_id: "s2", reason: "exit" })));
    assert.equal(end.type === "claude.stop" && end.sessionEnded, true);

    // Subagent stops are not the main session finishing.
    assert.equal(normalizeEvent(journal(hook({ hook_event_name: "SubagentStop", session_id: "s2" }))).type, "other");
});

test("normalizeEvent: check.passed / check.failed with a valid run -> check.result", () => {
    const run = sampleRun();
    const failed = normalizeEvent(journal({ source: "check", kind: "check.failed", data: { run } }));
    assert.equal(failed.type, "check.result");
    assert.deepEqual(failed.type === "check.result" && failed.run, run);

    const passedRun = sampleRun({ outcome: "passed", exitCode: 0, trigger: { reason: "manual" }, headCommit: null });
    const passed = normalizeEvent(journal({ source: "check", kind: "check.passed", data: { run: passedRun } }));
    assert.equal(passed.type, "check.result");

    // check.started is not a result.
    assert.equal(normalizeEvent(journal({ source: "check", kind: "check.started", data: { run } })).type, "other");
});

test("normalizeEvent: malformed payloads and unknown kinds -> other, never throws", () => {
    const cases: TyrEventInput[] = [
        { source: "tyr", kind: "daemon.started" },
        { source: "tyr", kind: "action.taken", data: { anything: 1 } },
        { source: "fs", kind: "fs.changed" },
        { source: "fs", kind: "fs.changed", data: {} },
        { source: "fs", kind: "fs.changed", data: { added: "a.ts" } },
        { source: "fs", kind: "fs.changed", data: { added: [1, 2] } },
        { source: "git", kind: "git.head" },
        { source: "git", kind: "git.head", data: { commitChanged: true } },
        { source: "git", kind: "git.head", data: { commitChanged: "yes", current: { commit: "c" } } },
        { source: "git", kind: "git.head", data: { commitChanged: true, current: "c" } },
        { source: "claude", kind: "claude.tool_use" },
        { source: "claude", kind: "claude.stop", data: [] as unknown as Record<string, unknown> },
        { source: "check", kind: "check.failed" },
        { source: "check", kind: "check.failed", data: { run: null } },
        { source: "check", kind: "check.failed", data: { run: { ...sampleRun(), kind: "deploy" } } },
        { source: "check", kind: "check.passed", data: { run: { ...sampleRun(), outcome: "maybe" } } },
        { source: "check", kind: "check.passed", data: { run: { ...sampleRun(), trigger: {} } } },
        { source: "check", kind: "check.passed", data: { run: { ...sampleRun(), durationMs: "2s" } } },
    ];
    for (const input of cases) {
        const raw = journal(input);
        const event = normalizeEvent(raw);
        assert.equal(event.type, "other", `${input.kind} ${JSON.stringify(input.data)}`);
        assert.equal(event.raw, raw);
        assert.equal(event.id, raw.id);
    }

    // Wrong-typed fields inside a recognised shape degrade to null rather than "other".
    const tool = normalizeEvent(journal({ source: "claude", kind: "claude.tool_result", data: { sessionId: 5, tool: {}, success: "no" } }));
    assert.equal(tool.type, "claude.tool");
    if (tool.type !== "claude.tool") return;
    assert.equal(tool.sessionId, null);
    assert.equal(tool.tool, null);
    assert.equal("success" in tool, false);

    // Not even a valid TyrEvent.
    const garbage = normalizeEvent({} as TyrEvent);
    assert.equal(garbage.type, "other");
    assert.equal(normalizeEvent(null as unknown as TyrEvent).type, "other");
    const throwing = { v: 1, id: "x", ts: "t", source: "fs", kind: "fs.changed" } as TyrEvent;
    Object.defineProperty(throwing, "data", {
        get() {
            throw new Error("nope");
        },
    });
    assert.equal(normalizeEvent(throwing).type, "other");
});

/* ------------------------------------ EventBus ------------------------------------ */

function other(id: string): EngineEvent {
    const raw = journal({ source: "tyr", kind: "x.y" });
    return { id, ts: raw.ts, raw, type: "other" };
}

function stop(id: string): EngineEvent {
    const raw = journal({ source: "claude", kind: "claude.stop" });
    return { id, ts: raw.ts, raw, type: "claude.stop", sessionId: null, sessionEnded: false };
}

test("EventBus: subscribe by type, list and wildcard; unsubscribe", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const offStop = bus.subscribe("claude.stop", (e) => {
        seen.push(`stop:${e.id}:${e.sessionEnded}`);
    });
    const offList = bus.subscribe(["other", "file.changed"], (e) => {
        seen.push(`list:${e.id}`);
    });
    const offAll = bus.subscribe("*", (e) => {
        seen.push(`all:${e.id}`);
    });
    assert.equal(bus.size, 3);

    bus.dispatch(stop("1"));
    bus.dispatch(other("2"));
    assert.deepEqual(seen, ["stop:1:false", "all:1", "list:2", "all:2"]);

    seen.length = 0;
    offStop();
    offStop(); // idempotent
    offList();
    bus.dispatch(stop("3"));
    bus.dispatch(other("4"));
    assert.deepEqual(seen, ["all:3", "all:4"]);

    offAll();
    assert.equal(bus.size, 0);
    seen.length = 0;
    bus.dispatch(other("5"));
    assert.deepEqual(seen, []);
});

test("EventBus: unsubscribe during dispatch stops delivery; subscribe during dispatch starts next event", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    let offSecond = (): void => {};
    bus.subscribe("*", (e) => {
        seen.push(`first:${e.id}`);
        offSecond();
        bus.subscribe("*", (e2) => {
            seen.push(`late:${e2.id}`);
        });
    });
    offSecond = bus.subscribe("*", (e) => {
        seen.push(`second:${e.id}`);
    });
    bus.dispatch(other("1"));
    assert.deepEqual(seen, ["first:1"]);
});

test("EventBus: throwing and rejecting handlers are isolated and reported", async () => {
    const errors: { error: unknown; id: string }[] = [];
    const bus = new EventBus({ onError: (error, event) => errors.push({ error, id: event.id }) });
    const seen: string[] = [];
    bus.subscribe("*", () => {
        throw new Error("sync boom");
    });
    bus.subscribe("*", async () => {
        throw new Error("async boom");
    });
    bus.subscribe("*", (e) => {
        seen.push(e.id);
    });

    assert.doesNotThrow(() => bus.dispatch(other("1")));
    assert.deepEqual(seen, ["1"]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
        errors.map((e) => [(e.error as Error).message, e.id]),
        [
            ["sync boom", "1"],
            ["async boom", "1"],
        ],
    );

    // Without onError, and with an onError that itself throws, dispatch still never throws.
    const quiet = new EventBus();
    quiet.subscribe("*", () => {
        throw new Error("x");
    });
    assert.doesNotThrow(() => quiet.dispatch(other("2")));
    const broken = new EventBus({
        onError: () => {
            throw new Error("hook broke");
        },
    });
    const after: string[] = [];
    broken.subscribe("*", () => Promise.reject(new Error("y")));
    broken.subscribe("*", () => {
        throw new Error("z");
    });
    broken.subscribe("*", (e) => {
        after.push(e.id);
    });
    assert.doesNotThrow(() => broken.dispatch(other("3")));
    assert.deepEqual(after, ["3"]);
    await new Promise((resolve) => setImmediate(resolve));
});

/* --------------------------------- attachJournal --------------------------------- */

async function until(predicate: () => boolean, what: () => string, ms = 5000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out: ${what()}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

test("attachJournal: published journal events reach subscribers normalized, once, in order", async () => {
    const root = await makeProject({});
    try {
        // History before `since` is skipped; history at/after it is replayed.
        await publish(root, { source: "tyr", kind: "old.event", ts: "2020-01-01T00:00:00.000Z" });
        const since = "2026-01-01T00:00:00.000Z";
        await publish(root, { source: "claude", kind: "claude.stop", data: { sessionId: "s1" }, ts: "2026-06-01T00:00:00.000Z" });

        const bus = new EventBus();
        const seen: EngineEvent[] = [];
        bus.subscribe("*", (e) => {
            seen.push(e);
        });
        const detach = await attachJournal(root, bus, { forcePolling: true, pollIntervalMs: 20, persistent: false, since });

        await publish(root, fsBatchToTyrEvent({ added: [], modified: ["src/a.ts"], removed: [], total: 1, truncated: false }));
        await publish(root, { source: "check", kind: "check.passed", data: { run: sampleRun({ outcome: "passed", exitCode: 0 }) } });
        await publish(root, { source: "tyr", kind: "daemon.warning" });

        await until(
            () => seen.length >= 4,
            () => seen.map((e) => e.raw.kind).join(","),
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.deepEqual(
            seen.map((e) => e.type),
            ["claude.stop", "file.changed", "check.result", "other"],
        );

        await detach();
        await detach(); // idempotent
        await publish(root, { source: "tyr", kind: "after.detach" });
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(seen.length, 4);
    } finally {
        await removeProject(root);
    }
});

test("attachJournal: an aborted signal stops delivery", async () => {
    const root = await makeProject({});
    try {
        const bus = new EventBus();
        const seen: string[] = [];
        bus.subscribe("*", (e) => {
            seen.push(e.raw.kind);
        });
        const controller = new AbortController();
        await attachJournal(root, bus, { forcePolling: true, pollIntervalMs: 20, persistent: false, signal: controller.signal });
        await publish(root, { source: "tyr", kind: "first" });
        await until(
            () => seen.length >= 1,
            () => seen.join(","),
        );
        controller.abort();
        await publish(root, { source: "tyr", kind: "second" });
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.deepEqual(seen, ["first"]);
    } finally {
        await removeProject(root);
    }
});
