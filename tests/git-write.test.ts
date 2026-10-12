// git-write.ts: guarded branch/worktree/stash/commit/revert for corrective agents.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
    commit,
    createBranch,
    createWorktree,
    getOperationInProgress,
    removeWorktree,
    revert,
    stash,
    stashPop,
    withRepoLock,
} from "../cli/core/git-write.js";
import { makeProject, removeProject } from "./helpers.js";

const AGENT = { name: "Tyr Agent", email: "agent@tyr.dev" };

function git(root: string, ...args: string[]): string {
    return execFileSync("git", ["-c", "user.name=Tyr", "-c", "user.email=tyr@example.com", ...args], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
}

function gitMayFail(root: string, ...args: string[]): void {
    try {
        git(root, ...args);
    } catch {
        // Expected (e.g. a conflicting merge).
    }
}

/** A repo with one commit on `main` plus a checked-out `work` branch. */
async function makeRepo(branch = "work"): Promise<string> {
    const root = await makeProject({ "a.txt": "a\n" });
    git(root, "init", "-q", "-b", "main");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "first");
    if (branch !== "main") {
        git(root, "switch", "-q", "-c", branch);
    }
    return root;
}

function head(root: string): string {
    return git(root, "rev-parse", "HEAD").trim();
}

function write(root: string, file: string, contents: string): Promise<void> {
    return fs.writeFile(path.join(root, file), contents);
}

async function withRepo(fn: (root: string) => Promise<void>, branch?: string): Promise<void> {
    const root = await makeRepo(branch);
    try {
        await fn(root);
    } finally {
        await removeProject(root);
    }
}

/* ------------------------------------------------------------------------- */

test("every operation refuses a plain directory", async () => {
    const root = await makeProject({ "a.txt": "a" });
    try {
        const result = await createBranch(root, "x");
        assert.equal(result.ok, false);
        assert.equal(!result.ok && result.reason, "not-a-repo");
        const c = await commit(root, { message: "m" });
        assert.equal(!c.ok && c.reason, "not-a-repo");
    } finally {
        await removeProject(root);
    }
});

/* -------------------------------- branches ------------------------------- */

test("createBranch creates at HEAD without switching", async () => {
    await withRepo(async (root) => {
        const result = await createBranch(root, "tyr/fix-1");
        assert.ok(result.ok);
        assert.equal(result.created, true);
        assert.equal(result.checkedOut, false);
        assert.equal(result.commit, head(root));
        assert.equal(git(root, "branch", "--show-current").trim(), "work");
        assert.equal(git(root, "rev-parse", "tyr/fix-1").trim(), head(root));
    });
});

test("createBranch can start from a ref and check out", async () => {
    await withRepo(async (root) => {
        const first = head(root);
        await write(root, "a.txt", "b\n");
        git(root, "commit", "-q", "-am", "second");
        const result = await createBranch(root, "tyr/old", { from: first, checkout: true });
        assert.ok(result.ok);
        assert.equal(git(root, "branch", "--show-current").trim(), "tyr/old");
        assert.equal(head(root), first);
    });
});

test("createBranch rejects invalid and option-like names", async () => {
    await withRepo(async (root) => {
        for (const name of ["-D", "--force", "a..b", "bad name", "x.lock", "@{-1}", "HEAD", ""]) {
            const result = await createBranch(root, name);
            assert.equal(!result.ok && result.reason, "invalid-branch-name", name);
        }
        assert.equal(git(root, "branch", "--list").trim().split("\n").length, 2);
    });
});

test("createBranch refuses existing branches unless allowed", async () => {
    await withRepo(async (root) => {
        const refused = await createBranch(root, "main");
        assert.equal(!refused.ok && refused.reason, "branch-exists");
        const allowed = await createBranch(root, "main", { allowExisting: true, checkout: true });
        assert.ok(allowed.ok);
        assert.equal(allowed.created, false);
        assert.equal(git(root, "branch", "--show-current").trim(), "main");
    });
});

