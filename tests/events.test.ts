// events.ts: append-only JSONL history at .tyr/state/events.jsonl.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appendEvent, eventsFile, gitEventToTyrEvent, readEvents } from "../cli/core/events.js";
import type { GitHeadState } from "../cli/core/git-watch.js";
import { makeProject, removeProject } from "./helpers.js";

const EVENTS_MODULE = pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli", "core", "events.js"),
).href;

test("appendEvent writes one JSON line per event and readEvents returns them", async () => {
    const root = await makeProject({});
    try {
        const stored = await appendEvent(root, { source: "tyr", kind: "daemon.started", message: "hi", data: { pid: 1 } });
        assert.ok(stored !== null);
        assert.equal(stored.v, 1);
        assert.ok(stored.id.length > 0);
        assert.ok(!Number.isNaN(Date.parse(stored.ts)));

        await appendEvent(root, { source: "git", kind: "git.head", message: "multi\nline" });
        const raw = await fs.readFile(eventsFile(root), "utf8");
        assert.equal(raw.split("\n").length, 3, "two lines plus trailing newline");
        assert.equal(eventsFile(root), path.join(root, ".tyr", "state", "events.jsonl"));

        const events = await readEvents(root);
        assert.deepEqual(events.map((e) => e.kind), ["daemon.started", "git.head"]);
        assert.deepEqual(events[0], stored);
        assert.equal(events[1].message, "multi\nline");
    } finally {
        await removeProject(root);
    }
});

test("readEvents on a missing store is empty; appendEvent never throws", async () => {
    const root = await makeProject({});
    try {
        assert.deepEqual(await readEvents(root), []);
        // state/ is a file, so the append cannot succeed: null, not an exception.
        await fs.mkdir(path.join(root, ".tyr"), { recursive: true });
        await fs.writeFile(path.join(root, ".tyr", "state"), "not a dir");
        assert.equal(await appendEvent(root, { source: "tyr", kind: "x" }), null);
    } finally {
        await removeProject(root);
    }
});

test("filters: since/until, sources, kind prefixes, limit, newestFirst", async () => {
    const root = await makeProject({});
    try {
        const t = (s: number) => new Date(Date.UTC(2026, 10, 1, 0, 0, s));
        await appendEvent(root, { source: "tyr", kind: "daemon.started", ts: t(1) });
        await appendEvent(root, { source: "git", kind: "git.head", ts: t(2) });
        await appendEvent(root, { source: "git", kind: "git.refs", ts: t(3) });
        await appendEvent(root, { source: "claude", kind: "claude.tool_use", ts: t(4) });
        await appendEvent(root, { source: "tyr", kind: "daemon.stopped", ts: t(5) });

        const kinds = async (opts: Parameters<typeof readEvents>[1]) => (await readEvents(root, opts)).map((e) => e.kind);
        assert.deepEqual(await kinds({ since: t(2), until: t(3).toISOString() }), ["git.head", "git.refs"]);
        assert.deepEqual(await kinds({ sources: ["tyr", "claude"] }), ["daemon.started", "claude.tool_use", "daemon.stopped"]);
        assert.deepEqual(await kinds({ kinds: ["git."] }), ["git.head", "git.refs"]);
        assert.deepEqual(await kinds({ kinds: ["daemon"] }), ["daemon.started", "daemon.stopped"]);
        assert.deepEqual(await kinds({ kinds: ["daemon.start"] }), []);
        assert.deepEqual(await kinds({ limit: 2 }), ["claude.tool_use", "daemon.stopped"]);
        assert.deepEqual(await kinds({ limit: 2, newestFirst: true }), ["daemon.stopped", "claude.tool_use"]);
        assert.deepEqual(await kinds({ limit: 0 }), []);
    } finally {
        await removeProject(root);
    }
});

test("malformed and partial lines are skipped", async () => {
    const good = JSON.stringify({ v: 1, id: "a", ts: "2026-11-01T00:00:00.000Z", source: "tyr", kind: "ok" });
    const root = await makeProject({
        ".tyr/state/events.jsonl": [
            "not json",
            good,
            "",
            "[1,2]",
            JSON.stringify({ v: 1, id: "b", ts: "nope", source: "tyr", kind: "bad-ts" }),
            JSON.stringify({ v: 1, id: "c", ts: "2026-11-01T00:00:00.000Z", kind: "no-source" }),
            '{"v":1,"id":"d","ts":"2026-11-01T00:00:0', // truncated by a crash
        ].join("\r\n"),
    });
    try {
        const events = await readEvents(root);
        assert.deepEqual(events.map((e) => e.id), ["a"]);
    } finally {
        await removeProject(root);
    }
});

