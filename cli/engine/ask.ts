// The "ask" route of `tyr run` (cli/engine/intent.ts): answer a question
// about the repository with the model, grounded in what Tyr already knows.
//
// Context, most stable first so the cached prefix survives between asks:
//   system   the instructions, then the project profile (tyr.json),
//            CLAUDE.md and README (cache breakpoint after these)
//   user     the live state: tyr status (checks with failing output
//            excerpts, open problems, open findings, drift, background
//            process), recent commits, the uncommitted diff (trimmed), and
//            finally the question
//
// One streamed request, no tools: the model sees a snapshot, not the file
// system. Tool-using agents are PLANNING.md 2.14. Text arrives through
// `onText` as it streams.
//
// askRepository never throws: a missing key is `skipped`, API failures are
// `error` with a reason that never contains the key.

import Anthropic from "@anthropic-ai/sdk";
import { getDiff } from "../core/git-diff.js";
import { getCommitLog } from "../core/git-history.js";
import { readConfig } from "../core/scaffold.js";
import { resolveSettings } from "../core/settings.js";
import type { TyrSettings } from "../core/settings-types.js";
import { collectStatus, type InitializedStatus } from "../core/status.js";
import type { TyrConfig } from "../core/types.js";
import { redactSecrets } from "./diff-review.js";
import {
    errorReason,
    profileText,
    readDoc,
    redact,
    supportsEffort,
    trimPatch,
    usageOf,
    type LlmReviewUsage,
} from "./llm-review.js";

/** The one SDK call ask makes; `messages` of an Anthropic client fits. */
export interface AskMessagesClient {
    stream(
        body: Anthropic.MessageStreamParams,
        options?: { signal?: AbortSignal; timeout?: number },
    ): AsyncIterable<Anthropic.MessageStreamEvent> & { finalMessage(): Promise<Anthropic.Message> };
}

export interface AskOptions {
    /** Resolved settings (only `ai` is read). Default: resolveSettings({ root, env }). */
    settings?: Pick<TyrSettings, "ai">;
    env?: NodeJS.ProcessEnv;
    /** Parsed tyr.json. Default: readConfig(root). */
    config?: TyrConfig | null;
    /** Injected client (tests). Default: a real Anthropic client. */
    client?: AskMessagesClient;
    /** Called with each streamed piece of the answer. */
    onText?: (text: string) => void;
    /** Called once the context is gathered, before the request goes out. */
    onRequest?: (info: { model: string; contextBytes: number }) => void;
    signal?: AbortSignal;
    /** Request time limit in milliseconds. Default 600 000. */
    timeoutMs?: number;
    /** Budget for the uncommitted diff. Default 60 000 bytes. */
    maxPatchBytes?: number;
    /** Cap per documentation file. Default 24 000 bytes. */
    maxDocBytes?: number;
    /** max_tokens. Default 32 000 (streamed, so no HTTP timeout concern). */
    maxTokens?: number;
}

export interface AskResult {
    status: "ok" | "skipped" | "error";
    /** The answer text (possibly partial on error). */
    answer: string;
    model: string | null;
    reason?: string;
    stopReason?: string | null;
    usage?: LlmReviewUsage;
}

export const DEFAULT_ASK_TIMEOUT_MS = 600_000;
export const DEFAULT_ASK_PATCH_BYTES = 60_000;
export const DEFAULT_ASK_DOC_BYTES = 24_000;
export const DEFAULT_ASK_MAX_TOKENS = 32_000;
/** Recent commits shown to the model. */
export const ASK_COMMIT_LIMIT = 15;

export const ASK_SYSTEM_PROMPT = `You are Tyr, a background engineering manager and reviewer for one software repository. A developer has asked you a question from the command line (\`tyr run "<question>"\`).

You receive a snapshot of what Tyr knows: the project profile and its documentation, the latest results of the project's checks (build, typecheck, lint, test, format) with excerpts of failing output, open findings from Tyr's reviews, how far the repository has drifted since it was indexed, recent commits and the uncommitted diff. You cannot open files, run commands or see anything outside this snapshot.

Answer the question directly, grounded in the snapshot. Cite files as path:line when the snapshot gives a line. If the snapshot does not contain what is needed to answer, say what is missing and which command or file would settle it, rather than guessing. When a check is failing, lead with the most likely cause and the concrete fix.

The answer is printed in a terminal: plain text with short paragraphs or "-" bullet lists, no Markdown headings or tables, and keep it brief unless the question calls for depth.`;

