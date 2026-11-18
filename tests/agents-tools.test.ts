// Agent tools (cli/agents/tools.ts), against throwaway directories.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { PermissionGate, ProposedChange, ToolEnv } from "../cli/agents/model.js";
import { ALL_TOOLS, TOOL_NAMES, confinePath, createToolset, toolsFor, unifiedDiff } from "../cli/agents/tools.js";
import { runGit } from "../cli/core/git-exec.js";
import type { CheckRun } from "../cli/engine/model.js";
import { makeProject, removeProject } from "./helpers.js";

interface FakeGate extends PermissionGate {
    checks: Array<[string, string, string | undefined]>;
    approvals: ProposedChange[];
}

function gate(opts: { deny?: string; reject?: string } = {}): FakeGate {
    const g: FakeGate = {
        checks: [],
        approvals: [],
        check(tool, permission, p) {
            g.checks.push([tool, permission, p]);
            return opts.deny !== undefined && (opts.deny === tool || opts.deny === permission)
                ? { allowed: false, reason: "role may not do that" }
                : { allowed: true };
        },
        async approve(change) {
            g.approvals.push(change);
            return opts.reject !== undefined ? { allowed: false, reason: opts.reject } : { allowed: true };
        },
    };
    return g;
}

function envFor(workspace: string, g: PermissionGate = gate(), dryRun = false): ToolEnv {
    return { workspace, dryRun, gate: g };
}

async function call(ts: ReturnType<typeof createToolset>, name: string, input: unknown, env: ToolEnv) {
    const [tool] = ts.toolsFor([name]);
    assert.ok(tool, `tool ${name}`);
    return tool.run(input, env);
}

test("ALL_TOOLS has the agreed names and toolsFor picks in order", () => {
    assert.deepEqual(ALL_TOOLS.map((t) => t.name), [...TOOL_NAMES]);
    assert.deepEqual(toolsFor(["write_file", "read_file", "nope", "read_file"]).map((t) => t.name), ["write_file", "read_file"]);
    const perms = Object.fromEntries(ALL_TOOLS.map((t) => [t.name, t.permission]));
    assert.deepEqual(perms, {
        read_file: "read",
        list_files: "read",
        search: "read",
        git_diff: "read",
        run_check: "execute",
        edit_file: "write",
        write_file: "write",
    });
    for (const tool of ALL_TOOLS) assert.equal((tool.inputSchema as { type: string }).type, "object");
});

test("confinePath refuses escapes, absolute paths outside, .git and .tyr", async () => {
    const root = await makeProject({ "a.txt": "a", "sub/b.txt": "b" });
    const outside = await makeProject({ "secret.txt": "s" });
    try {
        assert.deepEqual(await confinePath(root, "sub/b.txt"), { abs: path.join(root, "sub", "b.txt"), rel: "sub/b.txt" });
        assert.deepEqual(await confinePath(root, path.join(root, "a.txt")), { abs: path.join(root, "a.txt"), rel: "a.txt" });
        for (const bad of ["../x", "sub/../../x", path.join(outside, "secret.txt"), ".git/config", ".tyr/tyr.json", "sub/.git/HEAD", "", "a\0b"]) {
            const r = await confinePath(root, bad);
            assert.ok("error" in r, `expected refusal for ${JSON.stringify(bad)}`);
        }
    } finally {
        await removeProject(root);
        await removeProject(outside);
    }
});

test("confinePath refuses symlinks that lead outside", async (t) => {
    const root = await makeProject({ "a.txt": "a" });
    const outside = await makeProject({ "secret.txt": "s" });
    try {
        try {
            await fs.symlink(outside, path.join(root, "link"), "junction");
        } catch {
            t.skip("cannot create symlinks here");
            return;
        }
        const ts = createToolset();
        const env = envFor(root);
        assert.ok("error" in (await confinePath(root, "link/secret.txt")));
        assert.ok("error" in (await confinePath(root, "link/new.txt")));
        const read = await call(ts, "read_file", { path: "link/secret.txt" }, env);
        assert.equal(read.isError, true);
        const write = await call(ts, "write_file", { path: "link/evil.txt", content: "x" }, env);
        assert.equal(write.isError, true);
        await assert.rejects(fs.stat(path.join(outside, "evil.txt")));
    } finally {
        await removeProject(root);
        await removeProject(outside);
    }
});

