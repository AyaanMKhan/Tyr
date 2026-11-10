// fs-watch.ts: debounced, verified file-change batches for the project tree.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FileChangeBatch, FileWatcher, watchFiles, WatchFilesOptions } from "../cli/core/fs-watch.js";
import { createPathIgnoreFilter } from "../cli/core/discovery.js";
import { fsBatchToTyrEvent, FS_EVENT_MAX_PATHS } from "../cli/core/events.js";
import { makeProject, removeProject } from "./helpers.js";

const WAIT_MS = 8000;
const SETTLE_MS = 700;

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Collects batches and lets a test wait for one matching a predicate. */
class Recorder {
    batches: FileChangeBatch[] = [];

    readonly onBatch = (batch: FileChangeBatch): void => {
        this.batches.push(batch);
    };

    async waitFor(predicate: (batch: FileChangeBatch) => boolean): Promise<FileChangeBatch> {
        const deadline = Date.now() + WAIT_MS;
        while (Date.now() < deadline) {
            const match = this.batches.find(predicate);
            if (match !== undefined) {
                return match;
            }
            await delay(25);
        }
        assert.fail(`timed out waiting for a batch; saw ${JSON.stringify(this.batches)}`);
    }

    /** Every path reported in any batch, whatever the list. */
    allPaths(): string[] {
        return this.batches.flatMap((batch) => [...batch.added, ...batch.modified, ...batch.removed]);
    }
}

const mentions = (rel: string) => (batch: FileChangeBatch): boolean =>
    [...batch.added, ...batch.modified, ...batch.removed].includes(rel);

async function start(
    root: string,
    recorder: Recorder,
    extra: Partial<WatchFilesOptions> = {},
): Promise<FileWatcher> {
    return watchFiles(root, {
        onBatch: recorder.onBatch,
        debounceMs: 150,
        maxWaitMs: 3000,
        pollIntervalMs: 100,
        persistent: false,
        ...extra,
    });
}

async function write(root: string, rel: string, contents: string): Promise<void> {
    const target = path.join(root, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents, "utf8");
}

/** Runs the same body once with fs.watch and once forced to poll. */
function bothModes(name: string, body: (root: string, recorder: Recorder, watcher: FileWatcher) => Promise<void>,
    files: Record<string, string> = { "a.ts": "a\n", "b.ts": "b\n" }): void {
    for (const forcePolling of [false, true]) {
        test(`${name} (${forcePolling ? "poll" : "watch"})`, async () => {
            const root = await makeProject(files);
            const recorder = new Recorder();
            const watcher = await start(root, recorder, { forcePolling });
            try {
                assert.equal(watcher.mode, forcePolling ? "poll" : "watch");
                await body(root, recorder, watcher);
            } finally {
                watcher.close();
                await removeProject(root);
            }
        });
    }
}

bothModes("add, modify and remove are classified from the disk", async (root, recorder, watcher) => {
    await write(root, "src/c.ts", "c\n");
    await write(root, "a.ts", "a changed and longer\n");
    await fs.rm(path.join(root, "b.ts"));

    await waitUntil(() => recorder.allPaths().length === 3);
    await delay(SETTLE_MS);
    const merged = {
        added: recorder.batches.flatMap((b) => b.added),
        modified: recorder.batches.flatMap((b) => b.modified),
        removed: recorder.batches.flatMap((b) => b.removed),
    };
    assert.deepEqual(merged, { added: ["src/c.ts"], modified: ["a.ts"], removed: ["b.ts"] });
    // A poll may land between two of the writes; with fs.watch the burst is
    // always debounced into one batch.
    if (watcher.mode === "watch") {
        assert.deepEqual(recorder.batches, [
            { added: ["src/c.ts"], modified: ["a.ts"], removed: ["b.ts"], total: 3, truncated: false },
        ]);
    }
});

bothModes("ignored dirs, extensions, .tyrignore, .tyr and .git are never reported", async (root, recorder) => {
    await write(root, "node_modules/pkg/index.js", "x\n");
    await write(root, "dist/out.js", "x\n");
    await write(root, "src/logo.png", "x\n");
    await write(root, ".DS_Store", "x\n");
    await write(root, "secret/key.ts", "x\n");
    await write(root, "notes.tmp", "x\n");
    await write(root, ".tyr/logs/tyr.log", "x\n");
    await write(root, ".git/HEAD", "ref: refs/heads/main\n");
    await write(root, "pkg/.git", "gitdir: elsewhere\n");
    await write(root, "marker.ts", "m\n");

    await recorder.waitFor(mentions("marker.ts"));
    await delay(SETTLE_MS);
    assert.deepEqual(recorder.allPaths(), ["marker.ts"]);
}, { "a.ts": "a\n", ".tyrignore": "secret/\n*.tmp\n" });