export async function askRepository(root: string, question: string, opts: AskOptions = {}): Promise<AskResult> {
    let apiKey: string | null = null;
    let model: string | null = null;
    let answer = "";
    try {
        const ai = opts.settings?.ai ?? (await resolveSettings({ root, env: opts.env })).settings.ai;
        apiKey = ai.apiKey;
        model = ai.model;
        if (apiKey === null || apiKey.trim() === "") {
            return { status: "skipped", answer: "", model, reason: "no API key (set ai.apiKey, TYR_API_KEY or ANTHROPIC_API_KEY)" };
        }
        const body = await buildAskRequest(root, question, { ...opts, model });
        const contextBytes = Buffer.byteLength(JSON.stringify(body.system ?? "") + JSON.stringify(body.messages), "utf8");
        opts.onRequest?.({ model, contextBytes });

        const client = opts.client ?? defaultClient(apiKey);
        const timeoutMs = opts.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
        const signal = opts.signal
            ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)])
            : AbortSignal.timeout(timeoutMs);
        const stream = client.stream(body, { signal, timeout: timeoutMs });
        for await (const event of stream) {
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
                answer += event.delta.text;
                opts.onText?.(event.delta.text);
            }
        }
        const message = await stream.finalMessage();
        const usage = usageOf(message);
        if (message.stop_reason === "refusal") {
            return { status: "error", answer, model, reason: "the model declined to answer", stopReason: message.stop_reason, usage };
        }
        if (message.stop_reason === "max_tokens") {
            return { status: "error", answer, model, reason: "the answer was cut off at max_tokens", stopReason: message.stop_reason, usage };
        }
        return { status: "ok", answer, model, stopReason: message.stop_reason, usage };
    } catch (error) {
        return { status: "error", answer, model, reason: redact(errorReason(error), apiKey) };
    }
}

function defaultClient(apiKey: string): AskMessagesClient {
    const anthropic = new Anthropic({ apiKey, maxRetries: 2 });
    return { stream: (body, options) => anthropic.messages.stream(body, options) };
}

/** The request askRepository sends. Exported for tests. */
export async function buildAskRequest(
    root: string,
    question: string,
    opts: Pick<AskOptions, "config" | "maxPatchBytes" | "maxDocBytes" | "maxTokens"> & { model: string },
): Promise<Anthropic.MessageStreamParams> {
    const config = opts.config !== undefined ? opts.config : await readConfig(root).catch(() => null);
    const docBytes = opts.maxDocBytes ?? DEFAULT_ASK_DOC_BYTES;
    const [claudeMd, readme, status, log, diff] = await Promise.all([
        readDoc(root, config?.docs.claudeMd ?? "CLAUDE.md", docBytes),
        readDoc(root, config?.docs.readme ?? "README.md", docBytes),
        collectStatus(root, { scanFiles: false }).catch(() => null),
        getCommitLog(root, null, { limit: ASK_COMMIT_LIMIT }).catch(() => null),
        getDiff(root, { kind: "since", ref: "HEAD" }, { includeUntracked: true, timeoutMs: 10_000 }).catch(() => null),
    ]);

    const docs: string[] = [];
    if (config !== null) docs.push(`<project_profile>\n${profileText(config)}\n</project_profile>`);
    if (claudeMd !== null) docs.push(`<claude_md path="${claudeMd.path}">\n${claudeMd.text}\n</claude_md>`);
    if (readme !== null) docs.push(`<readme path="${readme.path}">\n${readme.text}\n</readme>`);
    if (docs.length === 0) docs.push("The project has no profile or documentation.");

    const user: string[] = [];
    if (status !== null && status.initialized) user.push(`<tyr_status>\n${statusText(status)}\n</tyr_status>`);
    if (log !== null && log.commits.length > 0) {
        const lines = log.commits.map((c) => `${c.shortHash} ${c.date.slice(0, 10)} ${c.author}: ${c.subject}`);
        if (log.hasMore) lines.push("(older commits omitted)");
        user.push(`<recent_commits>\n${lines.join("\n")}\n</recent_commits>`);
    }
    if (diff !== null) {
        // Tyr's own files are not the project's changes.
        const untracked = (diff.untracked ?? []).filter((file) => !isTyrPath(file));
        if (diff.files.length === 0 && untracked.length === 0) {
            user.push("<uncommitted_changes>none</uncommitted_changes>");
        } else {
            const trimmed = trimPatch(diff, opts.maxPatchBytes ?? DEFAULT_ASK_PATCH_BYTES);
            const parts = [redactSecrets(trimmed.patch)];
            if (trimmed.omitted.length > 0) parts.push(`(patch omitted for: ${trimmed.omitted.join(", ")})`);
            if (untracked.length > 0) parts.push(`untracked files: ${untracked.join(", ")}`);
            user.push(`<uncommitted_changes>\n${parts.join("\n")}\n</uncommitted_changes>`);
        }
    }
    user.push(`<question>\n${question}\n</question>`);

    const effort = supportsEffort(opts.model) ? { output_config: { effort: "medium" as const } } : {};
    return {
        model: opts.model,
        max_tokens: opts.maxTokens ?? DEFAULT_ASK_MAX_TOKENS,
        system: [
            { type: "text", text: ASK_SYSTEM_PROMPT },
            { type: "text", text: docs.join("\n\n"), cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content: user.join("\n\n") }],
        ...effort,
    };
}

