// Agent tool-use loop (cli/agents/provider.ts). Every test scripts a fake
// messages client, so nothing touches the network.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";

import type { AgentTool, PermissionGate, ToolEnv } from "../cli/agents/model.js";
import {
    NO_KEY_REASON,
    buildLoopRequest,
    resolveAgentAi,
    runToolLoop,
    type AgentMessagesClient,
    type ToolLoopEvent,
} from "../cli/agents/provider.js";

const KEY = "sk-ant-test-SECRET-1234567890";
const MODEL = "claude-opus-5-5";

const allowAll: PermissionGate = {
    check: () => ({ allowed: true }),
    approve: async () => ({ allowed: true }),
};

const env: ToolEnv = { workspace: ".", dryRun: true, gate: allowAll };

type Block = Anthropic.ContentBlock;

function message(content: Block[], stop: Anthropic.StopReason, usage = { input_tokens: 10, output_tokens: 5 }): Anthropic.Message {
    return {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: MODEL,
        content,
        stop_reason: stop,
        stop_sequence: null,
        usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...usage },
    } as unknown as Anthropic.Message;
}

function text(t: string): Block {
    return { type: "text", text: t, citations: null } as unknown as Block;
}

function toolUse(id: string, name: string, input: unknown): Block {
    return { type: "tool_use", id, name, input } as unknown as Block;
}

interface Scripted {
    client: AgentMessagesClient;
    requests: Anthropic.MessageCreateParamsNonStreaming[];
}

function scripted(responses: Array<Anthropic.Message | Error>): Scripted {
    const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
    let i = 0;
    return {
        requests,
        client: {
            async create(body) {
                // Snapshot: the loop keeps appending to its own array.
                requests.push(JSON.parse(JSON.stringify(body)));
                const next = responses[i++];
                if (next === undefined) throw new Error("no more scripted responses");
                if (next instanceof Error) throw next;
                return next;
            },
        },
    };
}

function echoTool(calls: unknown[] = []): AgentTool {
    return {
        name: "echo",
        description: "Echo the input.",
        inputSchema: { type: "object", properties: { value: { type: "string" } } },
        permission: "read",
        async run(input) {
            calls.push(input);
            return { content: `echo: ${(input as { value?: string }).value ?? ""}` };
        },
    };
}

test("runs tools until end_turn and returns the final text", async () => {
    const calls: unknown[] = [];
    const { client, requests } = scripted([
        message([text("Let me look."), toolUse("tu_1", "echo", { value: "a" }), toolUse("tu_2", "echo", { value: "b" })], "tool_use"),
        message([text("All done: a and b.")], "end_turn"),
    ]);
    const events: ToolLoopEvent[] = [];
    const result = await runToolLoop({
        client,
        model: MODEL,
        system: "SYSTEM",
        task: "do it",
        tools: [echoTool(calls)],
        env,
        maxTurns: 5,
        onEvent: (e) => events.push(e),
    });

    assert.equal(result.status, "completed");
    assert.equal(result.summary, "All done: a and b.");
    assert.equal(result.turns, 2);
    assert.deepEqual(calls, [{ value: "a" }, { value: "b" }]);
    assert.deepEqual(
        result.toolCalls.map((c) => [c.tool, c.isError, c.preview]),
        [
            ["echo", false, "echo: a"],
            ["echo", false, "echo: b"],
        ],
    );
    assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });

    // Second request carries the assistant turn and both results in one user message.
    const second = requests[1];
    assert.equal(second.messages.length, 3);
    assert.equal(second.messages[1].role, "assistant");
    const results = second.messages[2].content as Anthropic.ToolResultBlockParam[];
    assert.deepEqual(
        results.map((r) => [r.type, r.tool_use_id, r.content]),
        [
            ["tool_result", "tu_1", "echo: a"],
            ["tool_result", "tu_2", "echo: b"],
        ],
    );

    assert.deepEqual(
        events.map((e) => e.type),
        ["turn", "text", "tool-call", "tool-result", "tool-call", "tool-result", "turn", "text"],
    );
});

