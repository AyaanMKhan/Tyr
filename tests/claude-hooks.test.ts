// Claude Code observation: hook payload normalization and settings editing
// (cli/core/claude-hooks.ts), the `tyr hook` / `tyr hooks` commands
// (cli/commands/hooks.ts), and transcript discovery
// (cli/core/claude-transcripts.ts).
//
// Settings files are always written inside temp projects and the transcript
// tests use a temp "home", so neither the real ~/.claude nor this repo's
// .claude/ is ever touched. Spawned CLIs get CLAUDE_PROJECT_DIR scrubbed: the
// suite may itself run inside Claude Code, and `tyr hook` falls back to that
// directory.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
    MAX_FIELD_CHARS,
    PROMPT_PREVIEW_CHARS,
    TYR_HOOK_EVENTS,
    TYR_HOOK_MARKER,
    claudeSettingsFile,
    defaultHookCommand,
    hooksStatus,
    installHooks,
    normalizeHookPayload,
    redactSecrets,
    truncate,
    uninstallHooks,
} from "../cli/core/claude-hooks.js";
import { readHookStdin, recordHookPayload } from "../cli/commands/hooks.js";
import { encodeProjectPath, findSessionTranscripts, readTranscriptSummary } from "../cli/core/claude-transcripts.js";
import { EXIT_CODES, TyrError } from "../cli/core/errors.js";
import { readEvents } from "../cli/core/events.js";
import { makeProject, removeProject } from "./helpers.js";
import { PassThrough } from "node:stream";

const ROOT = "/work/app";
const COMMON = {
    session_id: "abc123",
    transcript_path: "/Users/me/.claude/projects/-work-app/abc123.jsonl",
    cwd: ROOT,
    permission_mode: "default",
};

/* -------------------------------------------------------------------------
 * Normalization
 * ---------------------------------------------------------------------- */

test("PreToolUse: Edit becomes claude.tool_use with a project-relative path and no contents", () => {
    const event = normalizeHookPayload({
        ...COMMON,
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: { file_path: `${ROOT}/src/a.ts`, old_string: "SECRET BODY", new_string: "other body" },
        tool_use_id: "toolu_01",
    });
    assert.deepEqual(event, {
        source: "claude",
        kind: "claude.tool_use",
        message: "Edit src/a.ts",
        data: {
            sessionId: "abc123",
            hookEvent: "PreToolUse",
            transcriptPath: COMMON.transcript_path,
            cwd: ROOT,
            tool: "Edit",
            toolUseId: "toolu_01",
            input: "src/a.ts",
            file: "src/a.ts",
        },
    });
    assert.doesNotMatch(JSON.stringify(event), /BODY/);
});

test("PreToolUse summaries: Bash command, Read outside the project, Grep, Write, MCP tool", () => {
    const tool = (tool_name: string, tool_input: unknown) =>
        normalizeHookPayload({ ...COMMON, hook_event_name: "PreToolUse", tool_name, tool_input })!;

    const bash = tool("Bash", { command: "npm test\n  -- --watch=false", description: "Run tests", timeout: 120000 });
    assert.equal(bash.message, "Bash: npm test -- --watch=false");
    assert.equal(bash.data!.input, "npm test -- --watch=false");

    assert.equal(tool("Read", { file_path: "/etc/hosts" }).message, "Read /etc/hosts");
    const write = tool("Write", { file_path: `${ROOT}/README.md`, content: "x".repeat(10_000) });
    assert.equal(write.message, "Write README.md");
    assert.ok(JSON.stringify(write).length < 1000);

    assert.equal(tool("Grep", { pattern: "TODO", path: `${ROOT}/cli`, glob: "*.ts" }).message, "Grep: TODO (*.ts) in cli");
    assert.equal(tool("Agent", { subagent_type: "Explore", description: "Find tests", prompt: "long..." }).data!.input, "Explore: Find tests");
    // Unknown tools: argument names only, never values.
    const mcp = tool("mcp__db__query", { sql: "select * from users", limit: 5 });
    assert.equal(mcp.data!.input, "{sql, limit}");
    assert.equal(tool("Bash", "not an object").message, "Bash");
});