/** The live part of `tyr status`, as compact text for the model. Exported for tests. */
export function statusText(status: InitializedStatus): string {
    const lines: string[] = [];
    const daemon = status.daemon.running ? `running (pid ${status.daemon.pid})` : "not running";
    lines.push(`background process: ${daemon}`);

    const engine = status.engine;
    if (engine === null || engine.checks.length === 0) {
        lines.push("checks: none have run yet");
    } else {
        lines.push(`checks (as of ${engine.updatedAt}):`);
        for (const check of engine.checks) {
            const passed = check.outcome === "passed" ? "" : `; last passed ${check.lastPassedAt ?? "never"}`;
            lines.push(`- ${check.kind}: ${check.outcome} (\`${check.command}\`, exit ${check.exitCode ?? "none"}, ${check.finishedAt}${passed})`);
        }
        for (const problem of engine.problems) {
            lines.push(`open problem ${problem.key}${problem.regression ? " (regression)" : ""}: ${problem.title}`);
            if (problem.detail.trim() !== "") lines.push(`  output excerpt:\n${indent(redactSecrets(problem.detail), "    ")}`);
        }
    }

    const findings = status.findings;
    if (findings.total === 0) {
        lines.push(findings.source === "none" ? "findings: no review has run yet" : "findings: none open");
    } else {
        lines.push(`open findings (${findings.total}${findings.truncated ? `, showing ${findings.items.length}` : ""}):`);
        for (const f of findings.items) {
            const where = f.file ? ` ${f.file}${f.line !== undefined ? `:${f.line}` : ""}` : "";
            const rule = f.rule ? ` [${f.rule}]` : "";
            lines.push(`- ${f.severity}${f.regression ? " (regression)" : ""}${where}: ${f.title}${rule}`);
            if (f.detail) lines.push(indent(redactSecrets(firstLines(f.detail, 6)), "    "));
        }
    }

    const drift = status.drift;
    if (drift.isRepo) {
        const head = drift.currentHead ? drift.currentHead.slice(0, 12) : "unborn";
        lines.push(`git: on ${drift.currentBranch ?? "unknown branch"} at ${head}`);
        if (drift.headChanged) lines.push(`drift: ${drift.commitsSinceIndex ?? "some"} commits since Tyr indexed the repository`);
    } else {
        lines.push("git: not a git repository");
    }
    for (const warning of status.warnings) lines.push(`warning (${warning.source}): ${warning.message}`);
    return lines.join("\n");
}

function isTyrPath(file: string): boolean {
    return file === ".tyr" || file.startsWith(".tyr/");
}

function indent(text: string, prefix: string): string {
    return text
        .split("\n")
        .map((line) => prefix + line)
        .join("\n");
}

function firstLines(text: string, n: number): string {
    const lines = text.split("\n");
    return lines.length <= n ? text : `${lines.slice(0, n).join("\n")}\n...`;
}
