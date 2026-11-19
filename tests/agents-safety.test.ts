// agents/safety.ts: permission gate, run defaults, worktree isolation.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import type { ProposedChange } from "../cli/agents/model.js";
import {
    createAgentWorktree,
    createGate,
    createTerminalPrompter,
    DEFAULT_PROTECTED_PATHS,
    formatApprovalQuestion,
    listAgentWorktrees,
    matchesPattern,
    removeAgentWorktree,
    resolveRunSafety,
    resolveWorkspacePath,
    SECRET_PATHS,
    type SafetyDecision,
} from "../cli/agents/safety.js";
import { makeProject, removeProject } from "./helpers.js";

const FIXED = () => new Date("2026-11-18T09:08:07Z");

function change(file: string, summary = "edit"): ProposedChange {
    return { tool: "edit_file", path: file, summary };
}

async function withWorkspace(fn: (root: string) => Promise<void>): Promise<void> {
    const root = await makeProject({ "src/a.ts": "a\n" });
    try {
        await fn(root);
    } finally {
        await removeProject(root);
    }
}

/* ---------------------------------------------------------------- ceiling */

test("check denies permissions above the ceiling", async () => {
    await withWorkspace(async (root) => {
        const gate = createGate({ ceiling: "execute", workspace: root, approval: "auto", dryRun: false });
        assert.deepEqual(gate.check("read_file", "read"), { allowed: true });
        assert.deepEqual(gate.check("run_check", "execute"), { allowed: true });
        const write = gate.check("edit_file", "write", "src/a.ts");
        assert.equal(write.allowed, false);
        assert.match(!write.allowed ? write.reason : "", /ceiling/);

        const readOnly = createGate({ ceiling: "read", workspace: root, approval: "auto", dryRun: false });
        assert.equal(readOnly.check("run_check", "execute").allowed, false);
        assert.equal(readOnly.check("x", "admin" as never).allowed, false);
    });
});

/* ------------------------------------------------------------------ paths */

test("paths outside the workspace are denied in every spelling", async () => {
    await withWorkspace(async (root) => {
        const gate = createGate({ ceiling: "write", workspace: root, approval: "auto", dryRun: false });
        for (const bad of [
            "../outside.txt",
            "src/../../outside.txt",
            "..\\outside.txt",
            "src\\..\\..\\outside.txt",
            path.dirname(root),
            path.join(path.dirname(root), "other", "x.ts"),
            "C:/Windows/System32/drivers/etc/hosts",
            "C:\\Windows\\win.ini",
            "\\\\server\\share\\x",
            "",
            ".",
            "a\0b",
        ]) {
            assert.equal(gate.check("edit_file", "write", bad).allowed, false, `expected ${JSON.stringify(bad)} denied`);
        }
        for (const good of ["src/a.ts", "src\\a.ts", "./src/new.ts", "src/../src/a.ts", path.join(root, "src", "a.ts")]) {
            assert.deepEqual(gate.check("edit_file", "write", good), { allowed: true }, `expected ${good} allowed`);
        }
    });
});

test("absolute Windows paths inside the workspace are accepted on Windows", { skip: process.platform !== "win32" }, async () => {
    await withWorkspace(async (root) => {
        const gate = createGate({ ceiling: "write", workspace: root, approval: "auto", dryRun: false });
        const backslashed = path.join(root, "src", "a.ts");
        assert.equal(gate.check("edit_file", "write", backslashed).allowed, true);
        assert.equal(gate.check("edit_file", "write", backslashed.replace(/\\/g, "/")).allowed, true);
        assert.equal(gate.check("edit_file", "write", backslashed.toUpperCase()).allowed, true);
        assert.equal(gate.check("edit_file", "write", "C:src\\a.ts").allowed, false);
    });
});

test("a symlinked directory pointing outside is denied", async (t) => {
    const outside = await makeProject({ "secret.txt": "x" });
    try {
        await withWorkspace(async (root) => {
            try {
                await fs.symlink(outside, path.join(root, "link"), "junction");
            } catch {
                t.skip("symlinks not available");
                return;
            }
            const gate = createGate({ ceiling: "write", workspace: root, approval: "auto", dryRun: false });
            assert.equal(gate.check("read_file", "read", "link/secret.txt").allowed, false);
            assert.equal(gate.check("edit_file", "write", "link/new.txt").allowed, false);
        });
    } finally {
        await removeProject(outside);
    }
});

