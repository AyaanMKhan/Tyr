// cli/agents/provider.ts — the LLM side of an agent run (PLANNING 2.14).
//
//   resolveAgentAi(root, opts)  -> { ok: true, apiKey, model } | { ok: false, reason }
//   defaultAgentClient(apiKey)  -> AgentMessagesClient (a real Anthropic client)
//   runToolLoop(opts)           -> Promise<ToolLoopResult>
//
// runToolLoop is a manual tool-use loop over the Messages API: it sends the
// role's tools, runs every tool_use block through tool.run(input, env), sends
// all results back in one user message, and repeats until the model ends its
// turn or the turn cap is reached.
//
//   completed   the model stopped on its own (end_turn / stop_sequence)
//   max-turns   maxTurns requests were made and the model still wanted tools
//   cancelled   the caller's signal fired (before or during a request or tool)
//   error       API failure, refusal, truncated output; the reason never
//               contains the key
//
// Request layout, stable first so prompt caching works across turns:
//
//   tools     the role's tool definitions (deterministic order)
//   system    role instructions + repo context          <- cache_control
//   messages  task, then assistant turns and tool results (top-level
//             cache_control caches the growing conversation prefix)
//
// Assistant content is appended unchanged (thinking blocks included), as the
// API requires. Thinking is left at the model default; effort is set to
// "high" where the model accepts it.
//
// Like the rest of cli/agents: nothing prints, nothing throws for normal
// conditions, and the messages client is injectable so tests never touch the
// network.

import Anthropic from "@anthropic-ai/sdk";
import { resolveSettings } from "../core/settings.js";
import type { TyrSettings } from "../core/settings-types.js";
import { errorReason, redact, supportsEffort } from "../engine/llm-review.js";
import type { AgentRunStatus, AgentTool, AgentToolCall, ToolEnv, ToolResult } from "./model.js";

/* -------------------------------------------------------------------------
 * Key and model resolution
 * ---------------------------------------------------------------------- */

export type AgentAi = { ok: true; apiKey: string; model: string } | { ok: false; reason: string };

export interface ResolveAgentAiOptions {
    /** Resolved settings (only `ai` is read). Default: resolveSettings({ root, env }). */
    settings?: Pick<TyrSettings, "ai">;
    /** Environment for resolveSettings. Default process.env. */
    env?: NodeJS.ProcessEnv;
}

export const NO_KEY_REASON = "no API key (set ai.apiKey, TYR_API_KEY or ANTHROPIC_API_KEY)";

/**
 * The key and model an agent run uses, from the same settings chain as the
 * reviewer and `tyr run` questions (ai.apiKey, TYR_API_KEY, ANTHROPIC_API_KEY).
 * Never throws.
 */
export async function resolveAgentAi(root: string, opts: ResolveAgentAiOptions = {}): Promise<AgentAi> {
    try {
        const ai = opts.settings?.ai ?? (await resolveSettings({ root, env: opts.env })).settings.ai;
        if (ai.apiKey === null || ai.apiKey.trim() === "") return { ok: false, reason: NO_KEY_REASON };
        return { ok: true, apiKey: ai.apiKey, model: ai.model };
    } catch (error) {
        return { ok: false, reason: `could not read settings: ${redact(error instanceof Error ? error.message : String(error), null)}` };
    }
}

/* -------------------------------------------------------------------------
 * Client
 * ---------------------------------------------------------------------- */

/** The one SDK call the loop makes; `messages.create` of an Anthropic client fits. */
export interface AgentMessagesClient {
    create(
        body: Anthropic.MessageCreateParamsNonStreaming,
        options?: { signal?: AbortSignal; timeout?: number },
    ): Promise<Anthropic.Message>;
}

export function defaultAgentClient(apiKey: string): AgentMessagesClient {
    const anthropic = new Anthropic({ apiKey, maxRetries: 2 });
    return { create: (body, options) => anthropic.messages.create(body, options) };
}

/* -------------------------------------------------------------------------
 * The loop
 * ---------------------------------------------------------------------- */

