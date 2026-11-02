// Schema version migration (cli/core/migrate.ts) and the scaffold.ts read
// path built on it: read JSON -> migrate -> validate.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
    CURRENT_CONFIG_VERSION,
    CURRENT_STATE_VERSION,
    migrateConfig,
    migrateState,
    runMigrations,
    type MigrationStep,
} from "../cli/core/migrate.js";
import { loadConfig, loadState, readConfig, readState, scaffold } from "../cli/core/scaffold.js";
import type { InitSnapshot } from "../cli/core/types.js";
import { makeProject, removeProject } from "./helpers.js";

function v1Config(root: string): Record<string, unknown> {
    return {
        version: 1,
        tyrVersion: "1.0.0",
        initializedAt: "2026-01-01T00:00:00.000Z",
        project: {
            name: "app",
            root,
            primaryLanguage: "TypeScript",
            languages: [{ name: "TypeScript", fileCount: 3, percentage: 100 }],
            frameworks: [],
            packageManager: "npm",
            fileCount: 3,
        },
        commands: {
            build: { command: "npm run build", tool: "tsc", evidence: "package.json" },
            test: null,
            lint: null,
            format: null,
            typecheck: null,
        },
        git: { isRepo: true, branch: "main", remote: "origin", headCommit: null },
        docs: { readme: "README.md", claudeMd: null },
        scan: { ignoredDirs: ["node_modules"], ignoredExtensions: [".png"] },
    };
}

const STATE = {
    version: 1,
    status: "initialized",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastIndexedCommit: null,
    lastScanFileCount: 3,
    runCount: 0,
    lastRunAt: null,
};

async function writeTyrFile(root: string, relative: string, contents: unknown): Promise<void> {
    const file = path.join(root, ".tyr", relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, typeof contents === "string" ? contents : JSON.stringify(contents, null, 2), "utf8");
}

/* ---------------------------------------------------------------------- */

test("v1 -> v2 replaces an absolute POSIX or Windows root with '.'", () => {
    for (const root of ["/home/ayaan/Tyr", "C:\\Users\\ayaan\\Tyr", "D:/Tyr"]) {
        const result = migrateConfig(v1Config(root));
        assert.ok(result.ok);
        assert.equal(result.fromVersion, 1);
        assert.equal(result.toVersion, CURRENT_CONFIG_VERSION);
        assert.equal(result.steps.length, 1);
        assert.equal((result.value.project as Record<string, unknown>).root, ".");
        assert.equal(result.value.version, 2);
    }
});

test("v1 -> v2 keeps a relative root and converts legacy string commands", () => {
    const raw = v1Config("sub");
    (raw as { commands: Record<string, unknown> }).commands = {
        build: "npm run build",
        test: "",
        lint: null,
        e2e: "npx playwright test",
    };
    const result = migrateConfig(raw);
    assert.ok(result.ok);
    const value = result.value as { project: { root: string }; commands: Record<string, unknown> };
    assert.equal(value.project.root, "sub");
    assert.deepEqual(value.commands.build, { command: "npm run build", tool: "npm", evidence: "tyr.json" });
    assert.equal(value.commands.test, null);
    assert.equal(value.commands.lint, null);
    assert.deepEqual(value.commands.e2e, { command: "npx playwright test", tool: "npx", evidence: "tyr.json" });
});

test("migration is pure: the input document is not mutated", () => {
    const raw = v1Config("/abs/root");
    const before = structuredClone(raw);
    migrateConfig(raw);
    assert.deepEqual(raw, before);
});

test("a missing version counts as v1", () => {
    const raw = v1Config("/abs/root");
    delete raw.version;
    const result = migrateConfig(raw);
    assert.ok(result.ok);
    assert.equal(result.fromVersion, 1);
    assert.equal(result.value.version, CURRENT_CONFIG_VERSION);

    const state: Record<string, unknown> = { ...STATE };
    delete state.version;
    const stateResult = migrateState(state);
    assert.ok(stateResult.ok);
    assert.equal(stateResult.value.version, CURRENT_STATE_VERSION);
    assert.deepEqual(stateResult.steps, []);
});