test("PostToolUse and PostToolUseFailure become claude.tool_result with success", () => {
    const ok = normalizeHookPayload({
        ...COMMON,
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: { file_path: `${ROOT}/src/b.ts`, content: "file content" },
        tool_response: { filePath: `${ROOT}/src/b.ts`, type: "create" },
        tool_use_id: "toolu_02",
        duration_ms: 12,
    })!;
    assert.equal(ok.kind, "claude.tool_result");
    assert.equal(ok.message, "Write src/b.ts (ok)");
    assert.equal(ok.data!.success, true);
    assert.equal(ok.data!.durationMs, 12);
    assert.doesNotMatch(JSON.stringify(ok), /file content/);

    const failed = normalizeHookPayload({
        ...COMMON,
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        tool_input: { command: "npm test", description: "Run test suite" },
        tool_use_id: "toolu_03",
        error: "Exit code 1\nError: Cannot find module 'express'\n    at a\n    at b\n    at c",
        is_interrupt: false,
        duration_ms: 4187,
    })!;
    assert.equal(failed.kind, "claude.tool_result");
    assert.equal(failed.message, "Bash: npm test (failed)");
    assert.equal(failed.data!.success, false);
    assert.equal(failed.data!.error, "Exit code 1 Error: Cannot find module 'express'");

    const interrupted = normalizeHookPayload({
        ...COMMON,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "sleep 100" },
        tool_response: { stdout: "", stderr: "", interrupted: true },
    })!;
    assert.equal(interrupted.data!.success, false);
});

