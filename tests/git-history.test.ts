// Change detection against state.lastIndexedCommit and the commit log since a
// reference point (cli/core/git-history.ts), on real throwaway repos.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { detectChanges, getCommitLog, getCommitsSince, resolveCommit } from "../cli/core/git-history.js";
import { makeProject, removeProject } from "./helpers.js";

function git(root: string, ...args: string[]): string {
    return execFileSync("git", ["-c", "user.name=Tyr", "-c", "user.email=tyr@example.com", ...args], {
        cwd: root,
        encoding: "utf8",
    });
}

function head(root: string): string {
    return git(root, "rev-parse", "HEAD").trim();
}

async function write(root: string, relative: string, contents: string): Promise<void> {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), contents);
}

function commitAll(root: string, message: string): string {
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", message);
    return head(root);
}

async function makeRepo(): Promise<string> {
    const root = await makeProject({ "a.txt": "alpha\n", "keep.txt": "a fairly long body so renames are detected\n" });
    git(root, "init", "-q");
    commitAll(root, "first");
    return root;
}

/* -------------------------------------------------------------------------
 * detectChanges
 * ---------------------------------------------------------------------- */

test("a plain directory is not a repo and needs a full rescan", async () => {
    const root = await makeProject({ "a.txt": "a" });
    try {
        const result = await detectChanges(root, null);
        assert.equal(result.isRepo, false);
        assert.equal(result.fullRescan, true);
        assert.equal(result.headCommit, null);
    } finally {
        await removeProject(root);
    }
});

test("an unborn HEAD with no base is not 'moved' but still needs a full rescan", async () => {
    const root = await makeProject({ "a.txt": "a" });
    try {
        git(root, "init", "-q");
        const result = await detectChanges(root, null);
        assert.equal(result.isRepo, true);
        assert.equal(result.headUnborn, true);
        assert.equal(result.headCommit, null);
        assert.equal(result.headMoved, false);
        assert.equal(result.fullRescan, true);
        assert.equal(result.workingTreeDirty, true);
        assert.deepEqual(result.workingTreeChanges.map((c) => [c.path, c.untracked]), [["a.txt", true]]);
    } finally {
        await removeProject(root);
    }
});

test("never indexed (null base) on a repo with commits needs a full rescan", async () => {
    const root = await makeRepo();
    try {
        const result = await detectChanges(root, null);
        assert.equal(result.headCommit, head(root));
        assert.equal(result.headMoved, true);
        assert.equal(result.baseExists, false);
        assert.equal(result.fullRescan, true);
        assert.equal(result.workingTreeDirty, false);
    } finally {
        await removeProject(root);
    }
});

test("an unchanged repo reports nothing to do", async () => {
    const root = await makeRepo();
    try {
        const base = head(root);
        const result = await detectChanges(root, base);
        assert.equal(result.headMoved, false);
        assert.equal(result.baseReachable, true);
        assert.equal(result.commitsSince, 0);
        assert.equal(result.commitsDropped, 0);
        assert.deepEqual(result.changedFiles, []);
        assert.equal(result.workingTreeDirty, false);
        assert.equal(result.fullRescan, false);
    } finally {
        await removeProject(root);
    }
});

test("forward commits report added, modified, deleted and renamed files", async () => {
    const root = await makeRepo();
    try {
        const base = head(root);
        await write(root, "a.txt", "changed\n");
        await write(root, "dir/new file.txt", "new\n");
        commitAll(root, "second");
        await fs.rm(path.join(root, "a.txt"));
        git(root, "mv", "keep.txt", "moved.txt");
        commitAll(root, "third");

        // A short hash is expanded to the full one.
        const result = await detectChanges(root, base.slice(0, 10));
        assert.equal(result.baseCommit, base);
        assert.equal(result.baseExists, true);
        assert.equal(result.headMoved, true);
        assert.equal(result.baseReachable, true);
        assert.equal(result.commitsSince, 2);
        assert.equal(result.commitsDropped, 0);
        assert.equal(result.fullRescan, false);

        const byPath = new Map(result.changedFiles.map((file) => [file.path, file]));
        assert.equal(byPath.get("a.txt")?.status, "D");
        assert.equal(byPath.get("dir/new file.txt")?.status, "A");
        const renamed = byPath.get("moved.txt");
        assert.equal(renamed?.status, "R");
        assert.equal(renamed?.oldPath, "keep.txt");
        assert.equal(renamed?.similarity, 100);
        assert.equal(result.changedFiles.length, 3);
    } finally {
        await removeProject(root);
    }
});