test("a current document passes through with no steps", () => {
    const result = migrateConfig({ ...v1Config("."), version: CURRENT_CONFIG_VERSION });
    assert.ok(result.ok);
    assert.deepEqual(result.steps, []);
});

test("a newer version is refused, not downgraded", () => {
    const result = migrateConfig({ ...v1Config("."), version: CURRENT_CONFIG_VERSION + 1 });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.reason === "newer");
    assert.match(result.ok ? "" : result.errors[0], /newer Tyr/);

    const state = migrateState({ ...STATE, version: CURRENT_STATE_VERSION + 1 });
    assert.ok(!state.ok && state.reason === "newer");
});

test("a garbled version or a non-object is invalid", () => {
    for (const version of ["2", 0, 1.5, null]) {
        const result = migrateConfig({ ...v1Config("."), version });
        assert.ok(!result.ok && result.reason === "invalid", `version ${JSON.stringify(version)}`);
    }
    assert.ok(!migrateConfig([]).ok);
    assert.ok(!migrateConfig(null).ok);
});

test("runMigrations applies steps in order and reports each", () => {
    const steps: MigrationStep[] = [
        { from: 2, description: "two", apply: (doc) => ({ ...doc, trail: [...(doc.trail as string[]), "2"] }) },
        { from: 1, description: "one", apply: (doc) => ({ ...doc, trail: ["1"] }) },
    ];
    const result = runMigrations({ version: 1 }, 3, steps, "doc");
    assert.ok(result.ok);
    assert.deepEqual(result.steps, ["one", "two"]);
    assert.deepEqual(result.value, { version: 3, trail: ["1", "2"] });
});

/* -------------------------------------------------------------------------
 * The scaffold.ts read path
 * ---------------------------------------------------------------------- */

test("readConfig migrates a v1 file and rehydrates the absolute root, without rewriting it", async () => {
    const root = await makeProject({});
    try {
        await writeTyrFile(root, "tyr.json", v1Config("/some/other/machine/app"));
        const before = await fs.readFile(path.join(root, ".tyr", "tyr.json"), "utf8");

        const loaded = await loadConfig(root);
        assert.deepEqual(loaded.errors, []);
        assert.equal(loaded.missing, false);
        assert.equal(loaded.migrated.length, 1);
        assert.equal(loaded.value?.project.root, root);
        assert.equal(loaded.value?.version, 2);

        assert.equal((await readConfig(root))?.project.root, root);
        // Config is only upgraded on disk by `tyr init`.
        assert.equal(await fs.readFile(path.join(root, ".tyr", "tyr.json"), "utf8"), before);
    } finally {
        await removeProject(root);
    }
});

test("readConfig resolves a stored '.' against the directory holding .tyr/", async () => {
    const root = await makeProject({});
    try {
        await writeTyrFile(root, "tyr.json", { ...v1Config("."), version: 2 });
        const config = await readConfig(root);
        assert.equal(config?.project.root, root);
        assert.ok(path.isAbsolute(config?.project.root ?? ""));
    } finally {
        await removeProject(root);
    }
});

test("readConfig/readState return null for missing, malformed, invalid and newer files", async () => {
    const root = await makeProject({});
    try {
        assert.equal(await readConfig(root), null);
        assert.equal((await loadConfig(root)).missing, true);
        assert.equal(await readState(root), null);

        await writeTyrFile(root, "tyr.json", "{ not json");
        let loaded = await loadConfig(root);
        assert.equal(loaded.value, null);
        assert.equal(loaded.missing, false);
        assert.match(loaded.errors[0], /tyr\.json: malformed JSON/);

        await writeTyrFile(root, "tyr.json", "[1, 2]");
        assert.match((await loadConfig(root)).errors[0], /expected a JSON object, got array/);

        const wrong = v1Config(".");
        (wrong.commands as Record<string, unknown>).test = { command: 42, tool: "x", evidence: "y" };
        await writeTyrFile(root, "tyr.json", wrong);
        loaded = await loadConfig(root);
        assert.equal(loaded.value, null);
        assert.deepEqual(loaded.errors, ["commands.test.command: expected non-empty string, got number"]);

        await writeTyrFile(root, "tyr.json", { ...v1Config("."), version: 99 });
        loaded = await loadConfig(root);
        assert.equal(loaded.value, null);
        assert.match(loaded.errors[0], /newer Tyr/);

        await writeTyrFile(root, "state/state.json", { ...STATE, status: "sleeping" });
        assert.equal(await readState(root), null);
        assert.match((await loadState(root)).errors[0], /^status: expected/);
    } finally {
        await removeProject(root);
    }
});