test("UserPromptSubmit keeps only a short, redacted preview and the length", () => {
    const prompt = `Deploy with key sk-ant-api03-ABCDEFGHIJKLMNOP and then ${"keep going ".repeat(50)}`;
    const event = normalizeHookPayload({ ...COMMON, hook_event_name: "UserPromptSubmit", prompt })!;
    assert.equal(event.kind, "claude.prompt");
    const preview = event.data!.prompt as string;
    assert.ok(preview.length <= PROMPT_PREVIEW_CHARS, preview);
    assert.match(preview, /^Deploy with key \[redacted\] and then/);
    assert.doesNotMatch(JSON.stringify(event), /ABCDEFGHIJKLMNOP/);
    assert.equal(event.data!.promptLength, prompt.length);
    assert.match(event.message!, /^Prompt: "Deploy with key \[redacted\]/);
});

test("session, stop, subagent, notification, compact and unknown hooks", () => {
    const n = (payload: Record<string, unknown>) => normalizeHookPayload({ ...COMMON, ...payload })!;

    const start = n({ hook_event_name: "SessionStart", source: "startup", model: "claude-opus-5-5" });
    assert.equal(start.kind, "claude.session_start");
    assert.equal(start.message, "Session started (startup)");
    assert.equal(start.data!.model, "claude-opus-5-5");

    const end = n({ hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
    assert.equal(end.kind, "claude.session_end");
    assert.equal(end.message, "Session ended (prompt_input_exit)");

    const stop = n({ hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "Done.\nAll tests pass." });
    assert.equal(stop.kind, "claude.stop");
    assert.equal(stop.data!.lastMessage, "Done. All tests pass.");
    assert.equal(stop.data!.stopHookActive, false);

    const sub = n({ hook_event_name: "SubagentStop", stop_hook_active: false, agent_id: "def456", agent_type: "Explore" });
    assert.equal(sub.kind, "claude.subagent_stop");
    assert.equal(sub.message, "Subagent finished (Explore)");
    assert.equal(sub.data!.agentId, "def456");

    const note = n({
        hook_event_name: "Notification",
        message: "Claude needs your permission to use Bash",
        title: "Permission needed",
        notification_type: "permission_prompt",
    });
    assert.equal(note.kind, "claude.notification");
    assert.equal(note.message, "Notification: Claude needs your permission to use Bash");
    assert.equal(note.data!.notificationType, "permission_prompt");

    const compact = n({ hook_event_name: "PreCompact", trigger: "manual", custom_instructions: "keep the API notes" });
    assert.equal(compact.kind, "claude.compact");
    assert.equal(compact.data!.trigger, "manual");
    assert.equal(compact.data!.customInstructions, true);
    assert.doesNotMatch(JSON.stringify(compact), /API notes/);

    const other = n({ hook_event_name: "SubagentStart", agent_id: "x", agent_type: "Plan" });
    assert.equal(other.kind, "claude.hook");
    assert.equal(other.message, "SubagentStart hook");
    assert.equal(other.data!.hookEvent, "SubagentStart");

    const bare = normalizeHookPayload({})!;
    assert.equal(bare.kind, "claude.hook");
    assert.deepEqual(bare.data, { sessionId: null, hookEvent: "unknown", transcriptPath: null });

    for (const garbage of [null, 42, "text", [1, 2]]) assert.equal(normalizeHookPayload(garbage), null);
});

test("long fields are truncated and secrets redacted", () => {
    const event = normalizeHookPayload({
        ...COMMON,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: `curl -H "Authorization: Bearer abc.def.ghi" https://x.test/${"a".repeat(1000)}` },
    })!;
    const input = event.data!.input as string;
    assert.equal(input.length, MAX_FIELD_CHARS);
    assert.ok(input.endsWith("…"));
    assert.doesNotMatch(input, /abc\.def\.ghi/);
    assert.ok(event.message!.length <= 200);

    assert.equal(truncate("short"), "short");
    assert.equal(redactSecrets("PASSWORD=hunter2 ok"), "PASSWORD=[redacted] ok");
    assert.equal(redactSecrets("token: ghp_abcdefghijklmnop1234"), "token: [redacted]");
    assert.equal(redactSecrets("nothing to see"), "nothing to see");
});

/* -------------------------------------------------------------------------
 * Settings editing
 * ---------------------------------------------------------------------- */

const USER_SETTINGS = {
    permissions: { allow: ["Bash(npm test)"] },
    hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./scripts/guard.sh" }] }],
        Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
    },
    model: "opus",
};

async function withSettings(fn: (root: string, file: string) => Promise<void>, initial?: unknown): Promise<void> {
    const files: Record<string, string> = {};
    if (initial !== undefined) files[".claude/settings.local.json"] = typeof initial === "string" ? initial : JSON.stringify(initial);
    const root = await makeProject(files);
    try {
        await fn(root, claudeSettingsFile(root, "local"));
    } finally {
        await removeProject(root);
    }
}

async function readJson(file: string): Promise<any> {
    return JSON.parse(await fs.readFile(file, "utf8"));
}

test("install merges into existing settings without touching the user's hooks", async () => {
    await withSettings(async (_root, file) => {
        const edit = await installHooks(file, "tyr hook");
        assert.equal(edit.changed, true);
        assert.deepEqual(edit.events, [...TYR_HOOK_EVENTS]);
        assert.equal(edit.command, `tyr hook ${TYR_HOOK_MARKER}`);

        const settings = await readJson(file);
        assert.deepEqual(settings.permissions, USER_SETTINGS.permissions);
        assert.equal(settings.model, "opus");
        const ours = { type: "command", command: `tyr hook ${TYR_HOOK_MARKER}`, timeout: 10 };
        assert.deepEqual(settings.hooks.PreToolUse, [
            USER_SETTINGS.hooks.PreToolUse[0],
            { matcher: "*", hooks: [ours] },
        ]);
        assert.deepEqual(settings.hooks.Stop, [USER_SETTINGS.hooks.Stop[0], { hooks: [ours] }]);
        assert.deepEqual(settings.hooks.UserPromptSubmit, [{ hooks: [ours] }]);
        assert.deepEqual(Object.keys(settings.hooks).sort(), [...TYR_HOOK_EVENTS].sort());

        const status = await hooksStatus(file);
        assert.equal(status.exists, true);
        assert.deepEqual(status.missing, []);
        assert.deepEqual(status.commands, [`tyr hook ${TYR_HOOK_MARKER}`]);
    }, USER_SETTINGS);
});

test("re-install is idempotent; a new command replaces Tyr's entries instead of adding more", async () => {
    await withSettings(async (_root, file) => {
        await installHooks(file, "tyr hook");
        const before = await fs.readFile(file, "utf8");
        const again = await installHooks(file, "tyr hook");
        assert.equal(again.changed, false);
        assert.deepEqual(again.events, []);
        assert.equal(await fs.readFile(file, "utf8"), before);

        const replaced = await installHooks(file, 'node "/opt/my tyr/index.js" hook');
        assert.equal(replaced.changed, true);
        const settings = await readJson(file);
        assert.equal(settings.hooks.PreToolUse.length, 2);
        assert.equal(settings.hooks.PreToolUse[1].hooks[0].command, `node "/opt/my tyr/index.js" hook ${TYR_HOOK_MARKER}`);
        assert.deepEqual((await hooksStatus(file)).commands.length, 1);
    }, USER_SETTINGS);
});

test("uninstall removes only Tyr's entries; an untouched file is not rewritten", async () => {
    await withSettings(async (_root, file) => {
        // Tyr's handler sharing a group with a user handler.
        const shared = structuredClone(USER_SETTINGS) as any;
        shared.hooks.PostToolUse = [
            { matcher: "*", hooks: [{ type: "command", command: "./log.sh" }, { type: "command", command: `x ${TYR_HOOK_MARKER}` }] },
        ];
        await fs.writeFile(file, JSON.stringify(shared));
        await installHooks(file, "tyr hook");

        const edit = await uninstallHooks(file);
        assert.equal(edit.changed, true);
        assert.deepEqual(await readJson(file), {
            ...USER_SETTINGS,
            hooks: {
                ...USER_SETTINGS.hooks,
                PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "./log.sh" }] }],
            },
        });

        const before = await fs.readFile(file, "utf8");
        assert.equal((await uninstallHooks(file)).changed, false);
        assert.equal(await fs.readFile(file, "utf8"), before);
        assert.deepEqual((await hooksStatus(file)).installed, []);
    }, USER_SETTINGS);
});

