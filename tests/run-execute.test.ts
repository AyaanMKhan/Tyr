// run.ts: executeRun end to end against temp repos initialized by the real
// `tyr init` — each route, what gets recorded (state.json, events, a run
// report), and what must not change (findings.json on a partial pass).

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import { readEvents } from "../cli/core/events.js";
import { readReport } from "../cli/core/reports.js";
import { readState, resolveTyrPaths } from "../cli/core/scaffold.js";
import type { AskMessagesClient } from "../cli/engine/ask.js";
import { findingsStateFile } from "../cli/engine/review.js";
import { executeRun } from "../cli/engine/run.js";
import { makeProject, removeProject } from "./helpers.js";

const CLI = fileURLToPath(new URL("../cli/index.js", import.meta.url));

// Every test file runs in its own process: keep the user's global config and
// keys out of settings resolution, which reads process.env.
const CONFIG_HOME = await fs.mkdtemp(path.join(os.tmpdir(), "tyr-run-home-"));
process.env.TYR_CONFIG_HOME = CONFIG_HOME;
delete process.env.TYR_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.TYR_REVIEW_LLM;

const PASS = `node -e "process.exit(0)"`;
const FAIL = `node -e "console.error('src/index.ts:1:7: error: boom'); process.exit(1)"`;

function git(root: string, ...args: string[]): string {
    return execFileSync("git", ["-c", "user.name=Tyr", "-c", "user.email=tyr@example.com", "-c", "commit.gpgsign=false", ...args], {
        cwd: root,
        encoding: "utf8",
    }).trim();
}

/** A git repo initialized by `tyr init`, with check commands replaced by `commands`. */
async function makeRepo(commands: Partial<Record<"build" | "test" | "lint" | "typecheck" | "format", string | null>>): Promise<string> {
    const root = await makeProject({
        "package.json": JSON.stringify({ name: "run-fixture" }),
        "src/index.ts": "export const a = 1;\n",
        "README.md": "# fixture\n",
    });
    git(root, "init", "-q");
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
    for (const kind of ["build", "test", "lint", "typecheck", "format"] as const) config.commands[kind] = null;
    for (const [kind, command] of Object.entries(commands)) {
        config.commands[kind] = command === null ? null : { command, tool: "node", evidence: "package.json", source: "user" };
    }
    await fs.writeFile(configFile, `${JSON.stringify(config, null, 4)}\n`);
    return root;
}

async function exists(file: string): Promise<boolean> {
    return fs.access(file).then(
        () => true,
        () => false,
    );
}

test("checks route: runs only the named checks and records the run", async () => {
    const root = await makeRepo({ build: PASS, test: FAIL, lint: PASS });
    try {
        const stateBefore = await readState(root);
        const started: string[] = [];
        const done: string[] = [];
        const result = await executeRun(root, "run the tests", {
            onCheckStart: (s) => started.push(s.kind),
            onCheckDone: (r) => done.push(`${r.kind}:${r.outcome}`),
        });
        assert.deepEqual(result.intent, { mode: "checks", checks: ["test"], all: false });
        assert.equal(result.status, "failed");
        assert.deepEqual(started, ["test"]);
        assert.deepEqual(done, ["test:failed"]);
        assert.equal(result.checks.length, 1);
        assert.equal(result.checks[0]!.exitCode, 1);
        assert.match(result.summary, /0\/1 checks passed; failed: test/);
        assert.ok(result.findings.length >= 1, JSON.stringify(result.findings));
        assert.equal(result.counts.error >= 1, true);

        // A partial pass leaves the engine's findings record alone.
        assert.equal(await exists(findingsStateFile(root)), false);

        const state = await readState(root);
        assert.equal(state?.runCount, (stateBefore?.runCount ?? 0) + 1);
        assert.equal(state?.lastRunAt, result.startedAt);

        const events = await readEvents(root, { kinds: ["run"] });
        assert.deepEqual(
            events.map((e) => e.kind),
            ["run.started", "run.completed"],
        );
        assert.equal(events[0]!.id, result.id);
        assert.equal(events[1]!.data?.status, "failed");

        assert.ok(result.report !== null);
        const report = await readReport(root, result.report!.id);
        assert.equal(report?.kind, "run");
        assert.equal(report?.title, "run the tests");
        assert.equal(report?.data?.status, "failed");
        assert.match(await fs.readFile(result.report!.mdFile, "utf8"), /Prompt: run the tests/);
    } finally {
        await removeProject(root);
    }
});

