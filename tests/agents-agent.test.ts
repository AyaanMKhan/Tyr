// cli/agents/agent.ts: runAgent end to end against temp repos initialized by
// the real `tyr init`, with a scripted messages client (no network). Covers
// the reviewer's read-only run, the fixer's dry run, an applied run isolated
// in a worktree, the refusals before any request (no key, nobody to
// approve), the optional correction, and the `tyr run --agent` record.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";

import { agentRouteOutcome, agentSummaryLine, parseAgentFindings, runAgent, type AgentEvent } from "../cli/agents/agent.js";
import { pendingCorrections } from "../cli/agents/coordinate.js";
import type { AgentRunOptions, AgentRunResult } from "../cli/agents/model.js";
import type { AgentAi, AgentMessagesClient } from "../cli/agents/provider.js";
import { listAgentWorktrees, removeAgentWorktree } from "../cli/agents/safety.js";
import { readEvents } from "../cli/core/events.js";
import { readReport } from "../cli/core/reports.js";
import { resolveTyrPaths } from "../cli/core/scaffold.js";
import { executeRun } from "../cli/engine/run.js";
import { makeProject, removeProject } from "./helpers.js";

const CLI = fileURLToPath(new URL("../cli/index.js", import.meta.url));
const MODEL = "claude-opus-5-5";
const AI: AgentAi = { ok: true, apiKey: "sk-ant-test-SECRET-0000000000", model: MODEL };
const FIXED = () => new Date("2026-11-18T09:08:07Z");

const CONFIG_HOME = await fs.mkdtemp(path.join(os.tmpdir(), "tyr-agent-home-"));
process.env.TYR_CONFIG_HOME = CONFIG_HOME;
delete process.env.TYR_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

function git(root: string, ...args: string[]): string {
    return execFileSync("git", ["-c", "user.name=Tyr", "-c", "user.email=tyr@example.com", "-c", "commit.gpgsign=false", ...args], {
        cwd: root,
        encoding: "utf8",
    }).trim();
}

/** A committed repo initialized by `tyr init`, with no check commands. */
async function makeRepo(): Promise<string> {
    const root = await makeProject({
        "package.json": JSON.stringify({ name: "agent-fixture" }),
        "src/a.ts": "export const a = 1;\n",
        "src/b.ts": "export const b = 2;\n",
        "README.md": "# fixture\n",
    });
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "core.autocrlf", "false");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "initial");
    const result = spawnSync(process.execPath, [CLI, "init", "--no-verify", "--no-gitignore", "--no-color"], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1" },
    });
    assert.equal(result.status, 0, `tyr init failed:\n${result.stdout}\n${result.stderr}`);
    const { configFile } = resolveTyrPaths(root);
    const config = JSON.parse(await fs.readFile(configFile, "utf8"));
    for (const kind of ["build", "test", "lint", "typecheck", "format"]) config.commands[kind] = null;
    await fs.writeFile(configFile, `${JSON.stringify(config, null, 4)}\n`);
    // Commit .tyr/ so it is not part of "the user's changes".
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "tyr init");
    return root;
}

async function cleanup(root: string): Promise<void> {
    const worktrees = await listAgentWorktrees(root);
    if (!("error" in worktrees)) {
        for (const w of worktrees) await removeAgentWorktree(root, w.path, { force: true, keepBranch: false });
    }
    await removeProject(root);
}

type Block = Anthropic.ContentBlock;

function message(content: Block[], stop: Anthropic.StopReason): Anthropic.Message {
    return {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: MODEL,
        content,
        stop_reason: stop,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    } as unknown as Anthropic.Message;
}

const text = (t: string): Block => ({ type: "text", text: t, citations: null }) as unknown as Block;
const toolUse = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input }) as unknown as Block;

function scripted(responses: Anthropic.Message[]): { client: AgentMessagesClient; requests: Anthropic.MessageCreateParamsNonStreaming[] } {
    const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
    let i = 0;
    return {
        requests,
        client: {
            async create(body) {
                requests.push(JSON.parse(JSON.stringify(body)));
                const next = responses[i++];
                if (next === undefined) throw new Error("no more scripted responses");
                return next;
            },
        },
    };
}