test("size-based rotation shifts files, keeps N, and reads across them", async () => {
    const root = await makeProject({});
    try {
        const opts = { maxBytes: 1, keep: 2 }; // every append after the first rotates
        for (let i = 0; i < 5; i++) {
            await appendEvent(root, { source: "tyr", kind: `n.${i}` }, opts);
        }
        const stateDir = path.join(root, ".tyr", "state");
        assert.deepEqual((await fs.readdir(stateDir)).sort(), ["events.1.jsonl", "events.2.jsonl", "events.jsonl"]);
        assert.deepEqual((await readEvents(root)).map((e) => e.kind), ["n.2", "n.3", "n.4"]);
        assert.deepEqual((await readEvents(root, { newestFirst: true, limit: 1 })).map((e) => e.kind), ["n.4"]);

        // Under the cap nothing rotates.
        const other = await makeProject({});
        try {
            for (let i = 0; i < 5; i++) await appendEvent(other, { source: "tyr", kind: "x" });
            assert.deepEqual(await fs.readdir(path.join(other, ".tyr", "state")), ["events.jsonl"]);
        } finally {
            await removeProject(other);
        }
    } finally {
        await removeProject(root);
    }
});

test("concurrent appends (in-process and cross-process) produce N valid lines", async () => {
    const root = await makeProject({});
    try {
        const payload = { blob: "x".repeat(2000) };
        await Promise.all(
            Array.from({ length: 100 }, (_, i) => appendEvent(root, { source: "tyr", kind: "inproc", data: { i, ...payload } })),
        );

        const script =
            `const { appendEvent } = await import(${JSON.stringify(EVENTS_MODULE)});` +
            `const root = process.argv[1];` +
            `await Promise.all(Array.from({ length: 50 }, (_, i) => appendEvent(root, { source: "check", kind: "child", data: { i, blob: "y".repeat(2000) } })));`;
        await Promise.all(
            Array.from({ length: 4 }, () =>
                new Promise<void>((resolve, reject) => {
                    const child = spawn(process.execPath, ["--input-type=module", "-e", script, root], { stdio: "inherit" });
                    child.on("error", reject);
                    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}`))));
                }),
            ),
        );

        const raw = await fs.readFile(eventsFile(root), "utf8");
        const lines = raw.split("\n").filter((line) => line !== "");
        assert.equal(lines.length, 300);
        for (const line of lines) JSON.parse(line); // every line intact
        const events = await readEvents(root);
        assert.equal(events.filter((e) => e.kind === "inproc").length, 100);
        assert.equal(events.filter((e) => e.kind === "child").length, 200);
        assert.equal(new Set(events.map((e) => e.id)).size, 300);
    } finally {
        await removeProject(root);
    }
});

test("gitEventToTyrEvent maps every watcher event kind", async () => {
    const head = (branch: string | null, commit: string | null): GitHeadState => ({ branch, commit, detached: false });

    const switched = gitEventToTyrEvent({
        kind: "head",
        previous: head("main", "aaaaaaaaaa"),
        current: head("feature", "bbbbbbbbbb"),
        commitChanged: true,
        branchChanged: true,
    });
    assert.equal(switched.source, "git");
    assert.equal(switched.kind, "git.head");
    assert.equal(switched.message, "Switched from main to feature at bbbbbbb");
    assert.equal(switched.data?.branchChanged, true);

    const moved = gitEventToTyrEvent({
        kind: "head",
        previous: head("main", "aaaaaaaaaa"),
        current: head("main", "cccccccccc"),
        commitChanged: true,
        branchChanged: false,
    });
    assert.equal(moved.message, "HEAD on main moved aaaaaaa -> ccccccc");

    const index = gitEventToTyrEvent({ kind: "index", staged: ["a.ts", "b.ts"] });
    assert.equal(index.kind, "git.index");
    assert.equal(index.message, "2 paths staged");
    assert.deepEqual(index.data, { staged: ["a.ts", "b.ts"] });

    const refs = gitEventToTyrEvent({
        kind: "refs",
        changes: [
            { ref: "refs/tags/v1", previous: null, current: "abc" },
            { ref: "refs/heads/old", previous: "abc", current: null },
            { ref: "refs/heads/main", previous: "abc", current: "def" },
            { ref: "refs/heads/x", previous: "abc", current: "def" },
        ],
    });
    assert.equal(refs.kind, "git.refs");
    assert.equal(refs.message, "refs/tags/v1 created, refs/heads/old deleted, refs/heads/main updated (+1 more)");

    const none = { merging: false, rebasing: false, cherryPicking: false, reverting: false, bisecting: false };
    const merge = gitEventToTyrEvent({ kind: "merge-state", previous: none, current: { ...none, rebasing: true } });
    assert.equal(merge.kind, "git.merge-state");
    assert.equal(merge.message, "Git operation started rebase");
    assert.deepEqual(merge.data?.started, ["rebase"]);

    // The mapped input is directly appendable.
    const root = await makeProject({});
    try {
        await appendEvent(root, merge);
        const [stored] = await readEvents(root, { kinds: ["git."] });
        assert.equal(stored.message, "Git operation started rebase");
    } finally {
        await removeProject(root);
    }
});