export const DEFAULT_AGENT_MAX_TOKENS = 16_000;
/** Per request. A single turn on a hard task can take minutes. */
export const DEFAULT_AGENT_TIMEOUT_MS = 600_000;
/** Cap on one tool result sent back to the model (tools bound their own output too). */
export const MAX_TOOL_RESULT_CHARS = 60_000;
/** Length of AgentToolCall.preview. */
export const TOOL_PREVIEW_CHARS = 300;

/** Progress events, so `tyr run` can show what the agent is doing. */
export type ToolLoopEvent =
    | { type: "turn"; turn: number }
    | { type: "text"; turn: number; text: string }
    | { type: "tool-call"; turn: number; tool: string; input: unknown }
    | { type: "tool-result"; turn: number; tool: string; isError: boolean; preview: string };

export interface ToolLoopUsage {
    /** All input tokens: uncached + cache writes + cache reads, summed over turns. */
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
}

export interface ToolLoopOptions {
    client: AgentMessagesClient;
    model: string;
    /** Role instructions plus repo context. Kept byte-stable across turns for caching. */
    system: string;
    /** The task in plain words: the first user message. */
    task: string;
    tools: readonly AgentTool[];
    env: ToolEnv;
    /** Hard cap on requests to the model. */
    maxTurns: number;
    /** max_tokens per response. Default 16 000. */
    maxTokens?: number;
    /** Per-request time limit in milliseconds. Default 600 000. */
    timeoutMs?: number;
    /** Cancels the run (the current request and the tools that honour env.signal). */
    signal?: AbortSignal;
    onEvent?: (event: ToolLoopEvent) => void;
    /** The key in use, so error reasons can be scrubbed of it. */
    apiKey?: string | null;
}

export interface ToolLoopResult {
    status: AgentRunStatus;
    /** Final text from the agent (the last text it wrote). */
    summary: string;
    reason?: string;
    toolCalls: AgentToolCall[];
    /** Requests made to the model. */
    turns: number;
    usage: ToolLoopUsage;
}

export async function runToolLoop(opts: ToolLoopOptions): Promise<ToolLoopResult> {
    const toolCalls: AgentToolCall[] = [];
    const usage: ToolLoopUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    const byName = new Map(opts.tools.map((tool) => [tool.name, tool]));
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: opts.task }];
    const maxTurns = Math.max(1, Math.floor(Number.isFinite(opts.maxTurns) ? opts.maxTurns : 1));
    const timeoutMs = opts.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
    const env: ToolEnv = opts.signal && !opts.env.signal ? { ...opts.env, signal: opts.signal } : opts.env;
    const emit = (event: ToolLoopEvent): void => {
        try {
            opts.onEvent?.(event);
        } catch {
            // A broken progress printer must not end the run.
        }
    };

    let turns = 0;
    let summary = "";
    const finish = (status: AgentRunStatus, reason?: string): ToolLoopResult => ({
        status,
        summary,
        ...(reason !== undefined ? { reason } : {}),
        toolCalls,
        turns,
        usage,
    });

    try {
        while (turns < maxTurns) {
            if (opts.signal?.aborted) return finish("cancelled", "cancelled");
            turns += 1;
            emit({ type: "turn", turn: turns });

            const body = buildLoopRequest(opts, messages);
            const signal = opts.signal
                ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)])
                : AbortSignal.timeout(timeoutMs);
            const response = await opts.client.create(body, { signal, timeout: timeoutMs });
            addUsage(usage, response);

            const text = textOf(response);
            if (text.trim() !== "") {
                summary = text.trim();
                emit({ type: "text", turn: turns, text: summary });
            }
            messages.push({ role: "assistant", content: response.content });

            switch (response.stop_reason) {
                case "end_turn":
                case "stop_sequence":
                case null:
                    return finish("completed");
                case "refusal":
                    return finish("error", "the model declined this task");
                case "max_tokens":
                    return finish("error", "the response was cut off at max_tokens");
                case "model_context_window_exceeded":
                    return finish("error", "the conversation outgrew the model's context window");
                case "pause_turn":
                    continue;
                case "tool_use":
                    break;
                default:
                    return finish("error", `unexpected stop reason: ${String(response.stop_reason)}`);
            }

            const uses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
            if (uses.length === 0) return finish("completed");

            // Sequential on purpose: write tools may touch the same file.
            const results: Anthropic.ToolResultBlockParam[] = [];
            for (const use of uses) {
                if (opts.signal?.aborted) return finish("cancelled", "cancelled");
                emit({ type: "tool-call", turn: turns, tool: use.name, input: use.input });
                const result = await runOne(byName.get(use.name), use, env);
                const content = boundText(result.content, MAX_TOOL_RESULT_CHARS);
                const isError = result.isError === true;
                const preview = oneLinePreview(content);
                toolCalls.push({ tool: use.name, input: use.input, isError, preview });
                emit({ type: "tool-result", turn: turns, tool: use.name, isError, preview });
                results.push({
                    type: "tool_result",
                    tool_use_id: use.id,
                    content,
                    ...(isError ? { is_error: true } : {}),
                });
            }
            if (opts.signal?.aborted) return finish("cancelled", "cancelled");
            messages.push({ role: "user", content: results });
        }
        return finish("max-turns", `stopped after ${maxTurns} turn${maxTurns === 1 ? "" : "s"}`);
    } catch (error) {
        if (opts.signal?.aborted) return finish("cancelled", "cancelled");
        return finish("error", redact(errorReason(error).replace(/^review failed: /, "agent failed: "), opts.apiKey ?? null));
    }
}

