// LLM diff review (cli/engine/llm-review.ts). Every test injects a fake
// client, so nothing touches the network.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";

import type { DiffResult } from "../cli/core/git-diff.js";
import type { ReviewContext } from "../cli/engine/findings.js";
import { reviewDiffWithLlm, trimPatch, type LlmMessagesClient, type LlmReviewOptions } from "../cli/engine/llm-review.js";
import { makeProject, removeProject } from "./helpers.js";

const KEY = "sk-ant-test-SECRET-1234567890";
const MODEL = "claude-opus-5-5";

function filePatch(file: string, added: string[], start = 1): string {
    return [
        `diff --git a/${file} b/${file}`,
        `index 1111111..2222222 100644`,
        `--- a/${file}`,
        `+++ b/${file}`,
        `@@ -${start},0 +${start},${added.length} @@`,
        ...added.map((l) => `+${l}`),
    ].join("\n");
}

function makeDiff(files: Record<string, string[]>, extra: Partial<DiffResult> = {}): DiffResult {
    const entries = Object.entries(files);
    const stats = entries.map(([path, lines]) => ({
        path,
        status: "M" as const,
        additions: lines.length,
        deletions: 0,
        binary: false,
    }));
    return {
        files: stats,
        totals: { files: stats.length, additions: stats.reduce((n, s) => n + s.additions, 0), deletions: 0 },
        untracked: null,
        patch: entries.map(([p, l]) => filePatch(p, l)).join("\n") + "\n",
        truncated: false,
        ...extra,
    };
}

function message(text: string, extra: Partial<Anthropic.Message> = {}): Anthropic.Message {
    return {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: MODEL,
        content: [{ type: "text", text, citations: null }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 },
        ...extra,
    } as unknown as Anthropic.Message;
}

class FakeClient implements LlmMessagesClient {
    calls: Array<{ body: Anthropic.MessageCreateParamsNonStreaming; options?: { signal?: AbortSignal; timeout?: number } }> = [];
    constructor(private readonly respond: () => Promise<Anthropic.Message>) {}
    create(body: Anthropic.MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal; timeout?: number }) {
        this.calls.push({ body, options });
        return this.respond();
    }
}

function replying(payload: unknown): FakeClient {
    return new FakeClient(async () => message(JSON.stringify(payload)));
}

async function withRepo(files: Record<string, string>, fn: (root: string) => Promise<void>): Promise<void> {
    const root = await makeProject(files);
    try {
        await fn(root);
    } finally {
        await removeProject(root);
    }
}

function ctx(root: string, diff: DiffResult): ReviewContext {
    return { root, diff, base: "HEAD" };
}

function opts(client: LlmMessagesClient, extra: LlmReviewOptions = {}): LlmReviewOptions {
    return { settings: { ai: { model: MODEL, apiKey: KEY } }, config: null, client, timeoutMs: 5_000, ...extra };
}

function systemBlocks(body: Anthropic.MessageCreateParamsNonStreaming): Anthropic.TextBlockParam[] {
    assert.ok(Array.isArray(body.system));
    return body.system as Anthropic.TextBlockParam[];
}

function userText(body: Anthropic.MessageCreateParamsNonStreaming): string {
    const content = body.messages[0].content;
    assert.equal(typeof content, "string");
    return content as string;
}

