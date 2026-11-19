// agents/context.ts: repo context from tyr.json, docs, git and .tyr/state,
// bounded by budgets, degrading to empty sections; prompt assembly.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildAgentContext, buildSystemPrompt, buildTaskMessage, profileJson } from "../cli/agents/context.js";
import type { AgentContext } from "../cli/agents/model.js";
import { ROLES } from "../cli/agents/roles.js";
import type { TyrConfig } from "../cli/core/types.js";
import { engineStateFile } from "../cli/engine/repo-state.js";
import { findingsStateFile } from "../cli/engine/review.js";
import { makeProject, removeProject } from "./helpers.js";

function git(root: string, ...args: string[]): string {
    return execFileSync("git", ["-c", "user.name=Tyr", "-c", "user.email=tyr@example.com", "-c", "commit.gpgsign=false", ...args], {
        cwd: root,
        encoding: "utf8",
    }).trim();
}

const CONFIG = {
    version: 3,
    tyrVersion: "1.0.0",
    initializedAt: "2026-01-01T00:00:00.000Z",
    project: {
        name: "fixture",
        root: ".",
        primaryLanguage: "TypeScript",
        languages: [{ name: "TypeScript", files: 3, percentage: 100 }],
        frameworks: ["node:test"],
        packageManager: "npm",
        fileCount: 3,
        workspace: null,
    },
    commands: {
        build: null,
        test: { command: "npm test", source: "package.json" },
        lint: null,
        format: null,
        typecheck: { command: "npx tsc --noEmit", source: "tsconfig.json" },
    },
    docs: { readme: "README.md", claudeMd: "CLAUDE.md" },
} as unknown as TyrConfig;

async function makeRepo(): Promise<string> {
    const root = await makeProject({
        "src/a.ts": "export const a = 1;\n",
        "src/b.ts": "export const b = 2;\n",
        "README.md": "# fixture\n\nUse tabs.\n",
        "CLAUDE.md": "Never throw for normal conditions.\n",
    });
    git(root, "init", "-q");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "initial");
    return root;
}

test("no repo, no tyr.json, no .tyr/state: empty sections, no throw", async () => {
    const root = await makeProject({ "notes.txt": "hi\n" });
    try {
        const ctx = await buildAgentContext(root);
        assert.deepEqual(ctx, { root, profile: "", conventions: "", diff: "", failures: "", omittedFiles: [] });
        const prompt = buildSystemPrompt(ROLES.reviewer, ctx);
        assert.ok(prompt.startsWith(ROLES.reviewer.instructions));
        assert.match(prompt, /No tyr\.json profile\./);
        assert.match(prompt, /documents no conventions/);
        assert.match(prompt, /No uncommitted changes\./);
        assert.match(prompt, /No failing checks or open findings/);
    } finally {
        await removeProject(root);
    }
});

test("the working-tree diff includes modified and untracked files but not .tyr/", async () => {
    const root = await makeRepo();
    try {
        await fs.writeFile(path.join(root, "src/a.ts"), "export const a = 42;\n");
        await fs.writeFile(path.join(root, "src/new.ts"), "export const fresh = true;\n");
        await fs.mkdir(path.join(root, ".tyr", "state"), { recursive: true });
        await fs.writeFile(path.join(root, ".tyr", "state", "noise.json"), "{}\n");

        const ctx = await buildAgentContext(root, { config: CONFIG });
        assert.match(ctx.diff, /\+export const a = 42;/);
        assert.match(ctx.diff, /\+export const fresh = true;/);
        assert.doesNotMatch(ctx.diff, /\.tyr/);
        assert.deepEqual(ctx.omittedFiles, []);
        assert.match(ctx.conventions, /<claude_md path="CLAUDE.md">\nNever throw/);
        assert.match(ctx.conventions, /<readme path="README.md">/);
        assert.ok(ctx.conventions.indexOf("<claude_md") < ctx.conventions.indexOf("<readme"));
        assert.equal(ctx.failures, "");
    } finally {
        await removeProject(root);
    }
});

test("a clean repo has an empty diff", async () => {
    const root = await makeRepo();
    try {
        const ctx = await buildAgentContext(root, { config: null });
        assert.equal(ctx.diff, "");
        assert.equal(ctx.profile, "");
        assert.match(ctx.conventions, /Use tabs/);
    } finally {
        await removeProject(root);
    }
});