test("a file created and deleted inside one burst is not reported", async () => {
    const root = await makeProject({ "a.ts": "a\n" });
    const recorder = new Recorder();
    // A long quiet period so the create and the delete land in one burst.
    const watcher = await start(root, recorder, { debounceMs: 400 });
    try {
        await write(root, "tmp.ts", "t\n");
        await fs.rm(path.join(root, "tmp.ts"));
        await delay(SETTLE_MS + 400);
        await write(root, "marker.ts", "m\n");
        await recorder.waitFor(mentions("marker.ts"));
        assert.deepEqual(recorder.allPaths(), ["marker.ts"]);
    } finally {
        watcher.close();
        await removeProject(root);
    }
});

test("rapid writes to several files collapse into one batch", async () => {
    const root = await makeProject({ "a.ts": "a\n" });
    const recorder = new Recorder();
    const watcher = await start(root, recorder, { debounceMs: 300 });
    try {
        for (let i = 0; i < 10; i++) {
            await write(root, `f${i}.ts`, `${i}\n`);
            await write(root, "a.ts", `a${"!".repeat(i + 1)}\n`);
        }
        const batch = await recorder.waitFor((b) => b.total === 11);
        assert.equal(batch.added.length, 10);
        assert.deepEqual(batch.modified, ["a.ts"]);
        await delay(SETTLE_MS);
        assert.equal(recorder.batches.length, 1, JSON.stringify(recorder.batches));
    } finally {
        watcher.close();
        await removeProject(root);
    }
});

test("a directory moved in or deleted reports the files beneath it", async () => {
    const root = await makeProject({ "a.ts": "a\n", "old/x.ts": "x\n", "old/deep/y.ts": "y\n" });
    const outside = await makeProject({ "moved/one.ts": "1\n", "moved/sub/two.ts": "2\n", "moved/skip.png": "p\n" });
    const recorder = new Recorder();
    const watcher = await start(root, recorder);
    try {
        await fs.rename(path.join(outside, "moved"), path.join(root, "moved"));
        const added = await recorder.waitFor(mentions("moved/one.ts"));
        assert.deepEqual(added.added, ["moved/one.ts", "moved/sub/two.ts"]);

        await fs.rm(path.join(root, "old"), { recursive: true });
        const removed = await recorder.waitFor(mentions("old/x.ts"));
        assert.deepEqual(removed.removed, ["old/deep/y.ts", "old/x.ts"]);
    } finally {
        watcher.close();
        await removeProject(root);
        await removeProject(outside);
    }
});

test("git-ignored files are not reported inside a work tree", async () => {
    const root = await makeProject({ "a.ts": "a\n", ".gitignore": "gen/\n*.log\n" });
    execFileSync("git", ["init", "-q"], { cwd: root });
    const recorder = new Recorder();
    const watcher = await start(root, recorder);
    try {
        await write(root, "gen/out.ts", "g\n");
        await write(root, "debug.log", "l\n");
        await write(root, "marker.ts", "m\n");
        await recorder.waitFor(mentions("marker.ts"));
        await delay(SETTLE_MS);
        assert.deepEqual(recorder.allPaths(), ["marker.ts"]);
    } finally {
        watcher.close();
        await removeProject(root);
    }
});

test("editing .tyrignore re-reads the rules", async () => {
    const root = await makeProject({ "a.ts": "a\n", "b.ts": "b\n" });
    const recorder = new Recorder();
    const watcher = await start(root, recorder);
    try {
        await write(root, ".tyrignore", "b.ts\n");
        await recorder.waitFor(mentions(".tyrignore"));
        // b.ts is now ignored: neither its edit nor its removal is reported.
        await write(root, "b.ts", "b changed and longer\n");
        await fs.rm(path.join(root, "b.ts"));
        await write(root, "marker.ts", "m\n");
        await recorder.waitFor(mentions("marker.ts"));
        await delay(SETTLE_MS);
        assert.deepEqual(recorder.allPaths(), [".tyrignore", "marker.ts"]);
    } finally {
        watcher.close();
        await removeProject(root);
    }
});

test("a storm is capped per list with the real total", async () => {
    const root = await makeProject({ "a.ts": "a\n" });
    const recorder = new Recorder();
    const staging = await makeProject({});
    const watcher = await start(root, recorder, { forcePolling: true, maxBatchPaths: 5 });
    try {
        // Built outside and renamed in, so one poll is sure to see all 20.
        for (let i = 0; i < 20; i++) {
            await write(staging, `gen/f${String(i).padStart(2, "0")}.ts`, `${i}\n`);
        }
        await fs.rename(path.join(staging, "gen"), path.join(root, "gen"));
        const batch = await recorder.waitFor((b) => b.total === 20);
        assert.equal(batch.truncated, true);
        assert.deepEqual(batch.added, ["gen/f00.ts", "gen/f01.ts", "gen/f02.ts", "gen/f03.ts", "gen/f04.ts"]);
    } finally {
        watcher.close();
        await removeProject(root);
        await removeProject(staging);
    }
});