test("request shape: model, conventions cached in system, diff and nested CLAUDE.md in the user turn", async () => {
    await withRepo(
        {
            "CLAUDE.md": "Always use node:test. ROOT-CONVENTION",
            "README.md": "# Demo\nREADME-MARKER",
            "src/CLAUDE.md": "No default exports in src. NESTED-CONVENTION",
            "other/CLAUDE.md": "UNRELATED-NESTED",
        },
        async (root) => {
            const client = replying({ findings: [] });
            const result = await reviewDiffWithLlm(ctx(root, makeDiff({ "src/a.ts": ["export default 1;"] })), opts(client));
            assert.equal(result.status, "ok");
            assert.equal(client.calls.length, 1);
            const { body, options } = client.calls[0];

            assert.equal(body.model, MODEL);
            assert.ok(body.max_tokens > 0);
            const system = systemBlocks(body);
            assert.equal(system.length, 2);
            assert.equal(system[0].cache_control, undefined, "instructions block carries no breakpoint");
            assert.match(system[0].text, /style nits/);
            assert.match(system[0].text, /at most|new side/);
            assert.deepEqual(system[1].cache_control, { type: "ephemeral" }, "breakpoint at the end of the stable prefix");
            assert.match(system[1].text, /ROOT-CONVENTION/);
            assert.match(system[1].text, /README-MARKER/);
            assert.ok(!("cache_control" in body.messages[0]));

            const user = userText(body);
            assert.match(user, /NESTED-CONVENTION/);
            assert.doesNotMatch(user, /UNRELATED-NESTED/);
            assert.match(user, /\+export default 1;/);
            assert.match(user, /at most 15 findings/);
            assert.doesNotMatch(system[1].text, /export default 1/, "volatile diff stays out of the cached prefix");

            assert.equal(body.output_config?.format?.type, "json_schema");
            assert.equal(body.output_config?.effort, "high");
            assert.equal(body.tool_choice, undefined);
            assert.ok(options?.signal instanceof AbortSignal);
            assert.equal(options?.timeout, 5_000);
            assert.equal(JSON.stringify(body).includes(KEY), false, "key never in the request body");
        },
    );
});

test("project profile from tyr.json goes into the cached block without volatile fields", async () => {
    await withRepo({}, async (root) => {
        const client = replying({ findings: [] });
        const config = {
            version: 2,
            tyrVersion: "1.0.0",
            initializedAt: "2026-11-01T00:00:00.000Z",
            project: {
                name: "demo",
                root,
                primaryLanguage: "TypeScript",
                languages: [{ name: "TypeScript", fileCount: 3, percentage: 100 }],
                frameworks: ["Express"],
                packageManager: "npm",
                fileCount: 3,
            },
            commands: {
                build: null,
                test: { command: "npm test", tool: "node:test", evidence: "package.json" },
                lint: null,
                format: null,
                typecheck: null,
            },
            git: { isRepo: true, branch: "main", remote: null, headCommit: "deadbeefcafe" },
            docs: { readme: null, claudeMd: null },
            scan: { ignoredDirs: [], ignoredExtensions: [] },
        };
        await reviewDiffWithLlm(ctx(root, makeDiff({ "a.ts": ["x"] })), opts(client, { config }));
        const text = systemBlocks(client.calls[0].body)[1].text;
        assert.match(text, /name: demo/);
        assert.match(text, /test command: npm test/);
        assert.match(text, /frameworks: Express/);
        assert.doesNotMatch(text, /deadbeefcafe|2026-11-01/);
    });
});

test("parses, validates and normalizes findings; drops hallucinated files", async () => {
    await withRepo({}, async (root) => {
        const diff = makeDiff({ "src/a.ts": ["one", "two", "three"], "src/b.ts": ["x"] });
        const client = replying({
            findings: [
                { severity: "error", title: "Null deref", detail: "x can be null.", file: "src/a.ts", line: 2, rule: "bug" },
                { severity: "critical", title: "Clamped", detail: "d", file: "b/src/b.ts", line: 1, rule: "Security Issue!" },
                { severity: "bogus", title: "Line outside hunk", detail: "d", file: "src/a.ts", line: 99, rule: "convention" },
                { severity: "warning", title: "Invented file", detail: "d", file: "src/ghost.ts", line: 1, rule: "bug" },
                { severity: "warning", title: "", detail: "no title", file: "src/a.ts", line: 1, rule: "bug" },
                { severity: "warning", title: "No file", detail: "d", line: 1, rule: "bug" },
                "not an object",
            ],
        });
        const result = await reviewDiffWithLlm(ctx(root, diff), opts(client));
        assert.equal(result.status, "ok");
        assert.deepEqual(result.usage, { inputTokens: 150, outputTokens: 20, cacheReadInputTokens: 50, cacheCreationInputTokens: 0 });
        assert.equal(result.findings.length, 3);
        for (const f of result.findings) {
            assert.equal(f.source, "llm");
            assert.ok(f.rule?.startsWith("llm/"));
            assert.ok(["src/a.ts", "src/b.ts"].includes(f.file ?? ""));
            assert.match(f.fingerprint, /^[0-9a-f]{16}$/);
            assert.ok(["info", "warning", "error"].includes(f.severity));
        }
        const byTitle = Object.fromEntries(result.findings.map((f) => [f.title, f]));
        assert.equal(byTitle["Null deref"].severity, "error");
        assert.equal(byTitle["Null deref"].line, 2);
        assert.equal(byTitle["Null deref"].rule, "llm/bug");
        assert.equal(byTitle["Null deref"].detail, "x can be null.");
        assert.equal(byTitle["Clamped"].severity, "error");
        assert.equal(byTitle["Clamped"].file, "src/b.ts");
        assert.equal(byTitle["Clamped"].rule, "llm/security-issue");
        assert.equal(byTitle["Line outside hunk"].severity, "warning");
        assert.equal(byTitle["Line outside hunk"].line, undefined);
        assert.equal(byTitle["Invented file"], undefined);
    });
});