test("createBranch refuses unknown or option-like start points", async () => {
    await withRepo(async (root) => {
        const missing = await createBranch(root, "x", { from: "nope" });
        assert.equal(!missing.ok && missing.reason, "invalid-ref");
        const dash = await createBranch(root, "x", { from: "--all" });
        assert.equal(!dash.ok && dash.reason, "invalid-ref");
    });
});

test("createBranch refuses an unborn HEAD", async () => {
    const root = await makeProject({ "a.txt": "a" });
    try {
        git(root, "init", "-q");
        const result = await createBranch(root, "x");
        assert.equal(!result.ok && result.reason, "unborn-head");
    } finally {
        await removeProject(root);
    }
});

test("createBranch dryRun reports the plan and mutates nothing", async () => {
    await withRepo(async (root) => {
        const result = await createBranch(root, "planned", { checkout: true, dryRun: true });
        assert.ok(result.ok);
        assert.equal(result.dryRun, true);
        assert.deepEqual(result.commands[0].slice(0, 4), ["switch", "--no-track", "-c", "planned"]);
        assert.equal(git(root, "branch", "--list", "planned").trim(), "");
    });
});

/* ----------------------------- in-progress ops ---------------------------- */

async function startConflictingMerge(root: string): Promise<void> {
    await write(root, "a.txt", "work\n");
    git(root, "commit", "-q", "-am", "work side");
    git(root, "switch", "-q", "main");
    await write(root, "a.txt", "main\n");
    git(root, "commit", "-q", "-am", "main side");
    git(root, "switch", "-q", "work");
    gitMayFail(root, "merge", "main");
}

test("a mid-merge repo blocks commit, stash and checkout", async () => {
    await withRepo(async (root) => {
        await startConflictingMerge(root);
        assert.equal(await getOperationInProgress(root), "merge");
        const c = await commit(root, { message: "m", all: true, author: AGENT });
        assert.equal(!c.ok && c.reason, "operation-in-progress");
        const s = await stash(root, { message: "s" });
        assert.equal(!s.ok && s.reason, "operation-in-progress");
        const b = await createBranch(root, "x", { checkout: true });
        assert.equal(!b.ok && b.reason, "operation-in-progress");
        // Creating a branch without switching is still harmless.
        assert.ok((await createBranch(root, "x")).ok);
    });
});

test("unresolved conflicts block writes even after the merge state is gone", async () => {
    await withRepo(async (root) => {
        await startConflictingMerge(root);
        // Drop MERGE_HEAD but keep the unmerged index entries.
        await fs.rm(path.join(root, ".git", "MERGE_HEAD"));
        assert.equal(await getOperationInProgress(root), null);
        const c = await commit(root, { message: "m", all: true, author: AGENT });
        assert.equal(!c.ok && c.reason, "conflicts");
    });
});

/* --------------------------------- commit -------------------------------- */

test("commit commits staged changes with the Tyr trailer and identity", async () => {
    await withRepo(async (root) => {
        await write(root, "a.txt", "changed\n");
        git(root, "add", "a.txt");
        const result = await commit(root, { message: "Fix a", author: AGENT, agent: "fixer" });
        assert.ok(result.ok, JSON.stringify(result));
        assert.equal(result.commit, head(root));
        assert.equal(result.branch, "work");
        const body = git(root, "log", "-1", "--format=%an <%ae>|%cn|%B");
        assert.match(body, /^Tyr Agent <agent@tyr\.dev>\|Tyr Agent\|Fix a/);
        assert.match(body, /\n\nTyr-Agent: fixer\n/);
    });
});

test("commit with paths commits only those paths, including new files", async () => {
    await withRepo(async (root) => {
        await write(root, "a.txt", "changed\n");
        await write(root, "new.txt", "new\n");
        await write(root, "other.txt", "leave me\n");
        const result = await commit(root, { message: "Add new", paths: ["new.txt"], author: AGENT });
        assert.ok(result.ok, JSON.stringify(result));
        assert.equal(git(root, "show", "--name-only", "--format=", "HEAD").trim(), "new.txt");
        const status = git(root, "status", "--porcelain");
        assert.match(status, / M a\.txt/);
        assert.match(status, /\?\? other\.txt/);
    });
});