test("a burst over maxPendingPaths falls back to a rescan with the same result", async () => {
    const root = await makeProject({ "a.ts": "a\n" });
    const recorder = new Recorder();
    const watcher = await start(root, recorder, { maxPendingPaths: 3, debounceMs: 300 });
    try {
        for (let i = 0; i < 12; i++) {
            await write(root, `f${i}.ts`, `${i}\n`);
        }
        const batch = await recorder.waitFor((b) => b.total === 12);
        assert.equal(batch.added.length, 12);
        assert.equal(batch.truncated, false);
    } finally {
        watcher.close();
        await removeProject(root);
    }
});

test("close() stops delivery", async () => {
    for (const forcePolling of [false, true]) {
        const root = await makeProject({ "a.ts": "a\n" });
        const recorder = new Recorder();
        const watcher = await start(root, recorder, { forcePolling });
        try {
            watcher.close();
            watcher.close(); // Idempotent.
            await write(root, "late.ts", "l\n");
            await delay(SETTLE_MS);
            assert.deepEqual(recorder.batches, []);
        } finally {
            await removeProject(root);
        }
    }
});

test("a throwing consumer does not stop later batches", async () => {
    const root = await makeProject({ "a.ts": "a\n" });
    const seen: FileChangeBatch[] = [];
    const watcher = await watchFiles(root, {
        onBatch: (batch) => {
            seen.push(batch);
            throw new Error("consumer bug");
        },
        forcePolling: true,
        pollIntervalMs: 100,
        persistent: false,
    });
    try {
        await write(root, "one.ts", "1\n");
        await waitUntil(() => seen.length === 1);
        await write(root, "two.ts", "2\n");
        await waitUntil(() => seen.length === 2);
        assert.deepEqual(seen.map((b) => b.added), [["one.ts"], ["two.ts"]]);
    } finally {
        watcher.close();
        await removeProject(root);
    }
});

test("a missing root still resolves, polls, and reports nothing", async () => {
    const root = path.join(await makeProject({}), "does-not-exist");
    const recorder = new Recorder();
    const watcher = await start(root, recorder);
    try {
        assert.equal(watcher.mode, "poll");
        await delay(300);
        assert.deepEqual(recorder.batches, []);
    } finally {
        watcher.close();
        await removeProject(path.dirname(root));
    }
});

async function waitUntil(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!condition()) {
        if (Date.now() > deadline) assert.fail("timed out");
        await delay(25);
    }
}

/* -------------------------------------------------------------------------
 * Shared ignore helper and event mapping
 * ---------------------------------------------------------------------- */

test("createPathIgnoreFilter applies built-in and user rules to every ancestor", () => {
    const filter = createPathIgnoreFilter(["secret/", "*.tmp", "!keep.tmp"]);
    assert.equal(filter.ignores("src/a.ts", false), false);
    assert.equal(filter.ignores("node_modules/x/index.js", false), true);
    assert.equal(filter.ignores("packages/web/dist/app.js", false), true);
    assert.equal(filter.ignores(".tyr/state/events.jsonl", false), true);
    assert.equal(filter.ignores("img/logo.PNG", false), true);
    assert.equal(filter.ignores("sub/.DS_Store", false), true);
    assert.equal(filter.ignores("secret/a.ts", false), true);
    assert.equal(filter.ignores("secret", true), true);
    assert.equal(filter.ignores("secret", false), false); // dir-only pattern
    assert.equal(filter.ignores("x.tmp", false), true);
    assert.equal(filter.ignores("keep.tmp", false), false);
    // A file merely *named* like an ignored directory is still a file.
    assert.equal(filter.ignores("build", false), false);
    assert.equal(filter.ignores("build", true), true);
});

test("fsBatchToTyrEvent maps a batch to an fs.changed event", () => {
    const event = fsBatchToTyrEvent({
        added: ["src/a.ts"],
        modified: ["src/b.ts"],
        removed: ["old.ts"],
        total: 3,
        truncated: false,
    });
    assert.equal(event.source, "fs");
    assert.equal(event.kind, "fs.changed");
    assert.equal(event.message, "3 files changed: src/a.ts, src/b.ts (+1 more)");
    assert.deepEqual(event.data, {
        added: ["src/a.ts"],
        modified: ["src/b.ts"],
        removed: ["old.ts"],
        total: 3,
        truncated: false,
    });

    const single = fsBatchToTyrEvent({ added: [], modified: ["a.ts"], removed: [], total: 1, truncated: false });
    assert.equal(single.message, "1 file changed: a.ts");

    const many = Array.from({ length: 70 }, (_, i) => `f${i}.ts`);
    const storm = fsBatchToTyrEvent({ added: many, modified: [], removed: [], total: 5000, truncated: true });
    const data = storm.data as { added: string[]; total: number; truncated: boolean };
    assert.equal(data.added.length, FS_EVENT_MAX_PATHS);
    assert.equal(data.total, 5000);
    assert.equal(data.truncated, true);
    assert.equal(storm.message, "5000 files changed: f0.ts, f1.ts (+4998 more)");

    // Capping here alone also marks the event truncated.
    const capped = fsBatchToTyrEvent({ added: many, modified: [], removed: [], total: 70, truncated: false });
    assert.equal((capped.data as { truncated: boolean }).truncated, true);
});