test("odd file names survive intact", async () => {
    const root = await makeRepo();
    try {
        const base = head(root);
        const odd = "we\"ird\tna me\nwith-newline-ü.txt";
        await write(root, odd, "x\n");
        commitAll(root, "odd");
        await write(root, "untracked ü.txt", "u");

        const result = await detectChanges(root, base);
        assert.deepEqual(result.changedFiles.map((f) => f.path), [odd]);
        assert.equal(result.workingTreeDirty, true);
        assert.deepEqual(result.workingTreeChanges.map((c) => c.path), ["untracked ü.txt"]);
    } finally {
        await removeProject(root);
    }
});

test("a reset to an older commit is not reachable and counts dropped commits", async () => {
    const root = await makeRepo();
    try {
        const first = head(root);
        await write(root, "b.txt", "b\n");
        const indexed = commitAll(root, "second");
        git(root, "reset", "-q", "--hard", first);

        const result = await detectChanges(root, indexed);
        assert.equal(result.baseExists, true);
        assert.equal(result.baseReachable, false);
        assert.equal(result.headMoved, true);
        assert.equal(result.commitsSince, 0);
        assert.equal(result.commitsDropped, 1);
        // The tree diff still says what to re-index.
        assert.deepEqual(result.changedFiles.map((f) => [f.status, f.path]), [["D", "b.txt"]]);
        assert.equal(result.fullRescan, false);
    } finally {
        await removeProject(root);
    }
});

test("a rebased (rewritten) base is not an ancestor of HEAD", async () => {
    const root = await makeRepo();
    try {
        await write(root, "b.txt", "b\n");
        const indexed = commitAll(root, "second");
        git(root, "commit", "-q", "--amend", "-m", "second, reworded");

        const result = await detectChanges(root, indexed);
        assert.equal(result.baseReachable, false);
        assert.equal(result.commitsSince, 1);
        assert.equal(result.commitsDropped, 1);
        assert.deepEqual(result.changedFiles, []);
        assert.equal(result.fullRescan, false);
    } finally {
        await removeProject(root);
    }
});

test("a base hash that no longer exists forces a full rescan", async () => {
    const root = await makeRepo();
    try {
        const missing = "0123456789abcdef0123456789abcdef01234567";
        const result = await detectChanges(root, missing);
        assert.equal(result.isRepo, true);
        assert.equal(result.baseExists, false);
        assert.equal(result.baseCommit, missing);
        assert.equal(result.baseReachable, false);
        assert.equal(result.headMoved, true);
        assert.equal(result.commitsSince, null);
        assert.equal(result.fullRescan, true);
    } finally {
        await removeProject(root);
    }
});

test("option-looking and garbage bases are refused, not passed to git", async () => {
    const root = await makeRepo();
    try {
        assert.equal(await resolveCommit(root, "--output=/tmp/x"), null);
        assert.equal(await resolveCommit(root, "a b"), null);
        assert.equal((await detectChanges(root, "--all")).fullRescan, true);
        // A tree hash is not a commit.
        const tree = git(root, "rev-parse", "HEAD^{tree}").trim();
        assert.equal(await resolveCommit(root, tree), null);
    } finally {
        await removeProject(root);
    }
});

test("staged renames and unstaged edits show in the working tree", async () => {
    const root = await makeRepo();
    try {
        const base = head(root);
        git(root, "mv", "keep.txt", "kept.txt");
        await write(root, "a.txt", "dirty\n");

        const result = await detectChanges(root, base);
        assert.equal(result.headMoved, false);
        assert.equal(result.workingTreeDirty, true);
        const rename = result.workingTreeChanges.find((c) => c.index === "R");
        assert.equal(rename?.path, "kept.txt");
        assert.equal(rename?.oldPath, "keep.txt");
        const edit = result.workingTreeChanges.find((c) => c.path === "a.txt");
        assert.equal(edit?.worktree, "M");
    } finally {
        await removeProject(root);
    }
});

test("an orphan branch (unborn HEAD) with a recorded base needs a full rescan", async () => {
    const root = await makeRepo();
    try {
        const base = head(root);
        git(root, "checkout", "-q", "--orphan", "fresh");
        const result = await detectChanges(root, base);
        assert.equal(result.headUnborn, true);
        assert.equal(result.baseExists, true);
        assert.equal(result.headMoved, true);
        assert.equal(result.fullRescan, true);
    } finally {
        await removeProject(root);
    }
});