test("commit with all commits tracked modifications only", async () => {
    await withRepo(async (root) => {
        await write(root, "a.txt", "changed\n");
        await write(root, "untracked.txt", "x\n");
        const result = await commit(root, { message: "All", all: true, author: AGENT });
        assert.ok(result.ok, JSON.stringify(result));
        assert.equal(git(root, "show", "--name-only", "--format=", "HEAD").trim(), "a.txt");
    });
});

test("commit refuses when nothing would be committed", async () => {
    await withRepo(async (root) => {
        await write(root, "a.txt", "unstaged\n");
        const before = head(root);
        const staged = await commit(root, { message: "m", author: AGENT });
        assert.equal(!staged.ok && staged.reason, "nothing-to-commit");
        const scoped = await commit(root, { message: "m", paths: ["missing.txt"], author: AGENT });
        assert.equal(!scoped.ok && scoped.reason, "nothing-to-commit");
        assert.equal(head(root), before);
    });
});

test("commit refuses protected branches unless explicitly allowed", async () => {
    await withRepo(async (root) => {
        await write(root, "a.txt", "changed\n");
        const refused = await commit(root, { message: "m", all: true, author: AGENT });
        assert.equal(!refused.ok && refused.reason, "protected-branch");

        const custom = await commit(root, {
            message: "m",
            all: true,
            author: AGENT,
            protectedBranches: ["release"],
            dryRun: true,
        });
        assert.ok(custom.ok);

        const allowed = await commit(root, { message: "m", all: true, author: AGENT, allowProtected: true });
        assert.ok(allowed.ok, JSON.stringify(allowed));
    }, "main");
});

test("commit refuses a detached HEAD unless allowed", async () => {
    await withRepo(async (root) => {
        git(root, "switch", "-q", "--detach");
        await write(root, "a.txt", "changed\n");
        const refused = await commit(root, { message: "m", all: true, author: AGENT });
        assert.equal(!refused.ok && refused.reason, "detached-head");
        const allowed = await commit(root, { message: "m", all: true, author: AGENT, allowDetached: true });
        assert.ok(allowed.ok);
        assert.equal(allowed.branch, null);
    });
});

test("commit validates its arguments", async () => {
    await withRepo(async (root) => {
        const cases = [
            { message: "" },
            { message: "m", all: true, paths: ["a.txt"] },
            { message: "m", paths: [] },
            { message: "m", agent: "two\nlines" },
            { message: "m", author: { name: "x", email: "<bad>" } },
        ];
        for (const options of cases) {
            const result = await commit(root, options);
            assert.equal(!result.ok && result.reason, "invalid-argument", JSON.stringify(options));
        }
    });
});

test("commit works on an unborn branch (initial commit)", async () => {
    const root = await makeProject({ "a.txt": "a" });
    try {
        git(root, "init", "-q", "-b", "start");
        const result = await commit(root, { message: "init", paths: ["a.txt"], author: AGENT });
        assert.ok(result.ok, JSON.stringify(result));
        assert.equal(git(root, "log", "--format=%s").trim(), "init");
    } finally {
        await removeProject(root);
    }
});

test("commit dryRun neither stages nor commits", async () => {
    await withRepo(async (root) => {
        await write(root, "new.txt", "new\n");
        const before = head(root);
        const result = await commit(root, { message: "m", paths: ["new.txt"], author: AGENT, dryRun: true });
        assert.ok(result.ok);
        assert.equal(result.commit, null);
        assert.deepEqual(result.commands[0], ["add", "-A", "--", "new.txt"]);
        assert.equal(head(root), before);
        assert.match(git(root, "status", "--porcelain"), /\?\? new\.txt/);
    });
});

test("commit reports a failing hook as git-failed with stderr", async () => {
    await withRepo(async (root) => {
        const hook = path.join(root, ".git", "hooks", "pre-commit");
        await fs.writeFile(hook, "#!/bin/sh\necho nope >&2\nexit 1\n", { mode: 0o755 });
        await write(root, "a.txt", "changed\n");
        const result = await commit(root, { message: "m", all: true, author: AGENT });
        assert.equal(!result.ok && result.reason, "git-failed");
        assert.match((!result.ok && result.stderr) || "", /nope/);
    });
});

