// git-watch.ts: debounced, verified git events from fs.watch on the git dir.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { GitWatchEvent, GitWatcher, watchGit } from "../cli/core/git-watch.js";
import { makeProject, removeProject } from "./helpers.js";

const WAIT_MS = 8000;
const SETTLE_MS = 600;

function git(root: string, ...args: string[]): string {
    return execFileSync("git", ["-c", "user.name=Tyr", "-c", "user.email=tyr@example.com", ...args], {
        cwd: root,
        encoding: "utf8",
    }).trim();
}

async function makeRepo(): Promise<string> {
    const root = await makeProject({ "a.txt": "a\n" });
    git(root, "init", "-q", "-b", "main");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "first");
    return root;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Collects events and lets a test wait for one matching a predicate. */
class Recorder {
    events: GitWatchEvent[] = [];

    readonly onEvent = (event: GitWatchEvent): void => {
        this.events.push(event);
    };

    async waitFor<K extends GitWatchEvent["kind"]>(
        kind: K,
        predicate: (event: Extract<GitWatchEvent, { kind: K }>) => boolean = () => true,
    ): Promise<Extract<GitWatchEvent, { kind: K }>> {
        const deadline = Date.now() + WAIT_MS;
        while (Date.now() < deadline) {
            const match = this.events.find(
                (event): event is Extract<GitWatchEvent, { kind: K }> =>
                    event.kind === kind && predicate(event as Extract<GitWatchEvent, { kind: K }>),
            );
            if (match !== undefined) {
                return match;
            }
            await delay(25);
        }
        assert.fail(`timed out waiting for a "${kind}" event; saw ${JSON.stringify(this.events)}`);
    }

    of(kind: GitWatchEvent["kind"]): GitWatchEvent[] {
        return this.events.filter((event) => event.kind === kind);
    }
}

async function start(root: string, recorder: Recorder, extra: { forcePolling?: boolean } = {}): Promise<GitWatcher> {
    const watcher = await watchGit(root, {
        onEvent: recorder.onEvent,
        debounceMs: 50,
        pollIntervalMs: 100,
        ...extra,
    });
    assert.ok(watcher !== null);
    return watcher;
}

test("a non-repository resolves to null", async () => {
    const root = await makeProject({ "a.txt": "a\n" });
    try {
        const watcher = await watchGit(root, { onEvent: () => {} });
        assert.equal(watcher, null);
    } finally {
        await removeProject(root);
    }
});

test("a commit emits a head event carrying the new hash", async () => {
    const root = await makeRepo();
    const recorder = new Recorder();
    const watcher = await start(root, recorder);
    try {
        const before = git(root, "rev-parse", "HEAD");
        await fs.writeFile(path.join(root, "a.txt"), "changed\n");
        git(root, "commit", "-q", "-am", "second");
        const after = git(root, "rev-parse", "HEAD");

        const event = await recorder.waitFor("head", (e) => e.current.commit === after);
        assert.equal(event.previous.commit, before);
        assert.equal(event.commitChanged, true);
        assert.equal(event.branchChanged, false);
        assert.equal(event.current.branch, "main");

        // The burst a commit causes is collapsed into a single head event.
        await delay(SETTLE_MS);
        assert.equal(recorder.of("head").length, 1);
    } finally {
        watcher.close();
        await removeProject(root);
    }
});

test("git add emits an index event listing staged paths", async () => {
    const root = await makeRepo();
    const recorder = new Recorder();
    const watcher = await start(root, recorder);
    try {
        await fs.writeFile(path.join(root, "b.txt"), "b\n");
        git(root, "add", "b.txt");
        const event = await recorder.waitFor("index", (e) => e.staged.includes("b.txt"));
        assert.deepEqual(event.staged, ["b.txt"]);
    } finally {
        watcher.close();
        await removeProject(root);
    }
});

test("git status rewriting the index's stat cache is not reported", async () => {
    const root = await makeRepo();
    const recorder = new Recorder();
    const watcher = await start(root, recorder);
    try {
        // Touch the file so status has stale stat info to refresh and write.
        const later = new Date(Date.now() + 5000);
        await fs.utimes(path.join(root, "a.txt"), later, later);
        git(root, "status", "--porcelain");
        await delay(SETTLE_MS);
        assert.deepEqual(recorder.events, []);
    } finally {
        watcher.close();
        await removeProject(root);
    }
});

test("creating a branch emits a refs event and no head event", async () => {
    const root = await makeRepo();
    const recorder = new Recorder();
    const watcher = await start(root, recorder);
    try {
        git(root, "branch", "feature/x");
        const head = git(root, "rev-parse", "HEAD");
        const event = await recorder.waitFor("refs", (e) => e.changes.some((c) => c.ref === "refs/heads/feature/x"));
        assert.deepEqual(
            event.changes.find((c) => c.ref === "refs/heads/feature/x"),
            { ref: "refs/heads/feature/x", previous: null, current: head },
        );

        await delay(SETTLE_MS);
        assert.deepEqual(recorder.of("head"), []);
    } finally {
        watcher.close();
        await removeProject(root);
    }
});