test("caps the number of findings", async () => {
    await withRepo({}, async (root) => {
        const findings = Array.from({ length: 10 }, (_, i) => ({
            severity: "warning",
            title: `Problem ${String.fromCharCode(97 + i)}`,
            detail: "d",
            file: "a.ts",
            line: 1,
            rule: "bug",
        }));
        const result = await reviewDiffWithLlm(ctx(root, makeDiff({ "a.ts": ["x"] })), opts(replying({ findings }), { maxFindings: 3 }));
        assert.equal(result.findings.length, 3);
    });
});

test("skips without an API key, without calling the client", async () => {
    const client = replying({ findings: [] });
    for (const apiKey of [null, "  "]) {
        const result = await reviewDiffWithLlm(ctx("/nonexistent", makeDiff({ "a.ts": ["x"] })), {
            ...opts(client),
            settings: { ai: { model: MODEL, apiKey } },
        });
        assert.equal(result.status, "skipped");
        assert.match(result.reason ?? "", /API key/);
    }
    assert.equal(client.calls.length, 0);
});

test("resolves the key from the environment when no settings are given", async () => {
    await withRepo({}, async (root) => {
        const client = replying({ findings: [] });
        const home = await makeProject({});
        try {
            const env = { ANTHROPIC_API_KEY: KEY, TYR_CONFIG_HOME: home, HOME: home, XDG_CONFIG_HOME: home, TYR_MODEL: "claude-sonnet-5-5" };
            const result = await reviewDiffWithLlm(ctx(root, makeDiff({ "a.ts": ["x"] })), { client, env, config: null });
            assert.equal(result.status, "ok");
            assert.equal(client.calls[0].body.model, "claude-sonnet-5-5");
            const none = await reviewDiffWithLlm(ctx(root, makeDiff({ "a.ts": ["x"] })), {
                client,
                env: { TYR_CONFIG_HOME: home, HOME: home, XDG_CONFIG_HOME: home },
                config: null,
            });
            assert.equal(none.status, "skipped");
        } finally {
            await removeProject(home);
        }
    });
});

test("skips an empty diff", async () => {
    const client = replying({ findings: [] });
    const empty = makeDiff({});
    const result = await reviewDiffWithLlm(ctx("/nonexistent", empty), opts(client));
    assert.equal(result.status, "skipped");
    assert.match(result.reason ?? "", /empty/);
    assert.equal(client.calls.length, 0);
});

test("skips when no whole file fits the budget", async () => {
    const client = replying({ findings: [] });
    const diff = makeDiff({ "big.ts": Array.from({ length: 500 }, (_, i) => `line ${i}`) });
    const result = await reviewDiffWithLlm(ctx("/nonexistent", diff), opts(client, { maxPatchBytes: 1_000 }));
    assert.equal(result.status, "skipped");
    assert.match(result.reason ?? "", /too large/);
    assert.deepEqual(result.omittedFiles, ["big.ts"]);
    assert.equal(client.calls.length, 0);
});