test("the request caches the system prompt and sends tool definitions", async () => {
    const body = buildLoopRequest({ model: MODEL, system: "SYS", tools: [echoTool()] }, [{ role: "user", content: "x" }]);
    assert.deepEqual(body.system, [{ type: "text", text: "SYS", cache_control: { type: "ephemeral" } }]);
    assert.deepEqual(body.tools, [
        { name: "echo", description: "Echo the input.", input_schema: { type: "object", properties: { value: { type: "string" } } } },
    ]);
    assert.equal(body.model, MODEL);
    assert.equal(body.output_config?.effort, "high");
    assert.equal(body.tool_choice, undefined);

    const old = buildLoopRequest({ model: "claude-3-5-haiku-latest", system: "SYS", tools: [] }, []);
    assert.equal(old.output_config, undefined);
    assert.equal(old.tools, undefined);
});

test("stops at maxTurns with status max-turns", async () => {
    const loop = Array.from({ length: 5 }, (_, i) => message([toolUse(`tu_${i}`, "echo", { value: String(i) })], "tool_use"));
    const { client, requests } = scripted(loop);
    const result = await runToolLoop({ client, model: MODEL, system: "S", task: "t", tools: [echoTool()], env, maxTurns: 3 });
    assert.equal(result.status, "max-turns");
    assert.equal(result.turns, 3);
    assert.equal(requests.length, 3);
    assert.equal(result.toolCalls.length, 3);
    assert.match(result.reason ?? "", /3 turns/);
});

test("an unknown tool gets an error tool_result and the loop goes on", async () => {
    const { client, requests } = scripted([
        message([toolUse("tu_1", "rm_rf", { path: "/" })], "tool_use"),
        message([text("ok")], "end_turn"),
    ]);
    const result = await runToolLoop({ client, model: MODEL, system: "S", task: "t", tools: [echoTool()], env, maxTurns: 4 });
    assert.equal(result.status, "completed");
    assert.equal(result.toolCalls[0].isError, true);
    assert.match(result.toolCalls[0].preview, /unknown tool "rm_rf"/);
    const sent = requests[1].messages[2].content as Anthropic.ToolResultBlockParam[];
    assert.equal(sent[0].is_error, true);
});

test("a throwing tool becomes an error result, not a crash", async () => {
    const bad: AgentTool = { ...echoTool(), name: "bad", run: async () => { throw new Error(`boom ${KEY}`); } };
    const { client } = scripted([message([toolUse("tu_1", "bad", {})], "tool_use"), message([text("done")], "end_turn")]);
    const result = await runToolLoop({ client, model: MODEL, system: "S", task: "t", tools: [bad], env, maxTurns: 4 });
    assert.equal(result.status, "completed");
    assert.equal(result.toolCalls[0].isError, true);
    assert.ok(!result.toolCalls[0].preview.includes(KEY));
});

test("API errors come back as status error with the key redacted", async () => {
    const err = new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: `bad key ${KEY}` } }, `bad key ${KEY}`, new Headers());
    const { client } = scripted([err]);
    const result = await runToolLoop({ client, model: MODEL, system: "S", task: "t", tools: [], env, maxTurns: 2, apiKey: KEY });
    assert.equal(result.status, "error");
    assert.match(result.reason ?? "", /bad request \(400\)/);
    assert.ok(!(result.reason ?? "").includes(KEY));
    assert.ok(!(result.reason ?? "").includes("SECRET"));

    const auth = scripted([new Anthropic.AuthenticationError(401, undefined, "nope", new Headers())]);
    const r2 = await runToolLoop({ client: auth.client, model: MODEL, system: "S", task: "t", tools: [], env, maxTurns: 2 });
    assert.equal(r2.reason, "the API key was rejected (401)");

    const plain = scripted([new Error(`socket closed for ${KEY}`)]);
    const r3 = await runToolLoop({ client: plain.client, model: MODEL, system: "S", task: "t", tools: [], env, maxTurns: 2 });
    assert.equal(r3.status, "error");
    assert.ok(!(r3.reason ?? "").includes(KEY));
});