test("install creates the file; uninstall removes a file left empty; missing files are fine", async () => {
    await withSettings(async (root, file) => {
        assert.deepEqual(await uninstallHooks(file), { file, changed: false, events: [] });
        assert.equal((await hooksStatus(file)).exists, false);
        await installHooks(file, defaultHookCommand("/opt/tyr/dist/cli/index.js"));
        assert.equal((await readJson(file)).hooks.Stop[0].hooks[0].command, `node /opt/tyr/dist/cli/index.js hook ${TYR_HOOK_MARKER}`);
        await uninstallHooks(file);
        await assert.rejects(fs.stat(file), /ENOENT/);
        assert.ok((await fs.stat(path.join(root, ".claude"))).isDirectory());
    });
});

test("malformed settings are refused with CONFIG and left untouched", async () => {
    for (const bad of ["{ not json", "[]", '{"hooks": []}', '{"hooks": {"Stop": {}}}']) {
        await withSettings(async (_root, file) => {
            for (const action of [() => installHooks(file, "tyr hook"), () => uninstallHooks(file)]) {
                await assert.rejects(action(), (error: unknown) => {
                    assert.ok(error instanceof TyrError);
                    assert.equal(error.exitCode, EXIT_CODES.CONFIG);
                    return true;
                });
            }
            assert.equal(await fs.readFile(file, "utf8"), bad);
            const status = await hooksStatus(file);
            assert.ok(status.error !== undefined);
        }, bad);
    }
});

test("defaultHookCommand quotes paths with spaces and shell characters", () => {
    assert.equal(defaultHookCommand("/a/b/index.js"), "node /a/b/index.js hook");
    assert.equal(defaultHookCommand('/a b/$x"y/index.js'), 'node "/a b/\\$x\\"y/index.js" hook');
});

/* -------------------------------------------------------------------------
 * Recording (core of `tyr hook`)
 * ---------------------------------------------------------------------- */

test("recordHookPayload appends to the initialized project and falls back to CLAUDE_PROJECT_DIR", async () => {
    const root = await makeProject({ "package.json": "{}", ".tyr/tyr.json": "{}" });
    const other = await makeProject({ "package.json": "{}" });
    try {
        const payload = (cwd: string) =>
            JSON.stringify({ ...COMMON, cwd, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: path.join(root, "x.ts") } });

        const direct = await recordHookPayload(payload(root), { env: {} });
        assert.equal(direct.recorded, true);
        assert.equal(direct.root, root);

        // cwd in an uninitialized directory (a worktree, say): CLAUDE_PROJECT_DIR wins.
        const viaEnv = await recordHookPayload(payload(other), { env: { CLAUDE_PROJECT_DIR: root } });
        assert.equal(viaEnv.root, root);
        const none = await recordHookPayload(payload(other), { env: {} });
        assert.deepEqual(none, { recorded: false, root: null, reason: "not-initialized" });
        assert.equal((await recordHookPayload("not json", { env: {} })).reason, "unparseable");

        const events = await readEvents(root, { sources: ["claude"] });
        assert.deepEqual(events.map((e) => e.message), ["Read x.ts", "Read x.ts"]);
        await assert.rejects(fs.stat(path.join(other, ".tyr")), /ENOENT/);
    } finally {
        await removeProject(root);
        await removeProject(other);
    }
});