test(".git, .tyr, secrets and protected files", async () => {
    await withWorkspace(async (root) => {
        const gate = createGate({ ceiling: "write", workspace: root, approval: "auto", dryRun: false });
        // .git: never, not even reads, at any depth and in any case.
        for (const p of [".git/config", ".GIT/HEAD", "sub/.git/config", ".git\\hooks\\pre-commit"]) {
            assert.equal(gate.check("read_file", "read", p).allowed, false, p);
        }
        assert.equal(gate.check("read_file", "read", ".github/workflows/ci.yml").allowed, true);
        // .tyr: readable, never writable.
        assert.equal(gate.check("read_file", "read", ".tyr/tyr.json").allowed, true);
        assert.equal(gate.check("edit_file", "write", ".tyr/tyr.json").allowed, false);
        assert.equal(gate.check("edit_file", "write", ".tyr\\state\\x.json").allowed, false);
        // Secrets: no access at all.
        for (const p of [".env", ".env.local", "config/.ENV.production", "certs/server.pem", "keys/api.key", "id_rsa"]) {
            assert.equal(gate.check("read_file", "read", p).allowed, false, p);
        }
        // Protected: readable, not writable.
        for (const p of ["package-lock.json", "sub/yarn.lock", ".claude/settings.json", ".claude\\settings.local.json"]) {
            assert.equal(gate.check("read_file", "read", p).allowed, true, p);
            assert.equal(gate.check("edit_file", "write", p).allowed, false, p);
        }
        // Only the root .claude/settings.json is protected by that rule.
        assert.equal(gate.check("edit_file", "write", "docs/.claude/settings.json").allowed, true);
        assert.equal(gate.check("edit_file", "write", "src/keyboard.ts").allowed, true);
    });
});

test("protectedPaths extends and allowPaths lifts the protected list", async () => {
    await withWorkspace(async (root) => {
        const gate = createGate({
            ceiling: "write",
            workspace: root,
            approval: "auto",
            dryRun: false,
            protectedPaths: ["migrations/*.sql", "*.snap"],
            allowPaths: ["package-lock.json", ".env", ".tyr/tyr.json"],
        });
        assert.equal(gate.check("edit_file", "write", "migrations/001.sql").allowed, false);
        assert.equal(gate.check("edit_file", "write", "src/__snapshots__/a.snap").allowed, false);
        assert.equal(gate.check("edit_file", "write", "package-lock.json").allowed, true);
        assert.equal(gate.check("edit_file", "write", "yarn.lock").allowed, false);
        // Secrets and .tyr cannot be lifted.
        assert.equal(gate.check("edit_file", "write", ".env").allowed, false);
        assert.equal(gate.check("edit_file", "write", ".tyr/tyr.json").allowed, false);
    });
});

test("pattern matching and exported lists", () => {
    assert.ok(SECRET_PATHS.includes(".env"));
    assert.ok(DEFAULT_PROTECTED_PATHS.includes("package-lock.json"));
    assert.equal(matchesPattern("a/b/.env.test", ".env.*"), true);
    assert.equal(matchesPattern("a/b/env.test", ".env.*"), false);
    assert.equal(matchesPattern(".claude/settings.json", ".claude/settings.json"), true);
    assert.equal(matchesPattern("x/.claude/settings.json", ".claude/settings.json"), false);
    assert.equal(matchesPattern("Cargo.LOCK", "Cargo.lock"), true);
    const verdict = resolveWorkspacePath(process.cwd(), "src\\x.ts");
    assert.equal(verdict.ok && verdict.relative, "src/x.ts");
});

/* --------------------------------------------------------------- approval */

test("approval modes", async () => {
    await withWorkspace(async (root) => {
        const asked: string[] = [];
        const prompter = async (c: ProposedChange) => {
            asked.push(c.path);
            return c.path !== "src/no.ts";
        };
        const auto = createGate({ ceiling: "write", workspace: root, approval: "auto", dryRun: false, prompter });
        assert.deepEqual(await auto.approve(change("src/a.ts")), { allowed: true });

        const deny = createGate({ ceiling: "write", workspace: root, approval: "deny", dryRun: false, prompter });
        assert.equal((await deny.approve(change("src/a.ts"))).allowed, false);

        const ask = createGate({ ceiling: "write", workspace: root, approval: "ask", dryRun: false, prompter });
        assert.deepEqual(await ask.approve(change("src/yes.ts")), { allowed: true });
        assert.equal((await ask.approve(change("src/no.ts"))).allowed, false);
        // The path policy runs before anyone is asked.
        assert.equal((await ask.approve(change("../escape.ts"))).allowed, false);
        assert.equal((await ask.approve(change("package-lock.json"))).allowed, false);
        assert.deepEqual(asked, ["src/yes.ts", "src/no.ts"]);

        const throwing = createGate({
            ceiling: "write",
            workspace: root,
            approval: "ask",
            dryRun: false,
            prompter: async () => {
                throw new Error("boom");
            },
        });
        assert.equal((await throwing.approve(change("src/a.ts"))).allowed, false);
    });
});

