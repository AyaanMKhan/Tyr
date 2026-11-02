// Runtime validation of tyr.json / state.json (cli/core/schema.ts).

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import { validateConfig, validateState } from "../cli/core/schema.js";
import { buildConfig, buildInitialState } from "../cli/core/scaffold.js";
import type { InitSnapshot } from "../cli/core/types.js";

function snapshot(): InitSnapshot {
    return {
        discovery: { root: path.resolve("/tmp/app"), alreadyInitialized: false, files: [], fileCount: 4, skippedDirs: [] },
        git: {
            isRepo: true,
            branch: "main",
            detached: false,
            headCommit: { hash: "abc123", shortHash: "abc", subject: "s", author: "a", date: "d" },
            status: null,
            statusTimedOut: false,
            remotes: [],
            defaultRemote: "origin",
        },
        project: {
            name: "app",
            nameSource: "package.json",
            languages: [{ name: "TypeScript", fileCount: 4, percentage: 100 }],
            primaryLanguage: "TypeScript",
            frameworks: ["Express"],
            packageManager: { name: "npm", evidence: "package-lock.json" },
            build: { tool: "tsc", command: "npm run build", evidence: "package.json" },
            test: null,
            lint: null,
            format: null,
            typecheck: null,
            readme: "README.md",
            claudeMd: null,
            workspace: { tool: "npm", evidence: "package.json", packages: [{ name: "a", path: "packages/a", manifest: "packages/a/package.json" }] },
        },
    };
}

/** A fresh, valid config as a plain JSON object that tests can poke at. */
function config(): Record<string, any> {
    return JSON.parse(JSON.stringify(buildConfig(snapshot(), "1.0.0")));
}

function state(): Record<string, any> {
    return JSON.parse(JSON.stringify(buildInitialState(snapshot())));
}

/* -------------------------------------------------------------------------
 * tyr.json
 * ---------------------------------------------------------------------- */

test("a config from buildConfig is valid with no warnings", () => {
    const result = validateConfig(config());
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(result.warnings, []);
    assert.equal(result.value.project.root, ".");
});

test("validateConfig does not mutate its input", () => {
    const raw = config();
    delete raw.git;
    const before = structuredClone(raw);
    const result = validateConfig(raw);
    assert.ok(result.ok);
    assert.deepEqual(raw, before);
});

test("wrong types are errors with dotted paths", () => {
    const raw = config();
    raw.commands.build.command = 42;
    raw.project.fileCount = "many";
    raw.project.languages[0].percentage = "all";
    raw.git.isRepo = "yes";
    raw.scan.extraIgnore = ["ok", 3];
    raw.project.workspace = { tool: "lerna", packages: [] };
    const result = validateConfig(raw);
    assert.equal(result.ok, false);
    assert.deepEqual(!result.ok && result.errors, [
        "project.languages[0].percentage: expected number, got string",
        "project.fileCount: expected non-negative integer, got string",
        'project.workspace.tool: expected "npm" | "yarn" | "pnpm" | "cargo" | "nested", got string',
        "commands.build.command: expected non-empty string, got number",
        "git.isRepo: expected boolean, got string",
        "scan.extraIgnore[1]: expected string, got number",
    ]);
});

test("missing identity fields are errors", () => {
    const raw = config();
    delete raw.project.root;
    delete raw.commands;
    const result = validateConfig(raw);
    assert.ok(!result.ok);
    assert.deepEqual(result.errors, ["project.root: missing (expected non-empty string)", "commands: missing (expected object)"]);
});

test("a non-current version is an error (validation runs after migration)", () => {
    const result = validateConfig({ ...config(), version: 1 });
    assert.ok(!result.ok);
    assert.match(result.errors[0], /^version: expected 2/);
});