test("readHookStdin: reads to end, gives up on TTYs, timeouts and oversized payloads", async () => {
    const input = new PassThrough();
    const reading = readHookStdin(input, 1000);
    input.end('{"a":1}');
    assert.equal(await reading, '{"a":1}');

    assert.equal(await readHookStdin(Object.assign(new PassThrough(), { isTTY: true })), null);
    assert.equal(await readHookStdin(new PassThrough(), 20), null);

    const big = new PassThrough();
    const reading2 = readHookStdin(big, 1000, 4);
    big.end("0123456789");
    assert.equal(await reading2, null);
});

/* -------------------------------------------------------------------------
 * The compiled CLI
 * ---------------------------------------------------------------------- */

// Compiled to .test-build/tests/; the CLI is compiled beside it.
const CLI = fileURLToPath(new URL("../cli/index.js", import.meta.url));

function cleanEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(process.env)) {
        if (name.startsWith("TYR_") || name === "CLAUDE_PROJECT_DIR") continue;
        env[name] = value;
    }
    return env;
}

function tyr(cwd: string, args: string[], input = "") {
    const started = Date.now();
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd, input, encoding: "utf8", env: cleanEnv(), timeout: 20_000 });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, ms: Date.now() - started };
}

test("tyr hook records a payload from stdin, silently, exiting 0", async () => {
    const root = await makeProject({ "package.json": "{}", ".tyr/tyr.json": "{}" });
    try {
        const payload = JSON.stringify({
            ...COMMON,
            cwd: path.join(root, "src"),
            hook_event_name: "PostToolUse",
            tool_name: "Bash",
            tool_input: { command: "npm test" },
            tool_response: { stdout: "all good", stderr: "" },
        });
        assert.deepEqual(tyr(root, ["hook"], payload).status, 0);
        const run = tyr(root, ["hook"], payload);
        assert.deepEqual([run.status, run.stdout, run.stderr], [0, "", ""]);

        const events = await readEvents(root);
        assert.equal(events.length, 2);
        assert.equal(events[0]!.kind, "claude.tool_result");
        assert.equal(events[0]!.message, "Bash: npm test (ok)");
        assert.equal(events[0]!.data!.sessionId, "abc123");
        assert.doesNotMatch(JSON.stringify(events), /all good/);

        // Garbage, empty input and unknown flags: still 0, still silent.
        for (const [args, input] of [[["hook"], "garbage{"], [["hook"], ""], [["hook", "--bogus", "extra"], "[]"]] as const) {
            const result = tyr(root, [...args], input);
            assert.deepEqual([result.status, result.stdout, result.stderr], [0, "", ""], `${args.join(" ")} <<< ${input}`);
        }
        assert.equal((await readEvents(root)).length, 2);
    } finally {
        await removeProject(root);
    }
});

test("tyr hook in an uninitialized project exits 0 and creates nothing", async () => {
    const root = await makeProject({ "package.json": "{}" });
    try {
        const result = tyr(root, ["hook"], JSON.stringify({ ...COMMON, cwd: root, hook_event_name: "Stop" }));
        assert.deepEqual([result.status, result.stdout, result.stderr], [0, "", ""]);
        await assert.rejects(fs.stat(path.join(root, ".tyr")), /ENOENT/);
    } finally {
        await removeProject(root);
    }
});

