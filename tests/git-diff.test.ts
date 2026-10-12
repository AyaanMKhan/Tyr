// git-diff.ts: staged/unstaged/since diffs, stats, renames, binaries,
// truncation, unborn HEAD and bad refs, against real throwaway repos.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getDiff, getDiffStat } from "../cli/core/git-diff.js";
import { makeProject, removeProject } from "./helpers.js";

function git(root: string, ...args: string[]): string {
    return execFileSync("git", ["-c", "user.name=Tyr", "-c", "user.email=tyr@example.com", ...args], {
        cwd: root,
        encoding: "utf8",
    });
}

async function makeRepo(files: Record<string, string> = { "a.txt": "one\ntwo\nthree\n" }): Promise<string> {
    const root = await makeProject(files);
    git(root, "init", "-q");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "first");
    return root;
}

async function write(root: string, relative: string, contents: string | Buffer): Promise<void> {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
}

test("unstaged diff reports edits to tracked files with line counts and a patch", async () => {
    const root = await makeRepo();
    try {
        await write(root, "a.txt", "one\nTWO\nthree\nfour\n");
        const diff = await getDiff(root, { kind: "unstaged" });
        assert.ok(diff !== null);
        assert.deepEqual(diff.files, [
            { path: "a.txt", status: "M", additions: 2, deletions: 1, binary: false },
        ]);
        assert.deepEqual(diff.totals, { files: 1, additions: 2, deletions: 1 });
        assert.equal(diff.truncated, false);
        assert.match(diff.patch, /^diff --git a\/a\.txt b\/a\.txt/);
        assert.match(diff.patch, /\n\+TWO\n/);
        assert.doesNotMatch(diff.patch, /\u001b\[/); // no colour codes
        assert.equal(diff.untracked, null);

        // Nothing staged yet.
        const staged = await getDiff(root, { kind: "staged" });
        assert.ok(staged !== null);
        assert.deepEqual(staged.files, []);
        assert.equal(staged.patch, "");
    } finally {
        await removeProject(root);
    }
});

test("staged and unstaged scopes separate index and working-tree changes", async () => {
    const root = await makeRepo();
    try {
        await write(root, "a.txt", "one\ntwo\nthree\nstaged\n");
        git(root, "add", "a.txt");
        await write(root, "a.txt", "one\ntwo\nthree\nstaged\nunstaged\n");

        const staged = await getDiff(root, { kind: "staged" });
        const unstaged = await getDiff(root, { kind: "unstaged" });
        assert.ok(staged !== null && unstaged !== null);
        assert.match(staged.patch, /\+staged\n/);
        assert.doesNotMatch(staged.patch, /\+unstaged/);
        assert.match(unstaged.patch, /\+unstaged\n/);
        assert.doesNotMatch(unstaged.patch, /\+staged\n/);
    } finally {
        await removeProject(root);
    }
});

test("renames, deletions, additions, spaces and unicode paths parse from -z output", async () => {
    const root = await makeRepo({
        "old name.txt": "alpha\nbeta\ngamma\ndelta\nepsilon\n",
        "gone.txt": "bye\n",
    });
    try {
        git(root, "mv", "old name.txt", "new näme → ünïcode.txt");
        git(root, "rm", "-q", "gone.txt");
        await write(root, "dir with space/fresh\tfile.txt", "hi\n");
        git(root, "add", ".");

        const stat = await getDiffStat(root, { kind: "staged" });
        assert.ok(stat !== null);
        const byPath = new Map(stat.files.map((file) => [file.path, file]));

        const renamed = byPath.get("new näme → ünïcode.txt");
        assert.ok(renamed !== undefined);
        assert.equal(renamed.status, "R");
        assert.equal(renamed.oldPath, "old name.txt");
        assert.equal(renamed.similarity, 100);
        assert.equal(renamed.additions, 0);

        assert.equal(byPath.get("gone.txt")?.status, "D");
        assert.equal(byPath.get("gone.txt")?.deletions, 1);
        assert.equal(byPath.get("dir with space/fresh\tfile.txt")?.status, "A");
        assert.equal(stat.totals.files, 3);

        // With rename detection off, the rename is a delete plus an add.
        const plain = await getDiffStat(root, { kind: "staged" }, { findRenames: false });
        assert.ok(plain !== null);
        assert.equal(plain.files.find((file) => file.path === "old name.txt")?.status, "D");
        assert.equal(plain.files.find((file) => file.path === "new näme → ünïcode.txt")?.status, "A");
    } finally {
        await removeProject(root);
    }
});

test("binary files are flagged and contribute no line counts", async () => {
    const root = await makeRepo();
    try {
        await write(root, "image.bin", Buffer.from([0, 1, 2, 3, 0, 255, 254, 0]));
        git(root, "add", "image.bin");
        const diff = await getDiff(root, { kind: "staged" });
        assert.ok(diff !== null);
        assert.deepEqual(diff.files, [
            { path: "image.bin", status: "A", additions: 0, deletions: 0, binary: true },
        ]);
        assert.match(diff.patch, /Binary files/);
    } finally {
        await removeProject(root);
    }
});

test("staged diff on a repo with no commits compares against the empty tree", async () => {
    const root = await makeProject({ "a.txt": "x\ny\n" });
    try {
        git(root, "init", "-q");
        git(root, "add", ".");
        const diff = await getDiff(root, { kind: "staged" });
        assert.ok(diff !== null);
        assert.deepEqual(diff.files, [{ path: "a.txt", status: "A", additions: 2, deletions: 0, binary: false }]);
        assert.match(diff.patch, /new file mode/);

        // There is no HEAD to diff from or to.
        assert.equal(await getDiff(root, { kind: "since", ref: "HEAD" }), null);
    } finally {
        await removeProject(root);
    }
});

test("since diffs a ref against the working tree, or against HEAD", async () => {
    const root = await makeRepo();
    try {
        const base = git(root, "rev-parse", "HEAD").trim();
        await write(root, "b.txt", "committed\n");
        git(root, "add", "b.txt");
        git(root, "commit", "-q", "-m", "second");
        await write(root, "a.txt", "one\ntwo\nthree\nwip\n");

        const worktree = await getDiffStat(root, { kind: "since", ref: base });
        assert.ok(worktree !== null);
        assert.deepEqual(worktree.files.map((file) => file.path).sort(), ["a.txt", "b.txt"]);

        const committed = await getDiffStat(root, { kind: "since", ref: base, until: "head" });
        assert.ok(committed !== null);
        assert.deepEqual(committed.files.map((file) => file.path), ["b.txt"]);

        // Symbolic refs resolve too.
        const relative = await getDiffStat(root, { kind: "since", ref: "HEAD~1", until: "head" });
        assert.deepEqual(relative?.files.map((file) => file.path), ["b.txt"]);
    } finally {
        await removeProject(root);
    }
});

test("an unknown or option-like ref yields null instead of throwing", async () => {
    const root = await makeRepo();
    try {
        assert.equal(await getDiff(root, { kind: "since", ref: "no-such-branch" }), null);
        assert.equal(await getDiffStat(root, { kind: "since", ref: "--output=pwned.txt" }), null);
        assert.equal(await getDiffStat(root, { kind: "since", ref: "" }), null);
        await assert.rejects(fs.access(path.join(root, "pwned.txt")));
    } finally {
        await removeProject(root);
    }
});

test("a non-repository yields null", async () => {
    const root = await makeProject({ "a.txt": "a\n" });
    try {
        assert.equal(await getDiff(root, { kind: "unstaged" }), null);
        assert.equal(await getDiffStat(root, { kind: "staged" }), null);
    } finally {
        await removeProject(root);
    }
});

test("an oversized patch is truncated at a line boundary, with full stats", async () => {
    const lines = Array.from({ length: 2000 }, (_, n) => `line ${n}`).join("\n") + "\n";
    const root = await makeRepo();
    try {
        await write(root, "big.txt", lines);
        git(root, "add", "big.txt");
        const diff = await getDiff(root, { kind: "staged" }, { maxPatchBytes: 1000 });
        assert.ok(diff !== null);
        assert.equal(diff.truncated, true);
        assert.ok(Buffer.byteLength(diff.patch) <= 1000);
        assert.ok(diff.patch.endsWith("\n"));
        assert.equal(diff.files[0].additions, 2000);

        const full = await getDiff(root, { kind: "staged" });
        assert.equal(full?.truncated, false);
        assert.ok(full !== null && full.patch.startsWith(diff.patch));
    } finally {
        await removeProject(root);
    }
});

test("pathspec and context-line options narrow the diff", async () => {
    const root = await makeRepo({
        "a.txt": "1\n2\n3\n4\n5\n6\n7\n8\n9\n",
        "src/b.txt": "b\n",
    });
    try {
        await write(root, "a.txt", "1\n2\n3\n4\nFIVE\n6\n7\n8\n9\n");
        await write(root, "src/b.txt", "B\n");

        const onlySrc = await getDiff(root, { kind: "unstaged" }, { pathspec: ["src"] });
        assert.deepEqual(onlySrc?.files.map((file) => file.path), ["src/b.txt"]);

        const tight = await getDiff(root, { kind: "unstaged" }, { pathspec: ["a.txt"], contextLines: 0 });
        assert.ok(tight !== null);
        assert.match(tight.patch, /@@ -5 \+5 @@/);
        assert.doesNotMatch(tight.patch, /^ 4$/m);
    } finally {
        await removeProject(root);
    }
});

test("untracked files are listed separately only when asked for", async () => {
    const root = await makeRepo();
    try {
        await write(root, "new file.txt", "n\n");
        await write(root, ".gitignore", "ignored.log\n");
        await write(root, "ignored.log", "x\n");

        const without = await getDiffStat(root, { kind: "unstaged" });
        assert.ok(without !== null);
        assert.deepEqual(without.files, []); // git diff never shows untracked files
        assert.equal(without.untracked, null);

        const withUntracked = await getDiffStat(root, { kind: "unstaged" }, { includeUntracked: true });
        assert.deepEqual(withUntracked?.untracked?.sort(), [".gitignore", "new file.txt"]);

        // Staged and since..HEAD scopes don't look at the working tree.
        const staged = await getDiffStat(root, { kind: "staged" }, { includeUntracked: true });
        assert.equal(staged?.untracked, null);
    } finally {
        await removeProject(root);
    }
});

test("paths are top-level relative when root is a subdirectory", async () => {
    const root = await makeRepo({ "pkg/x.txt": "x\n", "y.txt": "y\n" });
    try {
        await write(root, "pkg/x.txt", "X\n");
        await write(root, "y.txt", "Y\n");
        const stat = await getDiffStat(path.join(root, "pkg"), { kind: "unstaged" });
        assert.deepEqual(stat?.files.map((file) => file.path).sort(), ["pkg/x.txt", "y.txt"]);
    } finally {
        await removeProject(root);
    }
});