/* -------------------------------------------------------------------------
 * getCommitsSince / getCommitLog
 * ---------------------------------------------------------------------- */

test("commits since a ref come newest first with their files", async () => {
    const root = await makeRepo();
    try {
        const base = head(root);
        await write(root, "b.txt", "b\n");
        commitAll(root, "add b");
        git(root, "mv", "keep.txt", "kept file.txt");
        await write(root, "a.txt", "edited\n");
        commitAll(root, "rename and edit");

        const commits = await getCommitsSince(root, base, { includeFiles: true });
        assert.deepEqual(commits.map((c) => c.subject), ["rename and edit", "add b"]);
        assert.equal(commits[0].hash, head(root));
        assert.equal(commits[0].author, "Tyr");
        assert.ok(commits[0].hash.startsWith(commits[0].shortHash));
        assert.ok(!Number.isNaN(Date.parse(commits[0].date)));

        const files = commits[0].files ?? [];
        assert.deepEqual(
            files.map((f) => [f.status, f.path, f.oldPath]).sort(),
            [["M", "a.txt", null], ["R", "kept file.txt", "keep.txt"]],
        );
        assert.deepEqual(commits[1].files?.map((f) => [f.status, f.path]), [["A", "b.txt"]]);

        // Files are only listed on request.
        const plain = await getCommitsSince(root, base);
        assert.equal(plain.length, 2);
        assert.equal(plain[0].files, undefined);
    } finally {
        await removeProject(root);
    }
});

test("a null or empty ref means all commits, capped by limit", async () => {
    const root = await makeRepo();
    try {
        for (const n of [2, 3, 4]) {
            await write(root, `f${n}.txt`, `${n}\n`);
            commitAll(root, `commit ${n}`);
        }

        assert.equal((await getCommitsSince(root, null)).length, 4);
        assert.equal((await getCommitsSince(root, "")).length, 4);

        const capped = await getCommitLog(root, null, { limit: 2, includeFiles: true });
        assert.deepEqual(capped.commits.map((c) => c.subject), ["commit 4", "commit 3"]);
        assert.equal(capped.hasMore, true);
        assert.equal(capped.refResolved, true);

        const exact = await getCommitLog(root, null, { limit: 4 });
        assert.equal(exact.hasMore, false);
        assert.equal(exact.commits[3].subject, "first");
    } finally {
        await removeProject(root);
    }
});

test("an unresolvable ref, an unborn HEAD, and a non-repo give empty logs", async () => {
    const root = await makeRepo();
    const unborn = await makeProject({ "a.txt": "a" });
    const plain = await makeProject({ "a.txt": "a" });
    try {
        git(unborn, "init", "-q");

        const missing = await getCommitLog(root, "0123456789abcdef0123456789abcdef01234567");
        assert.deepEqual(missing, { commits: [], refResolved: false, hasMore: false });
        assert.deepEqual(await getCommitsSince(root, "no-such-branch"), []);
        assert.deepEqual(await getCommitsSince(root, head(root)), []);
        assert.deepEqual(await getCommitsSince(unborn, null), []);
        assert.deepEqual(await getCommitsSince(plain, null), []);
    } finally {
        await removeProject(root);
        await removeProject(unborn);
        await removeProject(plain);
    }
});

test("merge commits list first-parent files; subjects with odd bytes parse", async () => {
    const root = await makeRepo();
    try {
        const base = head(root);
        git(root, "checkout", "-q", "-b", "side");
        await write(root, "side.txt", "s\n");
        commitAll(root, "side work");
        git(root, "checkout", "-q", "-");
        await write(root, "main.txt", "m\n");
        commitAll(root, "subject with \u001f weird | bytes");
        git(root, "merge", "-q", "--no-ff", "-m", "merge side", "side");

        const commits = await getCommitsSince(root, base, { includeFiles: true });
        assert.equal(commits.length, 3);
        const merge = commits.find((c) => c.subject === "merge side");
        assert.deepEqual(merge?.files?.map((f) => f.path), ["side.txt"]);
        assert.ok(commits.some((c) => c.subject === "subject with \u001f weird | bytes"));
    } finally {
        await removeProject(root);
    }
});

test("a branch name works as a reference point", async () => {
    const root = await makeRepo();
    try {
        git(root, "branch", "session-start");
        await write(root, "b.txt", "b\n");
        commitAll(root, "claude: add b");
        const commits = await getCommitsSince(root, "session-start");
        assert.deepEqual(commits.map((c) => c.subject), ["claude: add b"]);
    } finally {
        await removeProject(root);
    }
});