test("tyr hooks install / status / uninstall round-trip, with --json", async () => {
    const root = await makeProject({ "package.json": "{}", ".tyr/tyr.json": "{}" });
    try {
        const install = tyr(root, ["hooks", "install", "--command", "tyr hook", "--json"]);
        assert.equal(install.status, 0, install.stderr);
        const installed = JSON.parse(install.stdout);
        assert.equal(installed.ok, true);
        assert.equal(installed.changed, true);
        assert.equal(installed.file, path.join(root, ".claude", "settings.local.json"));
        assert.equal(installed.command, `tyr hook ${TYR_HOOK_MARKER}`);

        const shared = tyr(root, ["hooks", "install", "--shared", "--json"]);
        const sharedJson = JSON.parse(shared.stdout);
        assert.equal(sharedJson.file, path.join(root, ".claude", "settings.json"));
        assert.ok(sharedJson.command.includes(CLI));
        assert.equal(sharedJson.warnings.length, 2); // machine-specific path, installed twice

        const status = JSON.parse(tyr(root, ["hooks", "status", "--json"]).stdout);
        assert.equal(status.installed, true);
        assert.equal(status.initialized, true);
        assert.deepEqual(status.files.map((f: any) => f.missing.length), [0, 0]);

        const removed = tyr(root, ["hooks", "uninstall", "--shared"]);
        assert.equal(removed.status, 0);
        assert.match(removed.stdout, /Removed Tyr's hooks from \.claude\/settings\.json/);
        assert.equal((await hooksStatus(claudeSettingsFile(root, "local"))).missing.length, 0);

        const quiet = tyr(root, ["hooks", "uninstall", "--quiet"]);
        assert.deepEqual([quiet.status, quiet.stdout], [0, ""]);

        await fs.writeFile(claudeSettingsFile(root, "local"), "{ broken");
        const broken = tyr(root, ["hooks", "install"]);
        assert.equal(broken.status, EXIT_CODES.CONFIG);
        assert.match(broken.stderr, /not valid JSON/);
    } finally {
        await removeProject(root);
    }
});

test("the hook command is hidden from help", () => {
    const help = tyr(process.cwd(), ["--help"]).stdout;
    assert.match(help, /\bhooks\b/);
    assert.doesNotMatch(help, /^\s+hook\s/m);
});

/* -------------------------------------------------------------------------
 * Transcripts
 * ---------------------------------------------------------------------- */

test("encodeProjectPath replaces every non-alphanumeric character with '-'", () => {
    assert.equal(encodeProjectPath("/Users/me/Tyr"), "-Users-me-Tyr");
    assert.equal(encodeProjectPath("/Users/me/Unreal/My_Game"), "-Users-me-Unreal-My-Game");
    assert.equal(encodeProjectPath("/repo/.claude/worktrees/x"), "-repo--claude-worktrees-x");
});

test("findSessionTranscripts and readTranscriptSummary read a fake ~/.claude tolerantly", async () => {
    const home = await makeProject({});
    try {
        const projectRoot = "/work/my_app";
        const dir = path.join(home, ".claude", "projects", "-work-my-app");
        await fs.mkdir(dir, { recursive: true });
        const lines = [
            { type: "mode", mode: "normal", sessionId: "s-1" },
            { type: "user", sessionId: "s-1", timestamp: "2026-11-10T10:00:00.000Z", message: { role: "user", content: "fix the tests" } },
            {
                type: "assistant",
                sessionId: "s-1",
                timestamp: "2026-11-10T10:00:05.000Z",
                message: { content: [{ type: "text", text: "ok" }, { type: "tool_use", name: "Bash" }, { type: "tool_use", name: "Edit" }] },
            },
            { type: "user", sessionId: "s-1", timestamp: "2026-11-10T10:00:06.000Z", message: { content: [{ type: "tool_result", content: "x" }] } },
            { type: "assistant", sessionId: "s-1", timestamp: "2026-11-10T10:03:00.000Z", message: { content: [{ type: "tool_use", name: "Bash" }] } },
        ].map((line) => JSON.stringify(line));
        lines.splice(2, 0, "{ half a line");
        await fs.writeFile(path.join(dir, "s-1.jsonl"), `${lines.join("\n")}\n`);
        await fs.writeFile(path.join(dir, "notes.txt"), "ignored");

        const files = await findSessionTranscripts(projectRoot, { home });
        assert.deepEqual(files.map((f) => f.sessionId), ["s-1"]);
        assert.deepEqual(await findSessionTranscripts("/elsewhere", { home }), []);

        const summary = await readTranscriptSummary(files[0]!.file);
        assert.deepEqual(summary, {
            file: files[0]!.file,
            sessionId: "s-1",
            startedAt: "2026-11-10T10:00:00.000Z",
            endedAt: "2026-11-10T10:03:00.000Z",
            prompts: 1,
            toolUses: { Bash: 2, Edit: 1 },
            totalToolUses: 3,
            skippedLines: 1,
        });
        assert.equal(await readTranscriptSummary(path.join(dir, "missing.jsonl")), null);
    } finally {
        await removeProject(home);
    }
});