test("budgets: the diff keeps whole files and lists the rest as omitted; docs are trimmed", async () => {
    const root = await makeRepo();
    try {
        await fs.writeFile(path.join(root, "src/a.ts"), "export const a = 'small';\n");
        await fs.writeFile(path.join(root, "src/b.ts"), Array.from({ length: 200 }, (_, i) => `export const b${i} = ${i};`).join("\n") + "\n");
        await fs.writeFile(path.join(root, "README.md"), Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n"));

        const ctx = await buildAgentContext(root, { config: CONFIG, maxDiffBytes: 600, maxDocBytes: 200 });
        assert.match(ctx.diff, /small/);
        // The long README rewrite is part of the diff too and does not fit either.
        assert.deepEqual([...ctx.omittedFiles].sort(), ["README.md", "src/b.ts"]);
        assert.ok(Buffer.byteLength(ctx.diff) <= 600);
        assert.match(ctx.conventions, /\[\.\.\. trimmed \.\.\.\]/);

        const message = buildTaskMessage("  review it  ", ctx);
        assert.ok(message.startsWith("<task>\nreview it\n</task>"));
        assert.match(message, /- src\/b\.ts/);
    } finally {
        await removeProject(root);
    }
});

test("failures come from engine.json problems and findings.json, bounded", async () => {
    const root = await makeProject({});
    try {
        const run = {
            id: "r1",
            kind: "test",
            command: "npm test",
            cwd: root,
            trigger: { reason: "manual" },
            startedAt: "2026-01-01T00:00:00.000Z",
            finishedAt: "2026-01-01T00:00:05.000Z",
            durationMs: 5000,
            outcome: "failed",
            exitCode: 1,
            signal: null,
            outputTruncated: false,
            headCommit: null,
        };
        const engine = {
            version: 1,
            updatedAt: "2026-01-01T00:00:05.000Z",
            workingTree: null,
            checks: { test: { last: run, lastGood: { ...run, outcome: "passed", exitCode: 0, finishedAt: "2025-12-31T00:00:00.000Z" } } },
            problems: [
                {
                    key: "check:test",
                    kind: "test",
                    title: "test failed (exit 1)",
                    detail: "AssertionError: expected 1 to equal 2\n    at src/a.test.ts:7",
                    firstSeenRunId: "r1",
                    lastSeenRunId: "r1",
                    firstSeenAt: "2026-01-01T00:00:05.000Z",
                    lastSeenAt: "2026-01-01T00:00:05.000Z",
                    regression: true,
                },
            ],
        };
        await fs.mkdir(path.dirname(engineStateFile(root)), { recursive: true });
        await fs.writeFile(engineStateFile(root), JSON.stringify(engine));
        const findings = Array.from({ length: 5 }, (_, i) => ({
            source: "llm",
            severity: i === 3 ? "error" : "warning",
            title: `finding ${i}`,
            detail: "why it matters",
            file: "src/a.ts",
            line: i + 1,
            rule: "llm/bug",
            fingerprint: `fp${i}`,
        }));
        await fs.writeFile(findingsStateFile(root), JSON.stringify({ version: 1, updatedAt: "2026-01-01T00:00:06.000Z", findings, reportId: null }));

        const ctx = await buildAgentContext(root, { config: null, maxFindings: 2 });
        assert.match(ctx.failures, /check test: failed \(`npm test`, exit 1, .*last passed 2025-12-31/);
        assert.match(ctx.failures, /open problem check:test \(regression\): test failed \(exit 1\)/);
        assert.match(ctx.failures, /AssertionError: expected 1 to equal 2/);
        assert.match(ctx.failures, /open findings \(5, showing 2\):/);
        // Most severe first.
        assert.match(ctx.failures, /- error src\/a\.ts:4: finding 3 \[llm\/bug\]/);
        assert.doesNotMatch(ctx.failures, /finding 4/);

        const small = await buildAgentContext(root, { config: null, maxFailureBytes: 80 });
        assert.ok(Buffer.byteLength(small.failures) <= 80 + "\n[... trimmed ...]".length);
        assert.match(small.failures, /\[\.\.\. trimmed \.\.\.\]$/);
    } finally {
        await removeProject(root);
    }
});

test("malformed state files degrade to an empty failures section", async () => {
    const root = await makeProject({ ".tyr/state/engine.json": "{not json", ".tyr/state/findings.json": "[]" });
    try {
        const ctx = await buildAgentContext(root, { config: null });
        assert.equal(ctx.failures, "");
    } finally {
        await removeProject(root);
    }
});

test("overrides replace the gathered diff and failures, within budget", async () => {
    const root = await makeRepo();
    try {
        await fs.writeFile(path.join(root, "src/a.ts"), "export const a = 'ignored';\n");
        const ctx = await buildAgentContext(root, {
            config: null,
            diff: "diff --git a/x b/x\n+custom line\n",
            failures: "line one\nline two\nline three\n",
            maxFailureBytes: 18,
        });
        assert.equal(ctx.diff, "diff --git a/x b/x\n+custom line\n");
        assert.equal(ctx.failures, "line one\nline two\n[... trimmed ...]");
        assert.deepEqual(ctx.omittedFiles, []);
    } finally {
        await removeProject(root);
    }
});

test("profileJson is compact JSON of stable fields only", () => {
    const json = profileJson(CONFIG);
    const parsed = JSON.parse(json);
    assert.deepEqual(parsed, {
        name: "fixture",
        primaryLanguage: "TypeScript",
        languages: ["TypeScript"],
        frameworks: ["node:test"],
        packageManager: "npm",
        commands: { typecheck: "npx tsc --noEmit", test: "npm test" },
    });
    assert.doesNotMatch(json, /2026|initializedAt|fileCount/);
    assert.ok(!json.includes("\n"));
});

test("buildSystemPrompt: instructions first, sections in fixed order, deterministic, no absolute root", () => {
    const ctx: AgentContext = {
        root: "/abs/somewhere/repo",
        profile: '{"name":"x"}',
        conventions: '<readme path="README.md">\nhello\n</readme>',
        diff: "diff --git a/f b/f",
        failures: "check test: failed",
        omittedFiles: [],
    };
    for (const role of Object.values(ROLES)) {
        const prompt = buildSystemPrompt(role, ctx);
        assert.ok(prompt.startsWith(role.instructions));
        const order = ["<repository_context>", "<project_profile>", "<conventions>", "<diff>", "<failures>", "</repository_context>"].map((tag) =>
            prompt.indexOf(tag),
        );
        assert.ok(order.every((i) => i > 0));
        assert.deepEqual(
            [...order].sort((a, b) => a - b),
            order,
        );
        assert.equal(prompt, buildSystemPrompt(role, { ...ctx }));
        assert.ok(!prompt.includes(ctx.root));
    }
    // The stable prefix (instructions through conventions) does not depend on the diff.
    const a = buildSystemPrompt(ROLES.fixer, ctx);
    const b = buildSystemPrompt(ROLES.fixer, { ...ctx, diff: "something else", failures: "" });
    const prefix = a.slice(0, a.indexOf("<diff>"));
    assert.ok(b.startsWith(prefix));
});
