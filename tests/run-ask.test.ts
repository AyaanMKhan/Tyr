// ask.ts: the "ask" route of tyr run, against a temp repo and a fake
// streaming client — request shape, streamed text, skips and errors.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import { ASK_SYSTEM_PROMPT, askRepository, buildAskRequest, type AskMessagesClient } from "../cli/engine/ask.js";
import { makeProject, removeProject } from "./helpers.js";

const CLI = fileURLToPath(new URL("../cli/index.js", import.meta.url));
const KEY = "sk-ant-test-0123456789abcdef";
const SETTINGS = { ai: { model: "claude-opus-5-5", apiKey: KEY } };

function git(root: string, ...args: string[]): string {
    return execFileSync("git", ["-c", "user.name=Tyr", "-c", "user.email=tyr@example.com", "-c", "commit.gpgsign=false", ...args], {
        cwd: root,
        encoding: "utf8",
    }).trim();
}

async function makeRepo(): Promise<{ root: string; env: NodeJS.ProcessEnv; cleanup: () => Promise<void> }> {
    const root = await makeProject({
        "package.json": JSON.stringify({ name: "ask-fixture", scripts: { test: "node --test" } }),
        "src/index.ts": "export const a = 1;\n",
        "README.md": "# fixture\n\nUse tabs.\n",
    });
    const configHome = await fs.mkdtemp(path.join(os.tmpdir(), "tyr-ask-home-"));
    const env = { ...process.env, TYR_CONFIG_HOME: configHome, NO_COLOR: "1" };
    git(root, "init", "-q");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "initial commit");
    const result = spawnSync(process.execPath, [CLI, "init", "--no-verify", "--no-gitignore", "--no-color"], { cwd: root, encoding: "utf8", env });
    assert.equal(result.status, 0, `tyr init failed:\n${result.stdout}\n${result.stderr}`);
    return {
        root,
        env,
        cleanup: async () => {
            await removeProject(root);
            await fs.rm(configHome, { recursive: true, force: true });
        },
    };
}

function message(stopReason: Anthropic.Message["stop_reason"], text: string): Anthropic.Message {
    return {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [{ type: "text", text, citations: null }],
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 },
    } as unknown as Anthropic.Message;
}

/** A client that streams `chunks` and records the request. */
function fakeClient(chunks: string[], stopReason: Anthropic.Message["stop_reason"] = "end_turn") {
    const calls: Anthropic.MessageStreamParams[] = [];
    const client: AskMessagesClient = {
        stream(body) {
            calls.push(body);
            const events = chunks.map(
                (text) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }) as unknown as Anthropic.MessageStreamEvent,
            );
            return {
                async *[Symbol.asyncIterator]() {
                    yield* events;
                },
                finalMessage: async () => message(stopReason, chunks.join("")),
            };
        },
    };
    return { client, calls };
}

test("askRepository streams the answer and returns it", async () => {
    const { root, cleanup } = await makeRepo();
    try {
        const { client, calls } = fakeClient(["The build ", "passes."]);
        const streamed: string[] = [];
        let requested: { model: string; contextBytes: number } | null = null;
        const result = await askRepository(root, "is the build ok?", {
            settings: SETTINGS,
            client,
            onText: (t) => streamed.push(t),
            onRequest: (info) => (requested = info),
        });
        assert.equal(result.status, "ok");
        assert.equal(result.answer, "The build passes.");
        assert.deepEqual(streamed, ["The build ", "passes."]);
        assert.equal(result.model, "claude-opus-5-5");
        assert.equal(result.usage?.inputTokens, 150);
        assert.equal(calls.length, 1);
        assert.ok(requested !== null && (requested as { contextBytes: number }).contextBytes > 0);
    } finally {
        await cleanup();
    }
});

test("buildAskRequest puts stable docs in the cached system prompt and live state in the user turn", async () => {
    const { root, cleanup } = await makeRepo();
    try {
        await fs.writeFile(path.join(root, "src", "index.ts"), "export const a = 2;\n");
        await fs.writeFile(path.join(root, "notes.txt"), "draft\n");
        const body = await buildAskRequest(root, "what changed?", { model: "claude-opus-5-5" });
        assert.equal(body.model, "claude-opus-5-5");
        assert.deepEqual(body.output_config, { effort: "medium" });
        assert.ok(Array.isArray(body.system));
        const system = body.system as Anthropic.TextBlockParam[];
        assert.equal(system[0]!.text, ASK_SYSTEM_PROMPT);
        assert.deepEqual(system[1]!.cache_control, { type: "ephemeral" });
        assert.match(system[1]!.text, /<project_profile>/);
        assert.match(system[1]!.text, /<readme path="README.md">[\s\S]*Use tabs\./);

        const user = body.messages[0]!.content as string;
        assert.match(user, /<tyr_status>[\s\S]*background process: not running/);
        assert.match(user, /checks: none have run yet/);
        assert.match(user, /<recent_commits>[\s\S]*initial commit/);
        assert.match(user, /<uncommitted_changes>[\s\S]*-export const a = 1;[\s\S]*\+export const a = 2;/);
        assert.match(user, /untracked files: notes\.txt/);
        assert.ok(user.endsWith("<question>\nwhat changed?\n</question>"));
    } finally {
        await cleanup();
    }
});

test("buildAskRequest works outside an initialized project", async () => {
    const root = await makeProject({ "a.txt": "hi\n" });
    try {
        const body = await buildAskRequest(root, "hello?", { model: "some-older-model", config: null });
        assert.equal(body.output_config, undefined);
        const system = body.system as Anthropic.TextBlockParam[];
        assert.match(system[1]!.text, /no profile or documentation/);
        assert.ok((body.messages[0]!.content as string).includes("<question>\nhello?\n</question>"));
    } finally {
        await removeProject(root);
    }
});

test("askRepository skips without an API key", async () => {
    const root = await makeProject({ "a.txt": "hi\n" });
    try {
        const { client, calls } = fakeClient(["x"]);
        const result = await askRepository(root, "q", { settings: { ai: { model: "claude-opus-5-5", apiKey: null } }, client });
        assert.equal(result.status, "skipped");
        assert.match(result.reason ?? "", /no API key/);
        assert.equal(calls.length, 0);
    } finally {
        await removeProject(root);
    }
});

test("askRepository reports refusals and truncation as errors, keeping partial text", async () => {
    const root = await makeProject({ "a.txt": "hi\n" });
    try {
        const refused = await askRepository(root, "q", { settings: SETTINGS, config: null, client: fakeClient(["no"], "refusal").client });
        assert.equal(refused.status, "error");
        assert.match(refused.reason ?? "", /declined/);
        const cut = await askRepository(root, "q", { settings: SETTINGS, config: null, client: fakeClient(["part"], "max_tokens").client });
        assert.equal(cut.status, "error");
        assert.equal(cut.answer, "part");
        assert.match(cut.reason ?? "", /max_tokens/);
    } finally {
        await removeProject(root);
    }
});

test("askRepository never leaks the key in an error", async () => {
    const root = await makeProject({ "a.txt": "hi\n" });
    try {
        const client: AskMessagesClient = {
            stream() {
                throw new Error(`boom with ${KEY}`);
            },
        };
        const result = await askRepository(root, "q", { settings: SETTINGS, config: null, client });
        assert.equal(result.status, "error");
        assert.ok(!(result.reason ?? "").includes(KEY), result.reason ?? "");
    } finally {
        await removeProject(root);
    }
});