test("dry-run approves without asking but still applies the path policy", async () => {
    await withWorkspace(async (root) => {
        let asked = 0;
        const gate = createGate({
            ceiling: "write",
            workspace: root,
            approval: "deny",
            dryRun: true,
            prompter: async () => {
                asked++;
                return false;
            },
        });
        assert.deepEqual(await gate.approve(change("src/a.ts")), { allowed: true });
        assert.equal((await gate.approve(change(".git/config"))).allowed, false);
        assert.equal(asked, 0);
        assert.equal(gate.decisions[0].via, "dry-run");
    });
});

test("prompts are asked one at a time", async () => {
    await withWorkspace(async (root) => {
        let active = 0;
        let maxActive = 0;
        const gate = createGate({
            ceiling: "write",
            workspace: root,
            approval: "ask",
            dryRun: false,
            prompter: async () => {
                active++;
                maxActive = Math.max(maxActive, active);
                await new Promise((resolve) => setTimeout(resolve, 10));
                active--;
                return true;
            },
        });
        await Promise.all([gate.approve(change("a.ts")), gate.approve(change("b.ts")), gate.approve(change("c.ts"))]);
        assert.equal(maxActive, 1);
    });
});

test("every decision is recorded and reported", async () => {
    await withWorkspace(async (root) => {
        const seen: SafetyDecision[] = [];
        const gate = createGate({
            ceiling: "write",
            workspace: root,
            approval: "auto",
            dryRun: false,
            now: FIXED,
            onDecision: (d) => {
                seen.push(d);
                throw new Error("observer bug must not matter");
            },
        });
        gate.check("read_file", "read", "src\\a.ts");
        gate.check("read_file", "read", ".env");
        await gate.approve(change("src/a.ts", "replace 1 line"));
        assert.equal(gate.decisions.length, 3);
        assert.deepEqual(seen, gate.decisions);
        assert.deepEqual(gate.decisions[0], {
            at: "2026-11-18T09:08:07.000Z",
            kind: "check",
            tool: "read_file",
            permission: "read",
            path: "src/a.ts",
            allowed: true,
            reason: undefined,
            via: "policy",
        });
        assert.equal(gate.decisions[1].allowed, false);
        assert.match(gate.decisions[1].reason ?? "", /secrets/);
        assert.equal(gate.decisions[2].kind, "approve");
        assert.equal(gate.decisions[2].via, "auto");
        assert.equal(gate.decisions[2].summary, "replace 1 line");
    });
});

/* -------------------------------------------------------------- prompter */

test("the terminal prompter refuses without a terminal and never reads input", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const prompter = createTerminalPrompter({ input, output, isInteractive: () => false });
    assert.equal(await prompter(change("src/a.ts")), false);
    assert.equal(output.read(), null);
});

test("the default gate prompter refuses under a non-TTY test runner", async () => {
    if (process.stdin.isTTY && process.stdout.isTTY && !process.env.CI) return;
    await withWorkspace(async (root) => {
        const gate = createGate({ ceiling: "write", workspace: root, approval: "ask", dryRun: false });
        const decision = await gate.approve(change("src/a.ts"));
        assert.equal(decision.allowed, false);
    });
});

test("the terminal prompter asks y/N when interactive", async () => {
    for (const [answer, expected] of [
        ["y\n", true],
        ["n\n", false],
        ["\n", false],
    ] as const) {
        const input = new PassThrough();
        const output = new PassThrough();
        const prompter = createTerminalPrompter({ input, output, isInteractive: () => true });
        const pending = prompter({ ...change("src/a.ts"), patch: "-a\n+b\n" });
        input.end(answer);
        assert.equal(await pending, expected);
        const shown = String(output.read() ?? "");
        assert.match(shown, /edit_file wants to change src\/a\.ts/);
        assert.match(shown, /\(y\/N\)/);
    }
});

test("approval question truncates long patches", () => {
    const patch = Array.from({ length: 100 }, (_, i) => `+line ${i}`).join("\n");
    const text = formatApprovalQuestion({ ...change("x.ts"), patch });
    assert.match(text, /\.\.\. \(60 more lines\)/);
    assert.ok(text.endsWith("Apply this change?"));
});