/* --------------------------------- revert -------------------------------- */

test("revert creates a trailer-tagged revert commit", async () => {
    await withRepo(async (root) => {
        await write(root, "a.txt", "bad\n");
        git(root, "commit", "-q", "-am", "bad change");
        const bad = head(root);
        const result = await revert(root, bad, { author: AGENT, agent: "reverter" });
        assert.ok(result.ok, JSON.stringify(result));
        assert.equal(result.reverted, bad);
        assert.equal(result.commit, head(root));
        assert.equal(await fs.readFile(path.join(root, "a.txt"), "utf8"), "a\n");
        const body = git(root, "log", "-1", "--format=%B");
        assert.match(body, /^Revert "bad change"/);
        assert.match(body, /Tyr-Agent: reverter/);
        assert.equal(await getOperationInProgress(root), null);
    });
});

test("revert with noCommit leaves staged changes and no revert in progress", async () => {
    await withRepo(async (root) => {
        await write(root, "a.txt", "bad\n");
        git(root, "commit", "-q", "-am", "bad change");
        const before = head(root);
        const result = await revert(root, "HEAD", { noCommit: true });
        assert.ok(result.ok, JSON.stringify(result));
        assert.equal(result.commit, null);
        assert.equal(head(root), before);
        assert.equal(await getOperationInProgress(root), null);
        assert.match(git(root, "status", "--porcelain"), /^M  a\.txt/m);
        // The staged revert can then be committed normally.
        assert.ok((await commit(root, { message: "Undo", author: AGENT })).ok);
    });
});

test("revert refuses merge commits without mainline", async () => {
    await withRepo(async (root) => {
        await write(root, "w.txt", "w\n");
        git(root, "add", ".");
        git(root, "commit", "-q", "-m", "work");
        git(root, "switch", "-q", "main");
        await write(root, "m.txt", "m\n");
        git(root, "add", ".");
        git(root, "commit", "-q", "-m", "main");
        git(root, "switch", "-q", "work");
        git(root, "merge", "-q", "--no-edit", "main");
        const merge = head(root);

        const refused = await revert(root, merge, { author: AGENT });
        assert.equal(!refused.ok && refused.reason, "merge-commit");
        const badMainline = await revert(root, merge, { author: AGENT, mainline: 3 });
        assert.equal(!badMainline.ok && badMainline.reason, "invalid-argument");
        const ok = await revert(root, merge, { author: AGENT, mainline: 1 });
        assert.ok(ok.ok, JSON.stringify(ok));
        await assert.rejects(fs.access(path.join(root, "m.txt")));
    });
});

test("revert refuses dirty trees, bad refs and protected branches", async () => {
    await withRepo(async (root) => {
        const missing = await revert(root, "deadbeef", { author: AGENT });
        assert.equal(!missing.ok && missing.reason, "invalid-ref");
        const dash = await revert(root, "--abort", { author: AGENT });
        assert.equal(!dash.ok && dash.reason, "invalid-ref");

        await write(root, "a.txt", "dirty\n");
        const dirty = await revert(root, "HEAD", { author: AGENT });
        assert.equal(!dirty.ok && dirty.reason, "dirty-worktree");
    });
    await withRepo(async (root) => {
        const result = await revert(root, "HEAD", { author: AGENT });
        assert.equal(!result.ok && result.reason, "protected-branch");
    }, "main");
});

test("a conflicting revert is aborted and the tree restored", async () => {
    await withRepo(async (root) => {
        await write(root, "a.txt", "one\n");
        git(root, "commit", "-q", "-am", "one");
        const target = head(root);
        await write(root, "a.txt", "two\n");
        git(root, "commit", "-q", "-am", "two");
        const before = head(root);

        const result = await revert(root, target, { author: AGENT });
        assert.equal(!result.ok && result.reason, "conflicts");
        assert.equal(head(root), before);
        assert.equal(await getOperationInProgress(root), null);
        assert.equal(git(root, "status", "--porcelain").trim(), "");
    });
});