test("missing detection fields are defaulted with warnings", () => {
    const raw = config();
    delete raw.git;
    delete raw.project.languages;
    delete raw.commands.lint;
    delete raw.commands.build.tool;
    const result = validateConfig(raw);
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(result.value.git, { isRepo: false, branch: null, remote: null, headCommit: null });
    assert.deepEqual(result.value.project.languages, []);
    assert.equal(result.value.commands.lint, null);
    assert.equal(result.value.commands.build?.tool, "");
    assert.ok(result.warnings.includes("git: missing, defaulted to {}"));
    assert.ok(result.warnings.includes("project.languages: missing, defaulted to []"));
    assert.ok(result.warnings.includes("commands.lint: missing, defaulted to null"));
    assert.ok(result.warnings.includes('commands.build.tool: missing, defaulted to ""'));
});

test("optional fields may be absent silently", () => {
    const raw = config();
    delete raw.project.workspace;
    delete raw.git.detached;
    delete raw.scan.ignoredFiles;
    delete raw.scan.extraIgnore;
    delete raw.detected;
    const result = validateConfig(raw);
    assert.ok(result.ok);
    assert.deepEqual(result.warnings, []);
    assert.equal("detected" in result.value, false);
});

test("unknown keys are preserved at every level", () => {
    const raw = config();
    raw.notify = { slack: "#ci" };
    raw.project.alias = "web";
    raw.commands.e2e = { command: "npx playwright test", anything: true };
    raw.commands.build.timeoutMs = 5000;
    const result = validateConfig(raw);
    assert.ok(result.ok);
    const value = result.value as unknown as Record<string, any>;
    assert.deepEqual(value.notify, { slack: "#ci" });
    assert.equal(value.project.alias, "web");
    assert.deepEqual(value.commands.e2e, { command: "npx playwright test", anything: true });
    assert.equal(value.commands.build.timeoutMs, 5000);
});

test("command source must be detected or user", () => {
    const raw = config();
    raw.commands.build.source = "robot";
    const result = validateConfig(raw);
    assert.ok(!result.ok);
    assert.deepEqual(result.errors, ['commands.build.source: expected "detected" | "user", got string']);
});

test("a non-object config is rejected", () => {
    for (const value of [null, [], "x", 3]) {
        assert.equal(validateConfig(value).ok, false);
    }
});

/* -------------------------------------------------------------------------
 * state.json
 * ---------------------------------------------------------------------- */

test("a state from buildInitialState is valid", () => {
    const result = validateState(state());
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(result.warnings, []);
});

test("state status must be one of the four values", () => {
    for (const status of ["initialized", "running", "stopped", "error"]) {
        assert.ok(validateState({ ...state(), status }).ok, status);
    }
    const bad = validateState({ ...state(), status: "paused" });
    assert.ok(!bad.ok);
    assert.deepEqual(bad.errors, ['status: expected "initialized" | "running" | "stopped" | "error", got string']);
    assert.ok(!validateState({ ...state(), status: undefined }).ok);
});

test("state wrong types are errors; optional daemon fields are checked when present", () => {
    const result = validateState({ ...state(), runCount: -1, lastRunAt: 5, pid: "123", startedAt: false });
    assert.ok(!result.ok);
    assert.deepEqual(result.errors, [
        "runCount: expected non-negative integer, got number",
        "lastRunAt: expected string or null, got number",
        "pid: expected non-negative integer or null, got string",
        "startedAt: expected string or null, got boolean",
    ]);
    assert.ok(validateState({ ...state(), status: "running", pid: 42, startedAt: "t" }).ok);
    assert.ok(validateState({ ...state(), pid: null, startedAt: null }).ok);
});

test("state defaults counters and keeps unknown keys", () => {
    const raw = state();
    delete raw.lastScanFileCount;
    delete raw.lastIndexedCommit;
    raw.history = [{ event: "start" }];
    const result = validateState(raw);
    assert.ok(result.ok);
    assert.equal(result.value.lastScanFileCount, 0);
    assert.equal(result.value.lastIndexedCommit, null);
    assert.deepEqual((result.value as unknown as Record<string, unknown>).history, [{ event: "start" }]);
    assert.equal(result.warnings.length, 2);
});