test("refusal and max_tokens end the run with an error", async () => {
    const refused = await runToolLoop({ client: scripted([message([], "refusal")]).client, model: MODEL, system: "S", task: "t", tools: [], env, maxTurns: 2 });
    assert.equal(refused.status, "error");
    assert.match(refused.reason ?? "", /declined/);
    const cut = await runToolLoop({ client: scripted([message([text("half")], "max_tokens")]).client, model: MODEL, system: "S", task: "t", tools: [], env, maxTurns: 2 });
    assert.equal(cut.status, "error");
    assert.equal(cut.summary, "half");
});

test("an aborted signal cancels before the first request", async () => {
    const controller = new AbortController();
    controller.abort();
    const { client, requests } = scripted([message([text("x")], "end_turn")]);
    const result = await runToolLoop({ client, model: MODEL, system: "S", task: "t", tools: [], env, maxTurns: 2, signal: controller.signal });
    assert.equal(result.status, "cancelled");
    assert.equal(requests.length, 0);
    assert.equal(result.turns, 0);
});

test("aborting during a request reports cancelled", async () => {
    const controller = new AbortController();
    const client: AgentMessagesClient = {
        create: (_body, options) =>
            new Promise((_resolve, reject) => {
                options?.signal?.addEventListener("abort", () => reject(new Anthropic.APIUserAbortError()));
                setTimeout(() => controller.abort(), 5);
            }),
    };
    const result = await runToolLoop({ client, model: MODEL, system: "S", task: "t", tools: [], env, maxTurns: 2, signal: controller.signal });
    assert.equal(result.status, "cancelled");
    assert.equal(result.turns, 1);
});

test("aborting during a tool stops before the next request", async () => {
    const controller = new AbortController();
    const slow: AgentTool = {
        ...echoTool(),
        name: "slow",
        run: async (_input, toolEnv) => {
            controller.abort();
            assert.equal(toolEnv.signal, controller.signal);
            return { content: "partial" };
        },
    };
    const { client, requests } = scripted([message([toolUse("tu_1", "slow", {})], "tool_use"), message([text("never")], "end_turn")]);
    const result = await runToolLoop({ client, model: MODEL, system: "S", task: "t", tools: [slow], env, maxTurns: 4, signal: controller.signal });
    assert.equal(result.status, "cancelled");
    assert.equal(requests.length, 1);
});

test("pause_turn re-sends the conversation to continue", async () => {
    const { client, requests } = scripted([message([text("thinking...")], "pause_turn"), message([text("finished")], "end_turn")]);
    const result = await runToolLoop({ client, model: MODEL, system: "S", task: "t", tools: [], env, maxTurns: 4 });
    assert.equal(result.status, "completed");
    assert.equal(result.summary, "finished");
    assert.equal(requests[1].messages.at(-1)?.role, "assistant");
});

test("usage sums cache reads and writes into input tokens", async () => {
    const { client } = scripted([
        message([toolUse("tu_1", "echo", {})], "tool_use", { input_tokens: 5, output_tokens: 2, cache_creation_input_tokens: 100 } as never),
        message([text("ok")], "end_turn", { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 100 } as never),
    ]);
    const result = await runToolLoop({ client, model: MODEL, system: "S", task: "t", tools: [echoTool()], env, maxTurns: 4 });
    assert.deepEqual(result.usage, { inputTokens: 212, outputTokens: 5, cacheReadInputTokens: 100, cacheCreationInputTokens: 100 });
});

test("resolveAgentAi reads the key from settings and skips without one", async () => {
    const ready = await resolveAgentAi(".", { settings: { ai: { apiKey: KEY, model: MODEL } } });
    assert.deepEqual(ready, { ok: true, apiKey: KEY, model: MODEL });
    const none = await resolveAgentAi(".", { settings: { ai: { apiKey: null, model: MODEL } } });
    assert.deepEqual(none, { ok: false, reason: NO_KEY_REASON });
    const blank = await resolveAgentAi(".", { settings: { ai: { apiKey: "  ", model: MODEL } } });
    assert.equal(blank.ok, false);
});