test("checking out another branch emits a head event with the branch", async () => {
    const root = await makeRepo();
    git(root, "branch", "other");
    const recorder = new Recorder();
    const watcher = await start(root, recorder);
    try {
        git(root, "checkout", "-q", "other");
        const event = await recorder.waitFor("head", (e) => e.current.branch === "other");
        assert.equal(event.previous.branch, "main");
        assert.equal(event.branchChanged, true);
        assert.equal(event.commitChanged, false);
        assert.equal(event.current.detached, false);
    } finally {
        watcher.close();
        await removeProject(root);
    }
});

test("a conflicted merge emits merge-state events as it starts and ends", async () => {
    const root = await makeRepo();
    git(root, "checkout", "-q", "-b", "side");
    await fs.writeFile(path.join(root, "a.txt"), "side\n");
    git(root, "commit", "-q", "-am", "side");
    git(root, "checkout", "-q", "main");
    await fs.writeFile(path.join(root, "a.txt"), "main\n");
    git(root, "commit", "-q", "-am", "main");

    const recorder = new Recorder();
    const watcher = await start(root, recorder);
    try {
        try {
            git(root, "merge", "-q", "side");
        } catch {
            // Expected: the merge stops on a conflict.
        }
        await recorder.waitFor("merge-state", (e) => e.current.merging);
        git(root, "merge", "--abort");
        await recorder.waitFor("merge-state", (e) => e.previous.merging && !e.current.merging);
    } finally {
        watcher.close();
        await removeProject(root);
    }
});

test("close() stops all further events", async () => {
    const root = await makeRepo();
    const recorder = new Recorder();
    const watcher = await start(root, recorder);
    try {
        watcher.close();
        watcher.close(); // Idempotent.
        await fs.writeFile(path.join(root, "a.txt"), "changed\n");
        git(root, "commit", "-q", "-am", "second");
        git(root, "branch", "later");
        await delay(SETTLE_MS);
        assert.deepEqual(recorder.events, []);
    } finally {
        watcher.close();
        await removeProject(root);
    }
});

test("the polling fallback reports the same changes", async () => {
    const root = await makeRepo();
    const recorder = new Recorder();
    const watcher = await start(root, recorder, { forcePolling: true });
    try {
        assert.equal(watcher.mode, "poll");
        git(root, "checkout", "-q", "-b", "polled");
        await recorder.waitFor("head", (e) => e.current.branch === "polled");
        await recorder.waitFor("refs", (e) => e.changes.some((c) => c.ref === "refs/heads/polled"));
    } finally {
        watcher.close();
        await removeProject(root);
    }
});

test("a linked worktree watches its own HEAD and the shared refs", async () => {
    const root = await makeRepo();
    const worktree = `${root}-wt`;
    git(root, "worktree", "add", "-q", "-b", "wt", worktree);
    const recorder = new Recorder();
    const watcher = await start(worktree, recorder);
    try {
        assert.notEqual(watcher.gitDir, watcher.commonDir);
        assert.equal(watcher.commonDir, path.join(root, ".git"));

        await fs.writeFile(path.join(worktree, "a.txt"), "wt\n");
        git(worktree, "commit", "-q", "-am", "in worktree");
        const after = git(worktree, "rev-parse", "HEAD");
        const event = await recorder.waitFor("head", (e) => e.current.commit === after);
        assert.equal(event.current.branch, "wt");

        // A commit in the main checkout moves no HEAD here, but refs are shared.
        await fs.writeFile(path.join(root, "a.txt"), "main\n");
        git(root, "commit", "-q", "-am", "in main");
        await recorder.waitFor("refs", (e) => e.changes.some((c) => c.ref === "refs/heads/main"));
        await delay(SETTLE_MS);
        assert.equal(recorder.of("head").length, 1);
    } finally {
        watcher.close();
        await removeProject(worktree);
        await removeProject(root);
    }
});

test("a throwing onEvent does not stop later events", async () => {
    const root = await makeRepo();
    let calls = 0;
    const watcher = await watchGit(root, {
        debounceMs: 50,
        onEvent: () => {
            calls += 1;
            throw new Error("consumer bug");
        },
    });
    assert.ok(watcher !== null);
    try {
        git(root, "branch", "one");
        const deadline = Date.now() + WAIT_MS;
        while (calls < 1 && Date.now() < deadline) {
            await delay(25);
        }
        git(root, "branch", "two");
        while (calls < 2 && Date.now() < deadline) {
            await delay(25);
        }
        assert.ok(calls >= 2);
    } finally {
        watcher.close();
        await removeProject(root);
    }
});
