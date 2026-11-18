// Correcting a live Claude Code session (cli/agents/coordinate.ts): the
// corrections queue, derivation from engine.json / findings.json, hook reply
// shapes per event and mode, the Stop loop guard and size bounds, and the
// `tyr hook` wiring (cli/commands/hooks.ts).

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
    DEFAULT_MAX_STOP_BLOCKS,
    MAX_CORRECTION_CHARS,
    clearCorrections,
    correctionsFile,
    correctionsFromState,
    deriveCorrections,
    emptyCorrectionsState,
    hookResponse,
    markDelivered,
    pendingCorrections,
    queueCorrection,
    readCorrections,
    respondToHook,
    type Correction,
    type CorrectionsState,
    type DerivedCorrections,
} from "../cli/agents/coordinate.js";
import { answerHookPayload } from "../cli/commands/hooks.js";
import { makeFinding, type EngineFinding } from "../cli/engine/findings.js";
import type { CheckKind, CheckOutcome, CheckRun, EngineState } from "../cli/engine/model.js";
import { applyCheckRun, emptyEngineState, writeEngineState } from "../cli/engine/repo-state.js";
import { FINDINGS_STATE_VERSION, findingsStateFile, type FindingsState } from "../cli/engine/review.js";
import { makeProject, removeProject } from "./helpers.js";