/** The tool_result blocks of the last request, by tool_use id. */
function toolResults(request: Anthropic.MessageCreateParamsNonStreaming): Map<string, { content: string; isError: boolean }> {
    const last = request.messages[request.messages.length - 1]!;
    const out = new Map<string, { content: string; isError: boolean }>();
    if (Array.isArray(last.content)) {
        for (const block of last.content) {
            if (block.type === "tool_result") {
                out.set(block.tool_use_id, { content: String(block.content), isError: block.is_error === true });
            }
        }
    }
    return out;
}

const EDIT_A = { path: "src/a.ts", old_string: "export const a = 1;", new_string: "export const a = 42;" };

function opts(partial: Partial<AgentRunOptions> & Pick<AgentRunOptions, "role">): AgentRunOptions {
    return { task: "do the task", dryRun: true, isolate: false, approval: "deny", ...partial };
}

test("reviewer: read-only tools, a parsed finding, nothing written", async () => {
    const root = await makeRepo();
    try {
        await fs.writeFile(path.join(root, "src/a.ts"), "export const a = 1 + 0;\n");
        const { client, requests } = scripted([
            message([toolUse("t1", "read_file", { path: "src/a.ts" }), toolUse("t2", "edit_file", EDIT_A)], "tool_use"),
            message([text("error src/a.ts:1 - Adds zero for no reason. Remove it.\nwarning src/b.ts:1 - Unused export. Delete it.")], "end_turn"),
        ]);
        const events: AgentEvent[] = [];
        const result = await runAgent(root, opts({ role: "reviewer", task: "review my changes" }), {
            client,
            ai: AI,
            now: FIXED,
            onEvent: (e) => events.push(e),
        });

        assert.equal(result.status, "completed", result.reason ?? "");
        assert.equal(result.model, MODEL);
        assert.equal(result.turns, 2);
        // Only read tools are offered; edit_file is not among them.
        const offered = (requests[0]!.tools ?? []).map((t) => (t as Anthropic.Tool).name);
        assert.deepEqual(offered, ["read_file", "list_files", "search", "git_diff"]);
        // The system prompt carries the role and the diff.
        const system = JSON.stringify(requests[0]!.system);
        assert.match(system, /reviewer agent/);
        assert.match(system, /1 \+ 0/);
        const results = toolResults(requests[1]!);
        assert.match(results.get("t1")!.content, /export const a = 1 \+ 0;/);
        assert.equal(results.get("t2")!.isError, true);
        assert.match(results.get("t2")!.content, /unknown tool/);
        assert.equal(await fs.readFile(path.join(root, "src/a.ts"), "utf8"), "export const a = 1 + 0;\n");
        assert.deepEqual(result.changes, []);
        assert.equal(result.safety?.dryRun, true);
        assert.equal(result.safety?.checks, 1);
        assert.ok(events.some((e) => e.type === "start"));
        assert.ok(events.some((e) => e.type === "tool-call" && e.tool === "read_file"));

        const outcome = agentRouteOutcome(result);
        assert.equal(outcome.status, "failed");
        assert.equal(outcome.findings.length, 2);
        assert.deepEqual(
            outcome.findings.map((f) => [f.severity, f.file, f.line, f.title, f.rule]),
            [
                ["error", "src/a.ts", 1, "Adds zero for no reason", "agent:reviewer"],
                ["warning", "src/b.ts", 1, "Unused export", "agent:reviewer"],
            ],
        );
        assert.match(outcome.answer!, /Adds zero/);
        assert.match(outcome.summary, /reviewer agent finished; 2 tool calls; 2 findings/);
    } finally {
        await cleanup(root);
    }
});