test("revert dryRun mutates nothing", async () => {
    await withRepo(async (root) => {
        const before = head(root);
        const result = await revert(root, "HEAD", { dryRun: true });
        assert.ok(result.ok);
        assert.equal(result.dryRun, true);
        assert.equal(head(root), before);
    });
});

/* ---------------------------------- stash -------------------------------- */

test("stash returns the stash commit and stashPop pops exactly that entry", async () => {
    await withRepo(async (root) => {
        await write(root, "a.txt", "mine\n");
        const mine = await stash(root, { message: "tyr: mine" });
        assert.ok(mine.ok, JSON.stringify(mine));
        assert.match(mine.ref ?? "", /^[0-9a-f]{40,64}$/);

        // Someone else stashes on top; stash@{0} is now theirs.
        await write(root, "a.txt", "theirs\n");
        git(root, "stash", "push", "-q", "-m", "theirs");

        const popped = await stashPop(root, mine.ref ?? "");
        assert.ok(popped.ok, JSON.stringify(popped));
        assert.deepEqual(popped.commands[0], ["stash", "pop", "stash@{1}"]);
        assert.equal(await fs.readFile(path.join(root, "a.txt"), "utf8"), "mine\n");
        assert.match(git(root, "stash", "list"), /theirs/);
        assert.equal(git(root, "stash", "list").trim().split("\n").length, 1);
    });
});

test("stash includes untracked files only when asked", async () => {
    await withRepo(async (root) => {
        await write(root, "new.txt", "n\n");
        const refused = await stash(root, { message: "s" });
        assert.equal(!refused.ok && refused.reason, "nothing-to-stash");
        const result = await stash(root, { message: "s", includeUntracked: true });
        assert.ok(result.ok);
        await assert.rejects(fs.access(path.join(root, "new.txt")));
    });
});

test("stash guards: clean tree, unborn HEAD, message, dryRun", async () => {
    await withRepo(async (root) => {
        const clean = await stash(root, { message: "s" });
        assert.equal(!clean.ok && clean.reason, "nothing-to-stash");
        const noMessage = await stash(root, { message: " " });
        assert.equal(!noMessage.ok && noMessage.reason, "invalid-argument");

        await write(root, "a.txt", "x\n");
        const dry = await stash(root, { message: "s", dryRun: true });
        assert.ok(dry.ok);
        assert.equal(dry.ref, null);
        assert.equal(git(root, "stash", "list").trim(), "");
    });
    const root = await makeProject({ "a.txt": "a" });
    try {
        git(root, "init", "-q");
        const result = await stash(root, { message: "s", includeUntracked: true });
        assert.equal(!result.ok && result.reason, "unborn-head");
    } finally {
        await removeProject(root);
    }
});

test("stashPop refuses unknown or malformed refs", async () => {
    await withRepo(async (root) => {
        const malformed = await stashPop(root, "stash@{0}");
        assert.equal(!malformed.ok && malformed.reason, "invalid-argument");
        const unknown = await stashPop(root, "a".repeat(40));
        assert.equal(!unknown.ok && unknown.reason, "stash-not-found");
    });
});

test("stashPop that conflicts keeps the stash entry", async () => {
    await withRepo(async (root) => {
        await write(root, "a.txt", "stashed\n");
        const saved = await stash(root, { message: "s" });
        assert.ok(saved.ok);
        await write(root, "a.txt", "committed\n");
        git(root, "commit", "-q", "-am", "diverge");
        const result = await stashPop(root, saved.ref ?? "");
        assert.equal(!result.ok && result.reason, "conflicts");
        assert.match(git(root, "stash", "list"), /s$/m);
    });
});

/* -------------------------------- worktrees ------------------------------ */

async function tempDir(): Promise<string> {
    return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tyr-wt-")));
}