const T0 = new Date("2026-11-18T10:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

let counter = 0;
function run(kind: CheckKind, outcome: CheckOutcome, extra: Partial<CheckRun> = {}): CheckRun {
    counter += 1;
    const when = at(counter).toISOString();
    return {
        id: `run-${counter}`,
        kind,
        command: `npm run ${kind}`,
        cwd: "/project",
        trigger: { reason: "manual" },
        startedAt: when,
        finishedAt: when,
        durationMs: 10,
        outcome,
        exitCode: outcome === "passed" ? 0 : outcome === "failed" ? 2 : null,
        signal: null,
        stdout: "",
        stderr: outcome === "failed" ? "line one\nline two\nerror: boom\n" : "",
        outputTruncated: false,
        headCommit: null,
        ...extra,
    };
}

function findingsState(findings: EngineFinding[]): FindingsState {
    return { version: FINDINGS_STATE_VERSION, updatedAt: T0.toISOString(), findings, reportId: null };
}

const TS_ERROR = makeFinding({
    source: "check",
    checkKind: "typecheck",
    severity: "error",
    title: "TS2322: Type 'string' is not assignable to type 'number'.",
    file: "src/a.ts",
    line: 12,
});
const SECRET = makeFinding({ source: "diff", severity: "critical", title: "Possible API key committed", file: "src/config.ts", line: 3, rule: "secret" });
const STYLE = makeFinding({ source: "llm", severity: "warning", title: "Prefer const", file: "src/b.ts", line: 1 });

/** typecheck passed, then failed (a regression); test failed from the start. */
function engineWithProblems(): EngineState {
    let state = emptyEngineState();
    state = applyCheckRun(state, run("typecheck", "passed"), T0);
    state = applyCheckRun(state, run("typecheck", "failed"), T0);
    state = applyCheckRun(state, run("test", "failed"), T0);
    return state;
}

async function initProject(): Promise<string> {
    return makeProject({ "package.json": "{}", ".tyr/tyr.json": "{}" });
}

async function writeFindings(root: string, state: FindingsState): Promise<void> {
    await fs.mkdir(path.dirname(findingsStateFile(root)), { recursive: true });
    await fs.writeFile(findingsStateFile(root), JSON.stringify(state), "utf8");
}

function correction(overrides: Partial<Correction> = {}): Correction {
    counter += 1;
    return {
        id: `c-${counter}`,
        createdAt: at(counter).toISOString(),
        source: "check",
        severity: "error",
        message: "typecheck failed: src/a.ts:12 TS2322",
        fingerprint: `fp-${counter}`,
        deliveries: 0,
        ...overrides,
    };
}

const SESSION = { session_id: "s1", cwd: "/project", transcript_path: "/t.jsonl" };

/* -------------------------------------------------------------------------
 * Queue
 * ---------------------------------------------------------------------- */

test("queueCorrection persists, dedupes by fingerprint and respects delivery", async () => {
    const root = await initProject();
    try {
        assert.deepEqual(await pendingCorrections(root), []);
        assert.equal(await queueCorrection(root, { message: "   " }), null);

        const first = await queueCorrection(root, { message: "Stop editing   generated files\nin dist/" }, { now: T0 });
        assert.ok(first);
        assert.equal(first.source, "user");
        assert.equal(first.severity, "error");
        assert.equal(first.message, "Stop editing generated files in dist/");
        assert.equal(first.deliveries, 0);

        // Same message: same fingerprint, same correction.
        const again = await queueCorrection(root, { message: "Stop editing generated files in dist/" });
        assert.equal(again?.id, first.id);
        assert.equal((await readCorrections(root)).corrections.length, 1);

        const scoped = await queueCorrection(root, { message: "Only for s2", source: "agent", severity: "warning", sessionId: "s2" });
        assert.equal((await pendingCorrections(root, "s1")).length, 1);
        assert.deepEqual((await pendingCorrections(root, "s2")).map((c) => c.id), [first.id, scoped!.id]);
        assert.equal((await pendingCorrections(root)).length, 2);

        assert.equal(await markDelivered(root, [first.id, "nope"], { now: at(5) }), 1);
        const delivered = (await readCorrections(root)).corrections.find((c) => c.id === first.id)!;
        assert.equal(delivered.deliveredAt, at(5).toISOString());
        assert.equal(delivered.deliveries, 1);
        assert.deepEqual((await pendingCorrections(root, "s1")).map((c) => c.id), []);

        // Delivered duplicates are not re-queued unless asked.
        await queueCorrection(root, { message: "Stop editing generated files in dist/" });
        assert.equal((await pendingCorrections(root, "s1")).length, 0);
        await queueCorrection(root, { message: "Stop editing generated files in dist/" }, { requeue: true });
        assert.equal((await pendingCorrections(root, "s1")).length, 1);

        // Secrets never land in the queue; messages are bounded.
        const secret = await queueCorrection(root, { message: `use key sk-ant-abcdefghijklmnop ${"x".repeat(2000)}` });
        assert.doesNotMatch(secret!.message, /abcdefghijklmnop/);
        assert.ok(secret!.message.length <= MAX_CORRECTION_CHARS);

        assert.equal(await clearCorrections(root, { source: "agent" }), 1);
        assert.equal(await clearCorrections(root), 2);
        assert.deepEqual((await readCorrections(root)).corrections, []);
    } finally {
        await removeProject(root);
    }
});

test("a corrupt or foreign corrections.json reads as empty", async () => {
    const root = await initProject();
    try {
        await fs.mkdir(path.dirname(correctionsFile(root)), { recursive: true });
        await fs.writeFile(correctionsFile(root), "{not json", "utf8");
        assert.deepEqual((await readCorrections(root)).corrections, []);
        await fs.writeFile(correctionsFile(root), JSON.stringify({ version: 99, corrections: [correction()] }), "utf8");
        assert.deepEqual((await readCorrections(root)).corrections, []);
        // Bad entries are dropped, good ones kept.
        await fs.writeFile(correctionsFile(root), JSON.stringify({ version: 1, corrections: [correction(), { id: 3 }], sessions: [] }), "utf8");
        assert.equal((await readCorrections(root)).corrections.length, 1);
    } finally {
        await removeProject(root);
    }
});

/* -------------------------------------------------------------------------
 * Derivation
 * ---------------------------------------------------------------------- */

test("deriveCorrections: problems with file:line, serious review findings only", () => {
    const engine = engineWithProblems();
    const derived = deriveCorrections(engine, findingsState([TS_ERROR, SECRET, STYLE]));
    assert.deepEqual(derived.authoritative, ["check", "review"]);
    const [typecheck, testProblem, secret, ...rest] = derived.corrections;
    assert.equal(rest.length, 0, "the warning-level LLM finding and the check finding are not queued on their own");

    assert.equal(typecheck!.source, "check");
    assert.equal(typecheck!.severity, "error", "regressions are errors");
    assert.match(typecheck!.message, /^typecheck failed \(exit 2\) \(a regression: it passed before\): src\/a\.ts:12 TS2322/);
    assert.match(typecheck!.message, /Reproduce with `npm run typecheck`\.$/);
    assert.match(typecheck!.fingerprint, /^problem:check:typecheck:run-/);

    assert.equal(testProblem!.severity, "warning", "a check that never passed is pre-existing");
    assert.match(testProblem!.message, /line one \| line two \| error: boom/);

    assert.equal(secret!.source, "review");
    assert.equal(secret!.severity, "critical");
    assert.equal(secret!.message, "src/config.ts:3 Possible API key committed.");
    assert.equal(secret!.fingerprint, `finding:${SECRET.fingerprint}`);

    // No findings.json: problems only, and review corrections are not resolved.
    assert.deepEqual(deriveCorrections(engine, null).authoritative, ["check"]);
});

test("correctionsFromState queues once, never re-queues delivered, resolves and re-opens", async () => {
    const root = await initProject();
    try {
        let engine = engineWithProblems();
        await writeEngineState(root, engine);
        await writeFindings(root, findingsState([TS_ERROR, SECRET]));
        await queueCorrection(root, { message: "a user note" });

        const first = await correctionsFromState(root, { now: T0 });
        assert.equal(first.added.length, 3);
        const again = await correctionsFromState(root, { now: at(1) });
        assert.deepEqual([again.added.length, again.resolved.length], [0, 0]);

        const ids = (await pendingCorrections(root)).map((c) => c.id);
        assert.equal(ids.length, 4);
        await markDelivered(root, ids);
        await correctionsFromState(root, { now: at(2) });
        assert.deepEqual(await pendingCorrections(root), [], "still-open problems are not re-delivered");

        // typecheck passes: its correction resolves. The secret leaves findings.json: resolved too.
        engine = applyCheckRun(engine, run("typecheck", "passed"), T0);
        await writeEngineState(root, engine);
        await writeFindings(root, findingsState([TS_ERROR]));
        const fixed = await correctionsFromState(root, { now: at(3) });
        assert.deepEqual(fixed.resolved.map((c) => c.source).sort(), ["check", "review"]);
        assert.equal((await readCorrections(root)).corrections.length, 2, "the test problem and the user note remain");

        // It breaks again: a new problem, so a new correction.
        engine = applyCheckRun(engine, run("typecheck", "failed"), T0);
        await writeEngineState(root, engine);
        const reopened = await correctionsFromState(root, { now: at(4) });
        assert.equal(reopened.added.length, 1);
        assert.deepEqual((await pendingCorrections(root)).map((c) => c.source), ["check"]);
    } finally {
        await removeProject(root);
    }
});

/* -------------------------------------------------------------------------
 * Hook replies (pure)
 * ---------------------------------------------------------------------- */

test("hookResponse shapes per event and mode", () => {
    const pending = [correction({ severity: "warning", message: "lint: 3 problems" }), correction()];

    for (const event of ["UserPromptSubmit", "SessionStart", "PostToolUse"]) {
        const reply = hookResponse(event, { ...SESSION, hook_event_name: event }, pending, { mode: "context" });
        assert.ok(reply && "hookSpecificOutput" in reply, event);
        assert.equal(reply.hookSpecificOutput.hookEventName, event);
        const text = reply.hookSpecificOutput.additionalContext;
        // Most severe first.
        assert.ok(text.indexOf("[error] typecheck") < text.indexOf("[warning] lint"), text);
        assert.deepEqual(hookResponse(event, { hook_event_name: event }, pending, { mode: "block" }), reply);
    }

    // Stop: only blocks in block mode.
    assert.equal(hookResponse("Stop", { ...SESSION }, pending, { mode: "context" }), null);
    const block = hookResponse("Stop", { ...SESSION, stop_hook_active: false }, pending, { mode: "block" });
    assert.ok(block && "decision" in block);
    assert.equal(block.decision, "block");
    assert.match(block.reason, /typecheck failed/);
    assert.match(block.reason, /lint: 3 problems/);

    // Off, nothing pending, events Tyr does not answer, subagents: nothing.
    assert.equal(hookResponse("UserPromptSubmit", SESSION, pending, { mode: "off" }), null);
    assert.equal(hookResponse("UserPromptSubmit", SESSION, [], { mode: "context" }), null);
    for (const event of ["PreToolUse", "PostToolUseFailure", "Notification", "SubagentStop", "SessionEnd", "PreCompact"]) {
        assert.equal(hookResponse(event, SESSION, pending, { mode: "block" }), null, event);
    }
    assert.equal(hookResponse("PostToolUse", { ...SESSION, agent_id: "a1" }, pending, { mode: "context" }), null);

    // Only warnings pending: context yes, Stop block no.
    const warnings = [correction({ severity: "warning" })];
    assert.equal(hookResponse("Stop", SESSION, warnings, { mode: "block" }), null);
    assert.ok(hookResponse("UserPromptSubmit", SESSION, warnings, { mode: "block" }));
});

test("Stop loop guard: at most N blocks in a row, counting stop_hook_active", () => {
    const pending = [correction()];
    const opts = { mode: "block" as const, maxStopBlocks: 2 };
    assert.ok(hookResponse("Stop", SESSION, pending, { ...opts, consecutiveStopBlocks: 0 }));
    assert.ok(hookResponse("Stop", SESSION, pending, { ...opts, consecutiveStopBlocks: 1 }));
    assert.equal(hookResponse("Stop", SESSION, pending, { ...opts, consecutiveStopBlocks: 2 }), null);
    // stop_hook_active counts as one block already.
    assert.equal(hookResponse("Stop", { ...SESSION, stop_hook_active: true }, pending, { mode: "block", maxStopBlocks: 1 }), null);
    assert.ok(hookResponse("Stop", { ...SESSION, stop_hook_active: true }, pending, { mode: "block", maxStopBlocks: 2 }));
    assert.equal(DEFAULT_MAX_STOP_BLOCKS, 2);
});

test("reply text is bounded and says how many were left out", () => {
    const many = Array.from({ length: 50 }, (_, i) => correction({ message: `problem ${i} ${"y".repeat(500)}` }));
    for (const event of ["UserPromptSubmit", "Stop"]) {
        const reply = hookResponse(event, SESSION, many, { mode: "block", maxChars: 1500 });
        assert.ok(reply);
        const text = "decision" in reply ? reply.reason : reply.hookSpecificOutput.additionalContext;
        assert.ok(text.length <= 1500, `${event}: ${text.length}`);
        assert.match(text, /\+\d+ more \(run `tyr status`\)/);
    }
    const huge = hookResponse("UserPromptSubmit", SESSION, many, { mode: "context" });
    assert.ok(huge && "hookSpecificOutput" in huge && huge.hookSpecificOutput.additionalContext.length <= 4000);
});

/* -------------------------------------------------------------------------
 * respondToHook (state + reply)
 * ---------------------------------------------------------------------- */

const NO_DERIVED: DerivedCorrections = { corrections: [], authoritative: [] };

test("respondToHook delivers each correction once, then stays quiet", async () => {
    const root = await initProject();
    try {
        await writeEngineState(root, engineWithProblems());
        const deps = { mode: "context" as const, now: () => T0 };

        const prompt = await respondToHook(root, { ...SESSION, hook_event_name: "UserPromptSubmit", prompt: "hi" }, deps);
        assert.ok(prompt && "hookSpecificOutput" in prompt);
        assert.match(prompt.hookSpecificOutput.additionalContext, /typecheck failed/);
        assert.match(prompt.hookSpecificOutput.additionalContext, /test failed/);

        // Delivered: the next tool result and prompt add nothing.
        assert.equal(await respondToHook(root, { ...SESSION, hook_event_name: "PostToolUse", tool_name: "Read" }, deps), null);
        assert.equal(await respondToHook(root, { ...SESSION, hook_event_name: "UserPromptSubmit" }, deps), null);

        // A new session hears about what is still open.
        const start = await respondToHook(root, { ...SESSION, session_id: "s2", hook_event_name: "SessionStart", source: "startup" }, deps);
        assert.ok(start && "hookSpecificOutput" in start);
        assert.match(start.hookSpecificOutput.additionalContext, /open problems/);

        // A user correction shows up on the next tool result.
        await queueCorrection(root, { message: "Do not touch migrations/" });
        const tool = await respondToHook(root, { ...SESSION, hook_event_name: "PostToolUse" }, deps);
        assert.ok(tool && "hookSpecificOutput" in tool);
        assert.match(tool.hookSpecificOutput.additionalContext, /Do not touch migrations/);
        assert.doesNotMatch(tool.hookSpecificOutput.additionalContext, /typecheck/);

        // Off: nothing at all, and nothing written.
        await queueCorrection(root, { message: "another" });
        const before = await fs.readFile(correctionsFile(root), "utf8");
        assert.equal(await respondToHook(root, { ...SESSION, hook_event_name: "UserPromptSubmit" }, { mode: "off" }), null);
        assert.equal(await fs.readFile(correctionsFile(root), "utf8"), before);
    } finally {
        await removeProject(root);
    }
});

test("respondToHook Stop guard is persisted per session and reset by a prompt", async () => {
    const root = await initProject();
    try {
        const deps = { mode: "block" as const, now: () => T0, derive: async () => NO_DERIVED, maxStopBlocks: 2 };
        const stop = (active: boolean) => respondToHook(root, { ...SESSION, hook_event_name: "Stop", stop_hook_active: active }, deps);

        await queueCorrection(root, { message: "fix one" });
        assert.equal((await stop(false)) !== null, true);
        await queueCorrection(root, { message: "fix two" });
        assert.equal((await stop(true)) !== null, true);
        await queueCorrection(root, { message: "fix three" });
        assert.equal(await stop(true), null, "third block in a row is refused");
        assert.equal((await readCorrections(root)).sessions.s1?.stopBlocks, 2);
        assert.equal((await pendingCorrections(root, "s1")).length, 1, "the refused one stays pending");

        // The user speaks: the streak resets (and the pending one is delivered as context).
        const prompt = await respondToHook(root, { ...SESSION, hook_event_name: "UserPromptSubmit" }, deps);
        assert.ok(prompt && "hookSpecificOutput" in prompt);
        assert.equal((await readCorrections(root)).sessions.s1, undefined);

        await queueCorrection(root, { message: "fix four" });
        assert.ok(await stop(false));

        // Context mode never blocks.
        await queueCorrection(root, { message: "fix five" });
        assert.equal(await respondToHook(root, { ...SESSION, hook_event_name: "Stop" }, { ...deps, mode: "context" }), null);
    } finally {
        await removeProject(root);
    }
});

test("respondToHook fails open", async () => {
    const root = await initProject();
    try {
        const broken = { mode: "context" as const, derive: async (): Promise<DerivedCorrections> => { throw new Error("boom"); } };
        assert.equal(await respondToHook(root, { ...SESSION, hook_event_name: "UserPromptSubmit" }, broken), null);
        assert.equal(await respondToHook(root, null, { mode: "context" }), null);
        assert.equal(await respondToHook(root, "garbage", { mode: "context" }), null);
        const state: CorrectionsState = emptyCorrectionsState();
        assert.deepEqual(state.corrections, []);
    } finally {
        await removeProject(root);
    }
});

test("the mode comes from the agents.correct setting", async () => {
    const root = await initProject();
    try {
        await queueCorrection(root, { message: "fix it" });
        const payload = { ...SESSION, hook_event_name: "Stop" };
        assert.equal(await respondToHook(root, payload, { env: { TYR_CONFIG_HOME: root } }), null, "default is context: no block");
        assert.equal(await respondToHook(root, { ...payload, hook_event_name: "UserPromptSubmit" }, { env: { TYR_CONFIG_HOME: root, TYR_AGENTS_CORRECT: "off" } }), null);
        const blocked = await respondToHook(root, payload, { env: { TYR_CONFIG_HOME: root, TYR_AGENTS_CORRECT: "block" } });
        assert.ok(blocked && "decision" in blocked);
    } finally {
        await removeProject(root);
    }
});

/* -------------------------------------------------------------------------
 * tyr hook wiring
 * ---------------------------------------------------------------------- */

test("answerHookPayload returns one JSON line, or null without a project or on garbage", async () => {
    const root = await initProject();
    try {
        await queueCorrection(root, { message: "fix it" });
        const raw = JSON.stringify({ ...SESSION, cwd: root, hook_event_name: "UserPromptSubmit" });
        assert.equal(await answerHookPayload(raw, null, { mode: "context" }), null);
        assert.equal(await answerHookPayload("{garbage", root, { mode: "context" }), null);
        const line = await answerHookPayload(raw, root, { mode: "context" });
        assert.ok(line !== null);
        assert.doesNotMatch(line, /\n/);
        assert.equal(JSON.parse(line).hookSpecificOutput.hookEventName, "UserPromptSubmit");
    } finally {
        await removeProject(root);
    }
});

const CLI = fileURLToPath(new URL("../cli/index.js", import.meta.url));

function tyrHook(cwd: string, input: string, extraEnv: Record<string, string> = {}) {
    const env: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(process.env)) {
        if (name.startsWith("TYR_") || name === "CLAUDE_PROJECT_DIR") continue;
        env[name] = value;
    }
    Object.assign(env, { TYR_CONFIG_HOME: cwd }, extraEnv);
    return spawnSync(process.execPath, [CLI, "hook"], { cwd, input, encoding: "utf8", env, timeout: 20_000 });
}

test("tyr hook prints the reply as JSON on stdout, nothing else, exit 0", async () => {
    const root = await initProject();
    try {
        await queueCorrection(root, { message: "Run the formatter before finishing" });
        const stop = JSON.stringify({ ...SESSION, cwd: root, hook_event_name: "Stop", stop_hook_active: false });

        // Default (context): Stop is not blocked, stdout stays empty.
        const quiet = tyrHook(root, stop);
        assert.deepEqual([quiet.status, quiet.stdout, quiet.stderr], [0, "", ""]);

        const blocked = tyrHook(root, stop, { TYR_AGENTS_CORRECT: "block" });
        assert.equal(blocked.status, 0);
        assert.equal(blocked.stderr, "");
        const reply = JSON.parse(blocked.stdout);
        assert.equal(reply.decision, "block");
        assert.match(reply.reason, /Run the formatter/);

        // Delivered: the next prompt is silent again.
        const prompt = tyrHook(root, JSON.stringify({ ...SESSION, cwd: root, hook_event_name: "UserPromptSubmit", prompt: "x" }));
        assert.deepEqual([prompt.status, prompt.stdout], [0, ""]);
    } finally {
        await removeProject(root);
    }
});