/** Exported for tests: the request for the current conversation. */
export function buildLoopRequest(
    opts: Pick<ToolLoopOptions, "model" | "system" | "tools" | "maxTokens">,
    messages: Anthropic.MessageParam[],
): Anthropic.MessageCreateParamsNonStreaming {
    const tools: Anthropic.Tool[] = opts.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
    }));
    return {
        model: opts.model,
        max_tokens: opts.maxTokens ?? DEFAULT_AGENT_MAX_TOKENS,
        system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
        ...(tools.length > 0 ? { tools } : {}),
        messages: [...messages],
        cache_control: { type: "ephemeral" },
        ...(supportsEffort(opts.model) ? { output_config: { effort: "high" as const } } : {}),
    };
}

async function runOne(tool: AgentTool | undefined, use: Anthropic.ToolUseBlock, env: ToolEnv): Promise<ToolResult> {
    if (tool === undefined) {
        return { content: `unknown tool "${use.name}"; use only the tools provided`, isError: true };
    }
    try {
        const result = await tool.run(use.input, env);
        if (result === null || typeof result !== "object" || typeof result.content !== "string") {
            return { content: `tool "${use.name}" returned no result`, isError: true };
        }
        return result;
    } catch (error) {
        // tools.ts never throws; this guards injected or future tools.
        const message = error instanceof Error ? error.message : String(error);
        return { content: `tool "${use.name}" failed: ${redact(message, null).slice(0, 500)}`, isError: true };
    }
}

function textOf(response: Anthropic.Message): string {
    return response.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .filter((t) => t !== "")
        .join("\n");
}

function addUsage(total: ToolLoopUsage, response: Anthropic.Message): void {
    const u = response.usage;
    if (!u) return;
    const read = u.cache_read_input_tokens ?? 0;
    const write = u.cache_creation_input_tokens ?? 0;
    total.inputTokens += (u.input_tokens ?? 0) + read + write;
    total.outputTokens += u.output_tokens ?? 0;
    total.cacheReadInputTokens += read;
    total.cacheCreationInputTokens += write;
}

function boundText(text: string, max: number): string {
    if (text.length <= max) return text;
    return `${text.slice(0, max)}\n[... ${text.length - max} more characters cut]`;
}

function oneLinePreview(text: string): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length <= TOOL_PREVIEW_CHARS ? flat : `${flat.slice(0, TOOL_PREVIEW_CHARS - 3)}...`;
}