test("read_file returns numbered lines, honours ranges, and refuses outside paths", async () => {
    const root = await makeProject({ "f.txt": "one\ntwo\nthree\nfour\n", "bin.dat": "a\0b" });
    try {
        const g = gate();
        const ts = createToolset();
        const env = envFor(root, g);
        const all = await call(ts, "read_file", { path: "f.txt" }, env);
        assert.equal(all.isError, undefined);
        assert.equal(all.content, "f.txt (lines 1-4 of 4)\n1\tone\n2\ttwo\n3\tthree\n4\tfour");
        const part = await call(ts, "read_file", { path: "f.txt", start_line: 2, end_line: 3 }, env);
        assert.equal(part.content, "f.txt (lines 2-3 of 4)\n2\ttwo\n3\tthree");
        assert.deepEqual(g.checks[0], ["read_file", "read", "f.txt"]);

        assert.equal((await call(ts, "read_file", { path: "../f.txt" }, env)).isError, true);
        assert.equal((await call(ts, "read_file", { path: "missing.txt" }, env)).isError, true);
        assert.match((await call(ts, "read_file", { path: "bin.dat" }, env)).content, /binary/);
        assert.equal((await call(ts, "read_file", "f.txt", env)).isError, true);
    } finally {
        await removeProject(root);
    }
});

test("gate denial stops every tool before it acts", async () => {
    const root = await makeProject({ "f.txt": "hello\n" });
    try {
        const ts = createToolset({ loadCommands: async () => ({ test: "node -e 1" }), runCheck: async () => assert.fail("must not run") });
        const readDenied = envFor(root, gate({ deny: "read" }));
        const r = await call(ts, "read_file", { path: "f.txt" }, readDenied);
        assert.equal(r.isError, true);
        assert.match(r.content, /^denied: role may not do that/);
        assert.equal((await call(ts, "list_files", {}, readDenied)).isError, true);
        assert.equal((await call(ts, "search", { pattern: "x" }, readDenied)).isError, true);

        const execDenied = envFor(root, gate({ deny: "execute" }));
        assert.match((await call(ts, "run_check", { kind: "test" }, execDenied)).content, /^denied/);

        const writeDenied = gate({ deny: "write" });
        const env = envFor(root, writeDenied);
        assert.match((await call(ts, "edit_file", { path: "f.txt", old_string: "hello", new_string: "bye" }, env)).content, /^denied/);
        assert.match((await call(ts, "write_file", { path: "g.txt", content: "x" }, env)).content, /^denied/);
        assert.equal(await fs.readFile(path.join(root, "f.txt"), "utf8"), "hello\n");
        await assert.rejects(fs.stat(path.join(root, "g.txt")));
        assert.equal(writeDenied.approvals.length, 0);
        assert.equal(ts.changes.length, 0);
    } finally {
        await removeProject(root);
    }
});

test("edit_file requires a unique exact match and records the change", async () => {
    const root = await makeProject({ "f.ts": "const a = 1;\nconst b = 1;\nconst c = 2;\n" });
    try {
        const g = gate();
        const ts = createToolset();
        const env = envFor(root, g);
        const dup = await call(ts, "edit_file", { path: "f.ts", old_string: "= 1;", new_string: "= 3;" }, env);
        assert.equal(dup.isError, true);
        assert.match(dup.content, /occurs 2 times/);
        const missing = await call(ts, "edit_file", { path: "f.ts", old_string: "nope", new_string: "x" }, env);
        assert.match(missing.content, /not found/);
        assert.equal((await call(ts, "edit_file", { path: "f.ts", old_string: "", new_string: "x" }, env)).isError, true);
        assert.equal((await call(ts, "edit_file", { path: "nofile.ts", old_string: "a", new_string: "x" }, env)).isError, true);

        const done = await call(ts, "edit_file", { path: "f.ts", old_string: "const b = 1;", new_string: "const b = 42;" }, env);
        assert.equal(done.isError, undefined, done.content);
        assert.equal(await fs.readFile(path.join(root, "f.ts"), "utf8"), "const a = 1;\nconst b = 42;\nconst c = 2;\n");
        assert.equal(g.approvals.length, 1);
        assert.equal(ts.changes.length, 1);
        assert.equal(ts.changes[0].path, "f.ts");
        assert.equal(ts.changes[0].tool, "edit_file");
        assert.equal(
            ts.changes[0].patch,
            "--- a/f.ts\n+++ b/f.ts\n@@ -1,3 +1,3 @@\n const a = 1;\n-const b = 1;\n+const b = 42;\n const c = 2;\n",
        );
    } finally {
        await removeProject(root);
    }
});

