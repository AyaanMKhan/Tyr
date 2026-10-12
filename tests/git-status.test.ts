// git.ts status timeout fallback, and the detached flag in tyr.json.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { collectGitInfo, getStatusOutcome } from "../cli/core/git.js";
import { buildConfig } from "../cli/core/scaffold.js";
import { InitSnapshot } from "../cli/core/types.js";
import { makeProject, removeProject } from "./helpers.js";

function git(root: string, ...args: string[]): void {
    execFileSync("git", ["-c", "user.name=Tyr", "-c", "user.email=tyr@example.com", ...args], { cwd: root });
}

async function makeRepo(): Promise<string> {
    const root = await makeProject({ "a.txt": "a\n" });
    git(root, "init", "-q");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "first");
    return root;
}

test("a status that times out is retried without untracked files", async () => {
    const root = await makeRepo();
    try {
        await import("node:fs/promises").then((fs) => fs.writeFile(path.join(root, "new.txt"), "x"));
        // 1ms is far too short for any git spawn, so the first attempt times out.
        const outcome = await getStatusOutcome(root, { timeoutMs: 1, retryTimeoutMs: 10_000 });
        assert.equal(outcome.timedOut, false);
        assert.ok(outcome.status !== null);
        assert.equal(outcome.status.untrackedSkipped, true);
        assert.deepEqual(outcome.status.untracked, []);
    } finally {
        await removeProject(root);
    }
});

test("a status that times out twice reports timedOut instead of looking like a non-repo", async () => {
    const root = await makeRepo();
    try {
        const outcome = await getStatusOutcome(root, { timeoutMs: 1, retryTimeoutMs: 1 });
        assert.equal(outcome.status, null);
        assert.equal(outcome.timedOut, true);
    } finally {
        await removeProject(root);
    }
});

test("a normal status walks untracked files", async () => {
    const root = await makeRepo();
    try {
        const info = await collectGitInfo(root);
        assert.equal(info.statusTimedOut, false);
        assert.equal(info.status?.untrackedSkipped, false);
    } finally {
        await removeProject(root);
    }
});

test("buildConfig persists the detached flag next to the branch label", async () => {
    const root = await makeRepo();
    try {
        git(root, "tag", "v1.0");
        git(root, "checkout", "-q", "--detach", "v1.0");
        const info = await collectGitInfo(root);
        const snapshot = {
            discovery: { root, alreadyInitialized: false, files: [], fileCount: 0, skippedDirs: [] },
            git: info,
            project: {
                name: null, nameSource: null, languages: [], primaryLanguage: null, frameworks: [],
                packageManager: null, build: null, test: null, lint: null, format: null, typecheck: null,
                readme: null, claudeMd: null, workspace: null,
            },
        } as InitSnapshot;
        const config = buildConfig(snapshot, "1.0.0");
        assert.equal(config.git.branch, "v1.0");
        assert.equal(config.git.detached, true);
    } finally {
        await removeProject(root);
    }
});