test("fixer dry run: proposes the change with a patch, writes nothing", async () => {
    const root = await makeRepo();
    try {
        const { client, requests } = scripted([
            message([toolUse("t1", "edit_file", EDIT_A)], "tool_use"),
            message([text("Changed a to 42 in src/a.ts.")], "end_turn"),
        ]);
        let prompted = false;
        const result = await runAgent(root, opts({ role: "fixer", dryRun: true, approval: "deny" }), {
            client,
            ai: AI,
            prompter: async () => {
                prompted = true;
                return true;
            },
        });
        assert.equal(result.status, "completed", result.reason ?? "");
        assert.equal(prompted, false);
        assert.equal(await fs.readFile(path.join(root, "src/a.ts"), "utf8"), "export const a = 1;\n");
        assert.equal(result.changes.length, 1);
        assert.equal(result.changes[0]!.path, "src/a.ts");
        assert.match(result.changes[0]!.patch ?? "", /\+export const a = 42;/);
        assert.match(toolResults(requests[1]!).get("t1")!.content, /dry run: would change src\/a.ts/);
        const offered = (requests[0]!.tools ?? []).map((t) => (t as Anthropic.Tool).name);
        assert.ok(offered.includes("edit_file") && offered.includes("run_check"));
        assert.equal(result.safety?.checks, 1);
        assert.equal(result.safety?.denied, 0);
        assert.equal(result.safety?.approved, 0, "a dry run records changes without asking for approval");
        assert.equal(result.worktree, undefined);
        assert.match(agentSummaryLine(result), /1 change proposed \(dry run\)/);
        assert.equal(agentRouteOutcome(result).status, "succeeded");
    } finally {
        await cleanup(root);
    }
});

test("fixer --apply --isolate: writes in a worktree, never in the user's tree", async () => {
    const root = await makeRepo();
    try {
        // An uncommitted change of the user's, carried into the worktree.
        await fs.writeFile(path.join(root, "src/b.ts"), "export const b = 3;\n");
        const statusBefore = git(root, "status", "--porcelain");
        const branchBefore = git(root, "branch", "--show-current");
        const { client } = scripted([
            message([toolUse("t1", "read_file", { path: "src/b.ts" }), toolUse("t2", "edit_file", EDIT_A)], "tool_use"),
            message([text("Fixed src/a.ts.")], "end_turn"),
        ]);
        const events: AgentEvent[] = [];
        const result = await runAgent(root, opts({ role: "fixer", dryRun: false, isolate: true, approval: "auto" }), {
            client,
            ai: AI,
            now: FIXED,
            onEvent: (e) => events.push(e),
        });

        assert.equal(result.status, "completed", result.reason ?? "");
        assert.ok(result.worktree, "the worktree is kept when it holds changes");
        assert.equal(result.worktree!.branch, "tyr/fixer-20261118-090807");
        assert.equal(result.safety?.isolate, true);
        // The user's tree, branch and status are untouched.
        assert.equal(await fs.readFile(path.join(root, "src/a.ts"), "utf8"), "export const a = 1;\n");
        assert.equal(await fs.readFile(path.join(root, "src/b.ts"), "utf8"), "export const b = 3;\n");
        assert.equal(git(root, "branch", "--show-current"), branchBefore);
        assert.equal(git(root, "status", "--porcelain"), statusBefore);
        // The worktree has the user's change and the agent's edit; its unstaged
        // diff is only the agent's.
        const wt = result.worktree!.path;
        assert.equal(await fs.readFile(path.join(wt, "src/a.ts"), "utf8"), "export const a = 42;\n");
        assert.equal(await fs.readFile(path.join(wt, "src/b.ts"), "utf8"), "export const b = 3;\n");
        assert.equal(git(wt, "diff", "--name-only"), "src/a.ts");
        assert.ok(events.some((e) => e.type === "worktree" && e.carried === 1));
        assert.match(agentSummaryLine(result), /1 change on tyr\/fixer-/);
        const listed = await listAgentWorktrees(root);
        assert.ok(!("error" in listed) && listed.length === 1);
    } finally {
        await cleanup(root);
    }
});

test("an isolated run that changes nothing removes its worktree and branch", async () => {
    const root = await makeRepo();
    try {
        const { client } = scripted([message([text("Nothing to fix.")], "end_turn")]);
        const result = await runAgent(root, opts({ role: "fixer", dryRun: false, isolate: true, approval: "auto" }), { client, ai: AI, now: FIXED });
        assert.equal(result.status, "completed");
        assert.equal(result.worktree, undefined);
        assert.ok(result.notes?.some((n) => /worktree was removed/.test(n)));
        const listed = await listAgentWorktrees(root);
        assert.deepEqual(listed, []);
        assert.equal(git(root, "branch", "--list", "tyr/*"), "");
    } finally {
        await cleanup(root);
    }
});