test("edit_file accepts LF strings for a CRLF file and keeps CRLF", async () => {
    const root = await makeProject({ "w.txt": "one\r\ntwo\r\nthree\r\n" });
    try {
        const ts = createToolset();
        const r = await call(ts, "edit_file", { path: "w.txt", old_string: "one\ntwo", new_string: "one\n2" }, envFor(root));
        assert.equal(r.isError, undefined, r.content);
        assert.equal(await fs.readFile(path.join(root, "w.txt"), "utf8"), "one\r\n2\r\nthree\r\n");
    } finally {
        await removeProject(root);
    }
});

test("dry run describes write changes without writing or asking for approval", async () => {
    const root = await makeProject({ "f.txt": "alpha\nbeta\n" });
    try {
        const g = gate();
        const ts = createToolset();
        const env = envFor(root, g, true);
        const edit = await call(ts, "edit_file", { path: "f.txt", old_string: "beta", new_string: "gamma" }, env);
        assert.match(edit.content, /^dry run: would change f\.txt/);
        assert.match(edit.content, /\+gamma/);
        const write = await call(ts, "write_file", { path: "new/dir/n.txt", content: "x\ny\n" }, env);
        assert.match(write.content, /^dry run: would change new\/dir\/n\.txt: create new\/dir\/n\.txt \(2 lines\)/);

        assert.equal(await fs.readFile(path.join(root, "f.txt"), "utf8"), "alpha\nbeta\n");
        await assert.rejects(fs.stat(path.join(root, "new")));
        assert.equal(g.approvals.length, 0);
        assert.deepEqual(ts.changes.map((c) => c.path), ["f.txt", "new/dir/n.txt"]);
        assert.equal(ts.changes[1].patch, "--- /dev/null\n+++ b/new/dir/n.txt\n@@ -0,0 +1,2 @@\n+x\n+y\n");
    } finally {
        await removeProject(root);
    }
});

test("write_file creates and overwrites after approval, and honours a rejection", async () => {
    const root = await makeProject({ "old.txt": "1\n2\n" });
    try {
        const ts = createToolset();
        const created = await call(ts, "write_file", { path: "pkg/new.txt", content: "hi\n" }, envFor(root));
        assert.equal(created.isError, undefined, created.content);
        assert.equal(await fs.readFile(path.join(root, "pkg", "new.txt"), "utf8"), "hi\n");
        const over = await call(ts, "write_file", { path: "old.txt", content: "1\n3\n" }, envFor(root));
        assert.match(over.content, /overwrite old\.txt \(2 -> 2 lines\)/);
        assert.equal(ts.changes.length, 2);

        const rejected = await call(ts, "write_file", { path: "old.txt", content: "zzz" }, envFor(root, gate({ reject: "user said no" })));
        assert.equal(rejected.isError, true);
        assert.match(rejected.content, /not approved: user said no/);
        assert.equal(await fs.readFile(path.join(root, "old.txt"), "utf8"), "1\n3\n");
        assert.equal(ts.changes.length, 2);

        assert.equal((await call(ts, "write_file", { path: ".git/hooks/pre-commit", content: "x" }, envFor(root))).isError, true);
        assert.equal((await call(ts, "write_file", { path: ".tyr/tyr.json", content: "{}" }, envFor(root))).isError, true);
        assert.equal((await call(ts, "write_file", { path: "../escape.txt", content: "x" }, envFor(root))).isError, true);
    } finally {
        await removeProject(root);
    }
});

