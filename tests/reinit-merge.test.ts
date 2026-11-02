// `tyr init --force` merge (reinit-merge.ts) and its use in scaffold().

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildConfig, buildInitialState, readConfig, readState, scaffold, writeState } from "../cli/core/scaffold.js";
import { mergeConfig, mergeState } from "../cli/core/reinit-merge.js";
import { InitSnapshot, ProjectProfile, TyrConfig } from "../cli/core/types.js";
import { makeProject, removeProject } from "./helpers.js";

const JEST = { tool: "Jest", command: "npm run test", evidence: "jest.config.js" };
const TSC = { tool: "tsc", command: "npm run build", evidence: "package.json" };
const ESLINT = { tool: "ESLint", command: "npx eslint .", evidence: ".eslintrc.json" };

function snapshotWith(project: Partial<ProjectProfile>, root = "/tmp/app", fileCount = 0): InitSnapshot {
    return {
        discovery: {
            root: path.resolve(root),
            alreadyInitialized: false,
            files: [],
            fileCount,
            skippedDirs: [],
        },
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
            ...project,
        },
    };
}

/** A tyr.json as a previous init wrote it, then put through `edit`. */
function previousConfig(project: Partial<ProjectProfile>, edit: (config: TyrConfig) => void = () => {}): TyrConfig {
    const config = structuredClone(buildConfig(snapshotWith(project), "0.9.0"));
    edit(config);
    return config;
}

test("buildConfig records the detection baseline next to commands", () => {
    const config = buildConfig(snapshotWith({ build: TSC, test: JEST }), "1.0.0");
    assert.deepEqual(config.detected, {
        commands: { build: "npm run build", test: "npm run test", lint: null, format: null, typecheck: null },
    });
});

test("a hand-edited command survives re-detection", () => {
    const previous = previousConfig({ test: JEST }, (config) => {
        config.commands.test = { ...JEST, command: "npm run test:unit" };
    });
    const fresh = buildConfig(snapshotWith({ test: JEST }), "1.0.0");
    const { config, keptCommands } = mergeConfig(fresh, previous);

    assert.equal(config.commands.test?.command, "npm run test:unit");
    assert.deepEqual(keptCommands, ["test"]);
    // The baseline stays what detection produced, so the edit is still
    // recognised on the next --force.
    assert.equal(config.detected?.commands.test, "npm run test");
});

test("an unedited command refreshes to the new detection", () => {
    const previous = previousConfig({ test: JEST, lint: null });
    const vitest = { tool: "Vitest", command: "npx vitest run", evidence: "vitest.config.ts" };
    const fresh = buildConfig(snapshotWith({ test: vitest, lint: ESLINT }), "1.0.0");
    const { config, keptCommands } = mergeConfig(fresh, previous);

    assert.deepEqual(config.commands.test, vitest);
    assert.deepEqual(config.commands.lint, ESLINT);
    assert.deepEqual(keptCommands, []);
});

test("a detected command the user nulled out stays disabled", () => {
    const previous = previousConfig({ lint: ESLINT }, (config) => {
        config.commands.lint = null;
    });
    const { config, keptCommands } = mergeConfig(buildConfig(snapshotWith({ lint: ESLINT }), "1.0.0"), previous);
    assert.equal(config.commands.lint, null);
    assert.deepEqual(keptCommands, ["lint"]);
});

test("a command marked source: user is always kept", () => {
    const userTest = { tool: "custom", command: "make test", evidence: "user", source: "user" as const };
    // Even when it happens to match the old baseline.
    const previous = previousConfig({ test: JEST }, (config) => {
        config.commands.test = { ...userTest, command: "npm run test" };
    });
    const { config, keptCommands } = mergeConfig(buildConfig(snapshotWith({ test: JEST }), "1.0.0"), previous);
    assert.equal(config.commands.test?.source, "user");
    assert.deepEqual(keptCommands, ["test"]);
});

test("legacy config without a baseline keeps differing commands but fills empty slots", () => {
    const previous = previousConfig({ test: JEST }, (config) => {
        delete config.detected;
        config.commands.test = { ...JEST, command: "npm run test:ci" };
    });
    const fresh = buildConfig(snapshotWith({ test: JEST, lint: ESLINT }), "1.0.0");
    const { config, keptCommands } = mergeConfig(fresh, previous);

    assert.equal(config.commands.test?.command, "npm run test:ci");
    assert.deepEqual(config.commands.lint, ESLINT);
    assert.deepEqual(keptCommands, ["test"]);
});