/* ----------------------------------------------------------- run defaults */

test("resolveRunSafety policy table", () => {
    const fixer = { id: "fixer" as const, permission: "write" as const };
    const reviewer = { id: "reviewer" as const, permission: "read" as const };
    const runner = { id: "test-runner" as const, permission: "execute" as const };
    const pick = (input: Parameters<typeof resolveRunSafety>[0]) => {
        const { dryRun, isolate, approval } = resolveRunSafety(input);
        return { dryRun, isolate, approval };
    };

    // Non-writing roles: always in place, nothing to approve.
    for (const role of [reviewer, runner]) {
        assert.deepEqual(pick({ role, apply: true, yes: true, isolate: true, interactive: true }), {
            dryRun: true,
            isolate: false,
            approval: "deny",
        });
    }
    // Write role without --apply: dry-run.
    assert.deepEqual(pick({ role: fixer, interactive: true }), { dryRun: true, isolate: false, approval: "deny" });
    assert.deepEqual(pick({ role: fixer, yes: true, interactive: false }), { dryRun: true, isolate: false, approval: "deny" });
    assert.deepEqual(pick({ role: fixer, isolate: true, interactive: true }), { dryRun: true, isolate: true, approval: "deny" });
    // --apply --isolate: auto on a throwaway branch.
    assert.deepEqual(pick({ role: fixer, apply: true, isolate: true, interactive: false }), {
        dryRun: false,
        isolate: true,
        approval: "auto",
    });
    // In place.
    assert.deepEqual(pick({ role: fixer, apply: true, yes: true, interactive: false }), {
        dryRun: false,
        isolate: false,
        approval: "auto",
    });
    assert.deepEqual(pick({ role: fixer, apply: true, interactive: true }), { dryRun: false, isolate: false, approval: "ask" });
    const refused = resolveRunSafety({ role: fixer, apply: true, interactive: false });
    assert.equal(refused.approval, "deny");
    assert.match(refused.explanation, /--yes/);
});

/* ---------------------------------------------------------------- worktree */