test("list_files and search respect .tyrignore and skip .tyr, without git", async () => {
    const root = await makeProject({
        "src/a.ts": "export const needle = 1;\n",
        "src/b.js": "// needle here too\n",
        "gen/out.ts": "needle\n",
        ".tyr/tyr.json": "{\"needle\":1}",
        "node_modules/x/index.js": "needle",
        ".tyrignore": "gen/\n",
    });
    try {
        const ts = createToolset();
        const env = envFor(root);
        const list = await call(ts, "list_files", {}, env);
        assert.deepEqual(list.content.split("\n"), [".tyrignore", "src/a.ts", "src/b.js"]);
        const tsOnly = await call(ts, "list_files", { path: "src", pattern: "*.ts" }, env);
        assert.equal(tsOnly.content, "src/a.ts");

        const found = await call(ts, "search", { pattern: "needle" }, env);
        assert.deepEqual(found.content.split("\n"), ["src/a.ts:1: export const needle = 1;", "src/b.js:1: // needle here too"]);
        const capped = await call(ts, "search", { pattern: "NEEDLE", case_insensitive: true, max_results: 1 }, env);
        assert.match(capped.content, /^src\/a\.ts:1:.*\n\[stopped at 1 matches/);
        const glob = await call(ts, "search", { pattern: "needle", glob: "*.js" }, env);
        assert.equal(glob.content, "src/b.js:1: // needle here too");
        assert.equal((await call(ts, "search", { pattern: "(" }, env)).isError, true);
        assert.equal((await call(ts, "list_files", { path: ".." }, env)).isError, true);
    } finally {
        await removeProject(root);
    }
});

test("list_files honours .gitignore in a repository; git_diff shows working-tree changes", async () => {
    const root = await makeProject({ "kept.txt": "one\n", ".gitignore": "ignored.log\n" });
    try {
        await runGit(root, ["init", "-q"]);
        await runGit(root, ["-c", "user.name=t", "-c", "user.email=t@t", "add", "."]);
        await runGit(root, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
        await fs.writeFile(path.join(root, "ignored.log"), "noise");
        await fs.writeFile(path.join(root, "fresh.txt"), "new");
        await fs.writeFile(path.join(root, "kept.txt"), "two\n");

        const ts = createToolset();
        const env = envFor(root);
        const list = await call(ts, "list_files", {}, env);
        assert.deepEqual(list.content.split("\n"), [".gitignore", "fresh.txt", "kept.txt"]);

        const diff = await call(ts, "git_diff", {}, env);
        assert.equal(diff.isError, undefined, diff.content);
        assert.match(diff.content, /-one\n\+two/);
        assert.match(diff.content, /untracked files:\nfresh\.txt/);
        const scoped = await call(ts, "git_diff", { path: "fresh.txt" }, env);
        assert.match(scoped.content, /no changes to tracked files/);
        assert.equal((await call(ts, "git_diff", { path: "../x" }, env)).isError, true);
    } finally {
        await removeProject(root);
    }
});

test("run_check runs only configured kinds through the executor", async () => {
    const root = await makeProject({});
    try {
        const ran: Array<[string, string]> = [];
        const fakeRun = async (cwd: string, kind: string, command: string): Promise<CheckRun> => {
            ran.push([kind, command]);
            return {
                id: "r1",
                kind: kind as CheckRun["kind"],
                command,
                cwd,
                trigger: { reason: "manual" },
                startedAt: "",
                finishedAt: "",
                durationMs: 12,
                outcome: "failed",
                exitCode: 1,
                signal: null,
                stdout: "1 test failed",
                stderr: "",
                outputTruncated: false,
                headCommit: null,
            } as CheckRun;
        };
        const g = gate();
        const ts = createToolset({ loadCommands: async () => ({ test: "npm test" }), runCheck: fakeRun });
        const env = envFor(root, g);
        const r = await call(ts, "run_check", { kind: "test" }, env);
        assert.match(r.content, /^test: failed \(exit 1\)/);
        assert.match(r.content, /1 test failed/);
        assert.deepEqual(ran, [["test", "npm test"]]);
        assert.deepEqual(g.checks.at(-1), ["run_check", "execute", undefined]);

        const missing = await call(ts, "run_check", { kind: "lint" }, env);
        assert.equal(missing.isError, true);
        assert.match(missing.content, /no lint check is configured \(configured: test\)/);
        assert.equal((await call(ts, "run_check", { kind: "rm -rf /" }, env)).isError, true);
        assert.equal((await call(ts, "run_check", { kind: "test", command: "evil" }, env)).content.includes("evil"), false);
        assert.equal(ran.length, 2);
    } finally {
        await removeProject(root);
    }
});

test("unifiedDiff groups distant changes into separate hunks", () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
    const after = before.replace("l2\n", "L2\n").replace("l18\n", "L18\n");
    const patch = unifiedDiff("x", before, after);
    const hunks = patch.split("\n").filter((l) => l.startsWith("@@"));
    assert.deepEqual(hunks, ["@@ -1,5 +1,5 @@", "@@ -15,6 +15,6 @@"]);
    assert.equal(unifiedDiff("x", "same\n", "same\n"), "");
});