test("no API key: skipped before any request; nobody to approve: denied before any request", async () => {
    const root = await makeRepo();
    try {
        const { client, requests } = scripted([]);
        const skipped = await runAgent(root, opts({ role: "reviewer" }), { client, env: { TYR_CONFIG_HOME: CONFIG_HOME } });
        assert.equal(skipped.status, "skipped");
        assert.match(skipped.reason ?? "", /no API key/);
        assert.match(agentSummaryLine(skipped), /Cannot run the reviewer agent: no API key/);
        assert.equal(agentRouteOutcome(skipped).status, "error");

        const denied = await runAgent(root, opts({ role: "fixer", dryRun: false, approval: "deny" }), {
            client,
            ai: AI,
            explanation: "no terminal to approve changes: pass --yes or --isolate to apply them",
        });
        assert.equal(denied.status, "denied");
        assert.match(denied.reason ?? "", /--yes or --isolate/);
        assert.equal(requests.length, 0);

        const unknown = await runAgent(root, opts({ role: "nope" as never }), { client, ai: AI });
        assert.equal(unknown.status, "error");
        assert.equal(requests.length, 0);
    } finally {
        await cleanup(root);
    }
});

test("correct: the summary is queued as an agent correction", async () => {
    const root = await makeRepo();
    try {
        const { client } = scripted([message([text("error src/a.ts:1 - Wrong constant. Use 42.")], "end_turn")]);
        const result = await runAgent(root, opts({ role: "reviewer" }), { client, ai: AI, correct: true });
        assert.ok(result.correctionId);
        const pending = await pendingCorrections(root);
        assert.equal(pending.length, 1);
        assert.equal(pending[0]!.source, "agent");
        assert.equal(pending[0]!.severity, "error");
        assert.match(pending[0]!.message, /reviewer agent: error src\/a.ts:1/);
    } finally {
        await cleanup(root);
    }
});

test("parseAgentFindings reads only well-formed finding lines", () => {
    const findings = parseAgentFindings(
        [
            "- critical lib/x.py:10 - SQL built from input. Use parameters.",
            "info README.md - Mentions a removed flag",
            "No problems found.",
            "error but no location here",
        ].join("\n"),
        "reviewer",
    );
    assert.deepEqual(
        findings.map((f) => [f.severity, f.file, f.line, f.title, f.detail]),
        [
            ["critical", "lib/x.py", 10, "SQL built from input", "Use parameters."],
            ["info", "README.md", undefined, "Mentions a removed flag", undefined],
        ],
    );
});

test("executeRun with an agent delegate records the run like any route", async () => {
    const root = await makeRepo();
    try {
        const { client } = scripted([message([text("No problems found. Checked src/.")], "end_turn")]);
        const result = await executeRun(root, "review my changes", {
            agent: {
                role: "reviewer",
                run: async (task) => agentRouteOutcome(await runAgent(root, opts({ role: "reviewer", task }), { client, ai: AI })),
            },
        });
        assert.equal(result.status, "succeeded");
        assert.deepEqual(result.intent, { mode: "agent", role: "reviewer", task: "review my changes" });
        assert.equal(result.answer, "No problems found. Checked src/.");
        assert.equal(result.model, MODEL);
        assert.equal((result.agent as AgentRunResult).status, "completed");
        assert.ok(result.report !== null);
        const report = await readReport(root, result.report!.id);
        assert.equal(report?.kind, "run");
        assert.match(report?.summary ?? "", /run the reviewer agent/);
        const events = await readEvents(root);
        assert.ok(events.some((e) => e.kind === "run.completed" && (e.data as { mode?: string }).mode === "agent"));

        const thrown = await executeRun(root, "boom", {
            agent: {
                role: "fixer",
                run: async () => {
                    throw new Error("delegate exploded");
                },
            },
        });
        assert.equal(thrown.status, "error");
        assert.match(thrown.summary, /delegate exploded/);
        assert.equal(thrown.agent, null);
    } finally {
        await cleanup(root);
    }
});