test("trimming keeps whole files, skips ones over budget and names them in the prompt", async () => {
    await withRepo({}, async (root) => {
        const diff = makeDiff({
            "small1.ts": ["a"],
            "huge.ts": Array.from({ length: 400 }, (_, i) => `HUGE ${i}`),
            "small2.ts": ["b"],
        });
        const trimmed = trimPatch(diff, 2_000);
        assert.deepEqual(trimmed.included, ["small1.ts", "small2.ts"]);
        assert.deepEqual(trimmed.omitted, ["huge.ts"]);

        const client = replying({
            findings: [{ severity: "warning", title: "About omitted", detail: "d", file: "huge.ts", line: 1, rule: "bug" }],
        });
        const result = await reviewDiffWithLlm(ctx(root, diff), opts(client, { maxPatchBytes: 2_000 }));
        const user = userText(client.calls[0].body);
        assert.match(user, /left out[\s\S]*- huge\.ts/);
        assert.doesNotMatch(user, /HUGE 1/);
        assert.match(user, /\+a/);
        assert.match(user, /\+b/);
        assert.equal(result.findings.length, 0, "findings on omitted files are dropped");
        assert.deepEqual(result.omittedFiles, ["huge.ts"]);
    });
});

test("a diff truncated upstream never sends its partial last file", () => {
    const diff = makeDiff({ "a.ts": ["x"], "b.ts": ["y"] }, { truncated: true });
    const trimmed = trimPatch(diff, 100_000);
    assert.deepEqual(trimmed.included, ["a.ts"]);
    assert.deepEqual(trimmed.omitted, ["b.ts"]);
});

test("API errors become status error with a short reason that never contains the key", async () => {
    await withRepo({}, async (root) => {
        const diff = makeDiff({ "a.ts": ["x"] });
        const failing = new FakeClient(async () => {
            throw new Error(`401 invalid x-api-key: ${KEY}`);
        });
        const result = await reviewDiffWithLlm(ctx(root, diff), opts(failing));
        assert.equal(result.status, "error");
        assert.ok(result.reason);
        assert.equal(result.reason.includes(KEY), false);
        assert.deepEqual(result.findings, []);

        const timeout = new FakeClient(async () => {
            throw new DOMException("timed out", "TimeoutError");
        });
        const t = await reviewDiffWithLlm(ctx(root, diff), opts(timeout));
        assert.equal(t.status, "error");
        assert.match(t.reason ?? "", /timed out/);
    });
});

test("invalid JSON, refusals and truncated responses are errors, not findings", async () => {
    await withRepo({}, async (root) => {
        const diff = makeDiff({ "a.ts": ["x"] });
        const bad = await reviewDiffWithLlm(ctx(root, diff), opts(new FakeClient(async () => message("not json"))));
        assert.equal(bad.status, "error");
        assert.match(bad.reason ?? "", /JSON/);

        const refused = await reviewDiffWithLlm(ctx(root, diff), opts(new FakeClient(async () => message("", { stop_reason: "refusal" }))));
        assert.equal(refused.status, "error");
        assert.match(refused.reason ?? "", /declined/);

        const cut = await reviewDiffWithLlm(ctx(root, diff), opts(new FakeClient(async () => message('{"findings": [', { stop_reason: "max_tokens" }))));
        assert.equal(cut.status, "error");
        assert.match(cut.reason ?? "", /max_tokens/);
    });
});

test("an aborted signal is passed through and reported", async () => {
    await withRepo({}, async (root) => {
        const controller = new AbortController();
        const client = new FakeClient(async () => {
            throw new DOMException("aborted", "AbortError");
        });
        controller.abort();
        const result = await reviewDiffWithLlm(ctx(root, makeDiff({ "a.ts": ["x"] })), opts(client, { signal: controller.signal }));
        assert.equal(result.status, "error");
        assert.match(result.reason ?? "", /aborted/);
        assert.equal(client.calls[0].options?.signal?.aborted, true);
    });
});