test("readState fills defaults with warnings and keeps unknown keys", async () => {
    const root = await makeProject({});
    try {
        const { runCount: _runCount, ...partial } = STATE;
        await writeTyrFile(root, "state/state.json", { ...partial, history: [{ at: "x" }] });
        const loaded = await loadState(root);
        assert.deepEqual(loaded.errors, []);
        assert.equal(loaded.value?.runCount, 0);
        assert.deepEqual((loaded.value as unknown as Record<string, unknown>).history, [{ at: "x" }]);
        assert.deepEqual(loaded.warnings, ["runCount: missing, defaulted to 0"]);
    } finally {
        await removeProject(root);
    }
});

/* -------------------------------------------------------------------------
 * scaffold(): previous documents are migrated before merging
 * ---------------------------------------------------------------------- */

function snapshot(root: string): InitSnapshot {
    return {
        discovery: { root, alreadyInitialized: true, files: [], fileCount: 0, skippedDirs: [] },
        git: {
            isRepo: false,
            branch: null,
            detached: false,
            headCommit: null,
            status: null,
            statusTimedOut: false,
            remotes: [],
            defaultRemote: null,
        },
        project: {
            name: null,
            nameSource: null,
            languages: [],
            primaryLanguage: null,
            frameworks: [],
            packageManager: null,
            build: null,
            test: null,
            lint: null,
            format: null,
            typecheck: null,
            readme: null,
            claudeMd: null,
            workspace: null,
        },
    };
}

test("scaffold writes a portable v2 config over a v1 one, keeping user edits", async () => {
    const root = await makeProject({});
    try {
        const old = v1Config("/elsewhere/app");
        (old as { commands: Record<string, unknown> }).commands.test = "npm test"; // legacy string form
        (old as Record<string, unknown>).notify = { slack: "#ci" };
        await writeTyrFile(root, "tyr.json", old);

        const result = await scaffold(snapshot(root), "1.0.0");
        const onDisk = JSON.parse(await fs.readFile(result.configFile, "utf8"));
        assert.equal(onDisk.version, CURRENT_CONFIG_VERSION);
        assert.equal(onDisk.project.root, ".");
        assert.equal(onDisk.initializedAt, "2026-01-01T00:00:00.000Z");
        assert.equal(onDisk.commands.test.command, "npm test");
        assert.deepEqual(onDisk.notify, { slack: "#ci" });
        assert.ok(result.preserved.commands.includes("test"));

        // And it reads back cleanly, root rehydrated.
        const loaded = await loadConfig(root);
        assert.deepEqual(loaded.errors, []);
        assert.equal(loaded.value?.project.root, root);
        assert.deepEqual(loaded.migrated, []);
    } finally {
        await removeProject(root);
    }
});

test("scaffold refuses to overwrite a config from a newer Tyr unless reset", async () => {
    const root = await makeProject({});
    try {
        const newer = { ...v1Config("."), version: CURRENT_CONFIG_VERSION + 1 };
        await writeTyrFile(root, "tyr.json", newer);
        await assert.rejects(scaffold(snapshot(root), "1.0.0"), /newer version of Tyr/);
        const stillThere = JSON.parse(await fs.readFile(path.join(root, ".tyr", "tyr.json"), "utf8"));
        assert.equal(stillThere.version, CURRENT_CONFIG_VERSION + 1);

        await scaffold(snapshot(root), "1.0.0", { reset: true });
        assert.equal((await readConfig(root))?.version, CURRENT_CONFIG_VERSION);
    } finally {
        await removeProject(root);
    }
});