test("createWorktree adds a worktree on a new branch and removeWorktree removes it", async () => {
    await withRepo(async (root) => {
        const outside = await tempDir();
        try {
            const target = path.join(outside, "fix");
            const created = await createWorktree(root, target, { branch: "tyr/wt" });
            assert.ok(created.ok, JSON.stringify(created));
            assert.equal(created.createdBranch, true);
            assert.equal(git(target, "branch", "--show-current").trim(), "tyr/wt");
            assert.equal(await fs.readFile(path.join(target, "a.txt"), "utf8"), "a\n");

            const removed = await removeWorktree(root, target);
            assert.ok(removed.ok, JSON.stringify(removed));
            assert.equal(removed.branch, "tyr/wt");
            await assert.rejects(fs.access(target));
            // The branch survives worktree removal.
            assert.equal(git(root, "branch", "--list", "tyr/wt").trim(), "tyr/wt");
        } finally {
            await removeProject(outside);
        }
    });
});

test("createWorktree guards path and branch", async () => {
    await withRepo(async (root) => {
        const outside = await tempDir();
        try {
            const inside = await createWorktree(root, path.join(root, "nested"), { branch: "x" });
            assert.equal(!inside.ok && inside.reason, "path-inside-repo");

            await fs.writeFile(path.join(outside, "file"), "x");
            const occupied = await createWorktree(root, outside, { branch: "x" });
            assert.equal(!occupied.ok && occupied.reason, "path-exists");

            const target = path.join(outside, "wt");
            const exists = await createWorktree(root, target, { branch: "main" });
            assert.equal(!exists.ok && exists.reason, "branch-exists");
            const badName = await createWorktree(root, target, { branch: "-b" });
            assert.equal(!badName.ok && badName.reason, "invalid-branch-name");

            const dry = await createWorktree(root, target, { branch: "y", dryRun: true });
            assert.ok(dry.ok);
            await assert.rejects(fs.access(target));

            const existing = await createWorktree(root, target, { branch: "main", allowExistingBranch: true });
            assert.ok(existing.ok, JSON.stringify(existing));
            assert.equal(existing.createdBranch, false);
        } finally {
            await removeProject(outside);
        }
    });
});

test("removeWorktree refuses dirty, unknown and main worktrees", async () => {
    await withRepo(async (root) => {
        const outside = await tempDir();
        try {
            const target = path.join(outside, "wt");
            assert.ok((await createWorktree(root, target, { branch: "tyr/dirty" })).ok);
            await fs.writeFile(path.join(target, "a.txt"), "dirty\n");

            const dirty = await removeWorktree(root, target);
            assert.equal(!dirty.ok && dirty.reason, "dirty-worktree");
            await fs.access(target);

            const unknown = await removeWorktree(root, path.join(outside, "nope"));
            assert.equal(!unknown.ok && unknown.reason, "worktree-not-found");
            const main = await removeWorktree(root, root);
            assert.equal(!main.ok && main.reason, "invalid-argument");
        } finally {
            gitMayFail(root, "worktree", "prune");
            await removeProject(outside);
        }
    });
});

/* ---------------------------------- lock --------------------------------- */

test("withRepoLock serializes tasks on the same key", async () => {
    const order: string[] = [];
    const slow = withRepoLock("k", async () => {
        order.push("a-start");
        await new Promise((resolve) => setTimeout(resolve, 30));
        order.push("a-end");
    });
    const fast = withRepoLock("k", async () => {
        order.push("b");
    });
    const other = withRepoLock("other", async () => {
        order.push("c");
    });
    await Promise.all([slow, fast, other]);
    assert.deepEqual(order.filter((step) => step !== "c"), ["a-start", "a-end", "b"]);
    assert.ok(order.indexOf("c") < order.indexOf("a-end"));
});

test("concurrent commits on one repo both succeed without index races", async () => {
    await withRepo(async (root) => {
        await write(root, "one.txt", "1\n");
        await write(root, "two.txt", "2\n");
        const [a, b] = await Promise.all([
            commit(root, { message: "one", paths: ["one.txt"], author: AGENT }),
            commit(root, { message: "two", paths: ["two.txt"], author: AGENT }),
        ]);
        assert.ok(a.ok && b.ok, JSON.stringify([a, b]));
        assert.equal(git(root, "rev-list", "--count", "HEAD").trim(), "3");
    });
});