test("extra user keys survive and detection-derived fields refresh", () => {
    const previous = previousConfig({}, (config) => {
        const loose = config as unknown as Record<string, Record<string, unknown>>;
        loose.notify = { slack: "#builds" } as unknown as Record<string, unknown>;
        loose.commands.e2e = { command: "npx playwright test", tool: "Playwright", evidence: "user" };
        loose.project.alias = "app";
        config.project.fileCount = 999;
        config.initializedAt = "2026-01-01T00:00:00.000Z";
    });
    const fresh = buildConfig(snapshotWith({}, "/tmp/app", 7), "1.0.0");
    const { config, keptKeys } = mergeConfig(fresh, previous);
    const loose = config as unknown as Record<string, Record<string, unknown>>;

    assert.deepEqual(loose.notify, { slack: "#builds" });
    assert.equal((loose.commands.e2e as { command: string }).command, "npx playwright test");
    assert.equal(loose.project.alias, "app");
    assert.deepEqual(keptKeys.sort(), ["commands.e2e", "notify", "project.alias"]);
    assert.equal(config.project.fileCount, 7);
    assert.equal(config.tyrVersion, "1.0.0");
    assert.equal(config.initializedAt, "2026-01-01T00:00:00.000Z");
});

test("state history survives; detection-derived state refreshes", () => {
    const previous = {
        ...buildInitialState(snapshotWith({})),
        createdAt: "2026-01-01T00:00:00.000Z",
        runCount: 12,
        lastRunAt: "2026-02-01T00:00:00.000Z",
        status: "stopped",
        lastScanFileCount: 3,
        history: [{ at: "2026-02-01T00:00:00.000Z", event: "run" }],
    };
    const { state, keptFields } = mergeState(buildInitialState(snapshotWith({}, "/tmp/app", 40)), previous);
    const loose = state as unknown as Record<string, unknown>;

    assert.equal(state.createdAt, "2026-01-01T00:00:00.000Z");
    assert.equal(state.runCount, 12);
    assert.equal(state.lastRunAt, "2026-02-01T00:00:00.000Z");
    assert.equal(state.status, "stopped");
    assert.equal(state.lastScanFileCount, 40);
    assert.deepEqual(loose.history, previous.history);
    assert.ok(keptFields.includes("history"));
});

test("malformed previous files fall back to fresh output", () => {
    const fresh = buildConfig(snapshotWith({ test: JEST }), "1.0.0");
    assert.deepEqual(mergeConfig(fresh, null).config, fresh);
    const state = buildInitialState(snapshotWith({}));
    const merged = mergeState(state, { runCount: -1, status: "bogus", createdAt: 5 }).state;
    assert.equal(merged.runCount, 0);
    assert.equal(merged.status, "initialized");
    assert.equal(merged.createdAt, state.createdAt);
});

test("scaffold merges on re-init and --reset overwrites", async () => {
    const root = await makeProject({});
    try {
        await scaffold(snapshotWith({ test: JEST }, root), "1.0.0");

        // Simulate the user and a running Tyr touching .tyr/.
        const config = (await readConfig(root)) as TyrConfig & Record<string, unknown>;
        config.commands.test = { ...JEST, command: "npm run test:unit" };
        config.notify = "me";
        await fs.writeFile(path.join(root, ".tyr", "tyr.json"), JSON.stringify(config), "utf8");
        const state = await readState(root);
        assert.ok(state);
        await writeState(root, { ...state, runCount: 5 });
        const pidFile = path.join(root, ".tyr", "state", "daemon.pid");
        await fs.writeFile(pidFile, "1234", "utf8");

        const merged = await scaffold(snapshotWith({ test: JEST, lint: ESLINT }, root), "1.0.0");
        assert.deepEqual(merged.preserved.commands, ["test"]);
        const afterMerge = (await readConfig(root)) as TyrConfig & Record<string, unknown>;
        assert.equal(afterMerge.commands.test?.command, "npm run test:unit");
        assert.deepEqual(afterMerge.commands.lint, ESLINT);
        assert.equal(afterMerge.notify, "me");
        assert.equal((await readState(root))?.runCount, 5);
        assert.equal(await fs.readFile(pidFile, "utf8"), "1234");

        const reset = await scaffold(snapshotWith({ test: JEST }, root), "1.0.0", { reset: true });
        assert.deepEqual(reset.preserved, { commands: [], configKeys: [], stateFields: [] });
        const afterReset = (await readConfig(root)) as TyrConfig & Record<string, unknown>;
        assert.deepEqual(afterReset.commands.test, JEST);
        assert.equal(afterReset.notify, undefined);
        assert.equal((await readState(root))?.runCount, 0);
    } finally {
        await removeProject(root);
    }
});
