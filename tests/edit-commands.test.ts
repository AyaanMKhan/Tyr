import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
    CLEAR_TOKEN,
    USER_EVIDENCE,
    editCommands,
    toolFromCommand,
    type AskFn,
    type ConfirmFn,
} from "../cli/core/edit-commands.js";
import type { ProjectCommand, ProjectProfile } from "../cli/core/types.js";

function cmd(command: string, tool: string): ProjectCommand {
    return { tool, command, evidence: "package.json" };
}

function profile(partial: Partial<ProjectProfile> = {}): ProjectProfile {
    return {
        name: "demo",
        nameSource: "package.json",
        languages: [],
        primaryLanguage: "TypeScript",
        frameworks: [],
        packageManager: null,
        build: cmd("npm run build", "tsc"),
        test: cmd("npm test", "Jest"),
        lint: cmd("npx eslint .", "ESLint"),
        format: null,
        typecheck: null,
        readme: null,
        claudeMd: null,
        workspace: null,
        ...partial,
    };
}

/**
 * Answers questions in order, behaving like prompt.ts's ask(): an empty
 * scripted answer comes back as the default. Records every question.
 */
function scriptedAsk(answers: string[]) {
    const questions: { question: string; defaultValue: string }[] = [];
    const ask: AskFn = async (question, defaultValue) => {
        questions.push({ question, defaultValue });
        if (answers.length === 0) throw new Error(`unexpected question: ${question}`);
        const answer = answers.shift()!.trim();
        return answer === "" ? defaultValue : answer;
    };
    return { ask, questions, remaining: answers };
}

function scriptedConfirm(answer: boolean) {
    const asked: string[] = [];
    const confirm: ConfirmFn = async (question) => {
        asked.push(question);
        return answer;
    };
    return { confirm, asked };
}

test("Enter on every slot keeps the profile unchanged", async () => {
    const input = profile();
    const { ask, questions, remaining } = scriptedAsk(["", "", "", "", ""]);
    const result = await editCommands(input, { ask });

    assert.deepEqual(result.project, input);
    assert.deepEqual(result.changed, []);
    assert.deepEqual(result.cleared, []);
    assert.equal(result.confirmed, true);
    assert.equal(remaining.length, 0);
    // Slots are walked in display order, offering the detected command as default.
    assert.deepEqual(
        questions.map((q) => q.defaultValue),
        ["npm run build", "npm test", "npx eslint .", "", ""],
    );
    assert.match(questions[4].question, /Type checker/);
});

test("a typed command replaces the slot and is marked as user-provided", async () => {
    const input = profile();
    const { ask } = scriptedAsk(["", "  npx vitest run  ", "", "", ""]);
    const result = await editCommands(input, { ask });

    assert.deepEqual(result.project.test, { tool: "vitest", command: "npx vitest run", evidence: USER_EVIDENCE });
    assert.deepEqual(result.changed, ["test"]);
    assert.deepEqual(result.project.build, input.build);
    // The input profile is not mutated.
    assert.equal(input.test?.command, "npm test");
});

test("retyping the detected command counts as keeping it", async () => {
    const { ask } = scriptedAsk(["npm run build", "", "", "", ""]);
    const result = await editCommands(profile(), { ask });
    assert.equal(result.project.build?.evidence, "package.json");
    assert.deepEqual(result.changed, []);
});

test(`"${CLEAR_TOKEN}" clears a detected slot and is a no-op on an empty one`, async () => {
    const { ask } = scriptedAsk(["", "", CLEAR_TOKEN, CLEAR_TOKEN, ""]);
    const result = await editCommands(profile(), { ask });

    assert.equal(result.project.lint, null);
    assert.equal(result.project.format, null);
    assert.deepEqual(result.cleared, ["lint"]);
    assert.deepEqual(result.changed, []);
});

test("a command can be added to an empty slot", async () => {
    const { ask } = scriptedAsk(["", "", "", "npx prettier --check .", "tsc --noEmit"]);
    const result = await editCommands(profile(), { ask });

    assert.deepEqual(result.project.format, {
        tool: "prettier",
        command: "npx prettier --check .",
        evidence: USER_EVIDENCE,
    });
    assert.deepEqual(result.project.typecheck, { tool: "tsc", command: "tsc --noEmit", evidence: USER_EVIDENCE });
    assert.deepEqual(result.changed, ["format", "typecheck"]);
});

test("declining the final confirmation reports confirmed: false", async () => {
    const { ask } = scriptedAsk(["make", "", "", "", ""]);
    const { confirm, asked } = scriptedConfirm(false);
    const result = await editCommands(profile(), { ask, confirm });

    assert.equal(result.confirmed, false);
    assert.deepEqual(asked, ["Write this configuration?"]);
});

test("accepting the final confirmation reports confirmed: true", async () => {
    const { ask } = scriptedAsk(["", "", "", "", ""]);
    const { confirm } = scriptedConfirm(true);
    const result = await editCommands(profile(), { ask, confirm });
    assert.equal(result.confirmed, true);
});

test("say() shows each detected command with its probe status", async () => {
    const lines: string[] = [];
    const { ask } = scriptedAsk(["", "", "", "", ""]);
    await editCommands(profile(), {
        ask,
        say: (line) => lines.push(line),
        checks: {
            build: { status: "ok", detail: 'script "build" runs via npm' },
            test: { status: "missing", detail: 'script "test" not found in package.json' },
            lint: null,
            format: null,
            typecheck: null,
        },
    });

    assert.ok(lines.includes('Build: npm run build (ok: script "build" runs via npm)'));
    assert.ok(lines.includes('Tests: npm test (missing: script "test" not found in package.json)'));
    assert.ok(lines.includes("Linter: npx eslint ."));
    assert.ok(lines.includes("Formatter: none detected"));
});

test("toolFromCommand derives a display name from the first meaningful token", () => {
    assert.equal(toolFromCommand("pytest -q"), "pytest");
    assert.equal(toolFromCommand("npx eslint ."), "eslint");
    assert.equal(toolFromCommand("npx --yes tsc --noEmit"), "tsc");
    assert.equal(toolFromCommand("NODE_ENV=test jest"), "jest");
    assert.equal(toolFromCommand("./gradlew build"), "gradlew");
    assert.equal(toolFromCommand("npm run lint"), "npm");
});