function git(root: string, ...args: string[]): string {
    return execFileSync("git", ["-c", "user.name=Tyr", "-c", "user.email=tyr@example.com", ...args], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
}

async function withRepo(fn: (root: string) => Promise<void>): Promise<void> {
    const root = await makeProject({ "a.txt": "a\n", "b.txt": "b\n", "bin.dat": "\u0000\u0001" });
    try {
        git(root, "init", "-q", "-b", "main");
        git(root, "add", ".");
        git(root, "commit", "-q", "-m", "first");
        await fn(root);
    } finally {
        // Worktrees hold their own .git file; plain rm handles them.
        await removeProject(root);
    }
}

test("createAgentWorktree refuses non-repos and unborn HEAD", async () => {
    const plain = await makeProject({ "a.txt": "a" });
    try {
        const result = await createAgentWorktree(plain, { role: "fixer" });
        assert.ok("error" in result);
        git(plain, "init", "-q");
        const unborn = await createAgentWorktree(plain, { role: "fixer" });
        assert.ok("error" in unborn);
        assert.match(unborn.error, /no commits/);
    } finally {
        await removeProject(plain);
    }
});

test("createAgentWorktree branches from HEAD without touching the user's tree", async () => {
    await withRepo(async (root) => {
        await fs.writeFile(path.join(root, "a.txt"), "changed\n");
        const statusBefore = git(root, "status", "--porcelain");
        const result = await createAgentWorktree(root, { role: "fixer", now: FIXED });
        assert.ok(!("error" in result), JSON.stringify(result));
        assert.equal(result.branch, "tyr/fixer-20261118-090807");
        assert.equal(result.base, git(root, "rev-parse", "HEAD").trim());
        assert.equal(path.relative(path.join(root, ".tyr", "worktrees"), result.path), "fixer-20261118-090807");
        assert.equal(result.workspace, result.path);
        assert.equal(result.carried, undefined);

        // User's branch and working tree untouched; .tyr/worktrees is ignored.
        assert.equal(git(root, "branch", "--show-current").trim(), "main");
        assert.equal(git(root, "status", "--porcelain"), statusBefore);
        // Without carryChanges the worktree is a clean HEAD checkout.
        // core.autocrlf may turn LF into CRLF on checkout.
        assert.equal((await fs.readFile(path.join(result.path, "a.txt"), "utf8")).replace(/\r\n/g, "\n"), "a\n");
        assert.equal(git(result.path, "branch", "--show-current").trim(), "tyr/fixer-20261118-090807");

        // Same second again: a suffixed name, not a failure.
        const second = await createAgentWorktree(root, { role: "fixer", now: FIXED });
        assert.ok(!("error" in second));
        assert.equal(second.branch, "tyr/fixer-20261118-090807-2");

        const listed = await listAgentWorktrees(root);
        assert.ok(!("error" in listed));
        assert.deepEqual(listed.map((entry) => entry.branch).sort(), ["tyr/fixer-20261118-090807", "tyr/fixer-20261118-090807-2"]);
    });
});

test("carryChanges copies modified, added, deleted and untracked files", async () => {
    await withRepo(async (root) => {
        await fs.writeFile(path.join(root, "a.txt"), "changed\r\n");
        await fs.writeFile(path.join(root, "bin.dat"), Buffer.from([0, 2, 255]));
        await fs.rm(path.join(root, "b.txt"));
        await fs.mkdir(path.join(root, "new"), { recursive: true });
        await fs.writeFile(path.join(root, "new", "staged.txt"), "staged\n");
        git(root, "add", "new/staged.txt");
        await fs.writeFile(path.join(root, "new", "untracked.txt"), "untracked\n");
        await fs.writeFile(path.join(root, ".gitignore"), "ignored.log\n");
        await fs.writeFile(path.join(root, "ignored.log"), "noise\n");
        const statusBefore = git(root, "status", "--porcelain");

        const result = await createAgentWorktree(root, { role: "fixer", now: FIXED, carryChanges: true });
        assert.ok(!("error" in result), JSON.stringify(result));
        const read = (file: string) => fs.readFile(path.join(result.path, file));

        assert.equal((await read("a.txt")).toString(), "changed\r\n");
        assert.deepEqual([...(await read("bin.dat"))], [0, 2, 255]);
        await assert.rejects(read("b.txt"));
        assert.equal((await read("new/staged.txt")).toString(), "staged\n");
        assert.equal((await read("new/untracked.txt")).toString(), "untracked\n");
        await assert.rejects(read("ignored.log"));
        assert.deepEqual(result.carried?.deleted, ["b.txt"]);
        assert.deepEqual([...(result.carried?.copied ?? [])].sort(), [".gitignore", "a.txt", "bin.dat", "new/staged.txt", "new/untracked.txt"]);

        // The user's side is exactly as it was.
        assert.equal(git(root, "status", "--porcelain"), statusBefore);
        assert.equal(git(root, "branch", "--show-current").trim(), "main");
    });
});

test("removeAgentWorktree removes only agent worktrees and honors keepBranch", async () => {
    await withRepo(async (root) => {
        const first = await createAgentWorktree(root, { role: "fixer", now: FIXED });
        const second = await createAgentWorktree(root, { role: "reviewer", now: FIXED });
        assert.ok(!("error" in first) && !("error" in second));

        // Not an agent worktree.
        assert.ok("error" in (await removeAgentWorktree(root, root)));
        assert.ok("error" in (await removeAgentWorktree(root, path.join(root, "nope"))));

        // Dirty: refused unless forced.
        await fs.writeFile(path.join(first.path, "a.txt"), "agent edit\n");
        const dirty = await removeAgentWorktree(root, first.path);
        assert.ok("error" in dirty);
        assert.match(dirty.error, /uncommitted/);
        const forced = await removeAgentWorktree(root, first.path, { force: true });
        assert.ok(!("error" in forced), JSON.stringify(forced));
        assert.equal(forced.branchDeleted, false);
        assert.match(git(root, "branch", "--list", first.branch), /tyr\/fixer/);

        const gone = await removeAgentWorktree(root, second.path, { keepBranch: false });
        assert.ok(!("error" in gone), JSON.stringify(gone));
        assert.equal(gone.branchDeleted, true);
        assert.equal(git(root, "branch", "--list", second.branch).trim(), "");

        const listed = await listAgentWorktrees(root);
        assert.deepEqual(listed, []);
        assert.equal(git(root, "branch", "--show-current").trim(), "main");
    });
});

test("worktree functions use the injected git runner", async () => {
    const calls: string[][] = [];
    const fake = async (_root: string, args: string[]) => {
        calls.push(args);
        return { ok: false, stdout: "", stderr: "fatal: not a git repository", timedOut: false, truncated: false };
    };
    const created = await createAgentWorktree(process.cwd(), { role: "fixer", git: fake });
    assert.ok("error" in created);
    const listed = await listAgentWorktrees(process.cwd(), { git: fake });
    assert.ok("error" in listed);
    assert.ok(calls.length >= 2);
});