test("checks route: every check runs the full engine pass, review included", async () => {
    const root = await makeRepo({ build: FAIL, test: PASS, lint: PASS });
    try {
        const skipped: string[] = [];
        const result = await executeRun(root, "check everything", { onCheckSkip: (kind) => skipped.push(kind) });
        assert.equal(result.intent.mode, "checks");
        assert.equal(result.status, "failed");
        assert.deepEqual(
            result.checks.map((c) => `${c.kind}:${c.outcome}`),
            ["build:failed", "lint:passed"],
        );
        // test is skipped when the build fails
        assert.deepEqual(result.skipped, ["test"]);
        assert.deepEqual(skipped, ["test"]);
        assert.equal(await exists(findingsStateFile(root)), true);
    } finally {
        await removeProject(root);
    }
});

test("checks route: nothing configured is an error", async () => {
    const root = await makeRepo({});
    try {
        const result = await executeRun(root, "run the tests");
        assert.equal(result.status, "error");
        assert.match(result.summary, /test is not configured/);
        assert.equal(result.checks.length, 0);
        assert.ok(result.report !== null);
    } finally {
        await removeProject(root);
    }
});

test("review route: reviews uncommitted changes with the diff rules", async () => {
    const root = await makeRepo({});
    try {
        await fs.writeFile(path.join(root, "src", "secrets.ts"), `export const key = "AKIAQWERTYUIOPASDFGH";\n`);
        let reviewInfo: { llm: boolean; scope: string } | null = null;
        const result = await executeRun(root, "review my changes", { onReviewStart: (info) => (reviewInfo = info) });
        assert.deepEqual(result.intent, { mode: "review", scope: "working-tree" });
        assert.deepEqual(reviewInfo, { llm: false, scope: "uncommitted changes" });
        assert.ok(result.findings.some((f) => (f.rule ?? "").includes("secret")), JSON.stringify(result.findings));
        assert.equal(result.status, "failed");
        assert.match(result.summary, /Reviewed uncommitted changes \(1 file/);
        assert.match(result.summary, /diff rules only/);
        assert.ok(result.notes.some((n) => /no API key/.test(n)));
        // Tyr's own files are not reviewed, and the engine's record is untouched.
        assert.equal(await exists(findingsStateFile(root)), false);
    } finally {
        await removeProject(root);
    }
});

test("review route: the last commit, and nothing to review", async () => {
    const root = await makeRepo({});
    try {
        const none = await executeRun(root, "review my last commit", { llm: false });
        assert.equal(none.status, "error");
        assert.match(none.summary, /no previous commit/);

        await fs.writeFile(path.join(root, "src", "b.ts"), "export const b = 2;\n");
        git(root, "add", "src/b.ts");
        git(root, "commit", "-q", "-m", "add b");
        const result = await executeRun(root, "review the last commit", { llm: false });
        assert.equal(result.status, "succeeded", result.summary);
        assert.match(result.summary, /Reviewed the last commit \(1 file, \+1\/-0\)/);
        assert.equal(result.notes.length, 0);

        const clean = await executeRun(root, "review my changes", { llm: false });
        assert.equal(clean.status, "succeeded");
        assert.match(clean.summary, /Nothing to review/);
    } finally {
        await removeProject(root);
    }
});

test("ask route: streams the answer and keeps it in the report", async () => {
    const root = await makeRepo({});
    process.env.TYR_API_KEY = "sk-ant-test-key-123456";
    try {
        const client: AskMessagesClient = {
            stream() {
                const events = ["It ", "works."].map(
                    (text) =>
                        ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }) as unknown as Anthropic.MessageStreamEvent,
                );
                return {
                    async *[Symbol.asyncIterator]() {
                        yield* events;
                    },
                    finalMessage: async () =>
                        ({
                            content: [{ type: "text", text: "It works." }],
                            stop_reason: "end_turn",
                            usage: { input_tokens: 10, output_tokens: 3 },
                        }) as unknown as Anthropic.Message,
                };
            },
        };
        const text: string[] = [];
        const result = await executeRun(root, "does it work?", { askClient: client, onText: (t) => text.push(t) });
        assert.equal(result.intent.mode, "ask");
        assert.equal(result.status, "succeeded");
        assert.equal(result.answer, "It works.");
        assert.deepEqual(text, ["It ", "works."]);
        assert.equal(result.model, "claude-opus-5-5");
        const md = await fs.readFile(result.report!.mdFile, "utf8");
        assert.match(md, /It works\./);
    } finally {
        delete process.env.TYR_API_KEY;
        await removeProject(root);
    }
});

test("ask route: no API key is an error with a hint", async () => {
    const root = await makeRepo({});
    try {
        const result = await executeRun(root, "why?");
        assert.equal(result.status, "error");
        assert.match(result.summary, /Cannot answer: no API key/);
        assert.equal(result.answer, null);
    } finally {
        await removeProject(root);
    }
});

test("cleanup", async () => {
    await fs.rm(CONFIG_HOME, { recursive: true, force: true });
});
