// The settings resolver (cli/core/settings.ts): layer precedence, origins,
// array replacement, warnings/errors, and display helpers (masking, text).
// Every test passes its own `env` and a temp TYR_CONFIG_HOME, so the real
// ~/.config/tyr and the caller's TYR_* variables are never read.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
    describeSettingValue,
    displaySettingValue,
    formatSettingValue,
    layerOutranks,
    maskSecret,
    resolveSettings,
    suggestSettingKey,
} from "../cli/core/settings.js";
import { DEFAULT_SETTINGS, SETTING_KEYS, findSettingKey, parseSettingValue } from "../cli/core/settings-types.js";
import { makeProject, removeProject } from "./helpers.js";

interface Fixture {
    root: string;
    home: string;
    env: NodeJS.ProcessEnv;
    globalFile: string;
    projectFile: string;
}

async function withFixture(
    files: { global?: unknown; project?: unknown; env?: NodeJS.ProcessEnv },
    fn: (fixture: Fixture) => Promise<void>,
): Promise<void> {
    const root = await makeProject({ ".tyr/tyr.json": "{}" });
    const home = await makeProject({});
    const globalFile = path.join(home, "config.json");
    const projectFile = path.join(root, ".tyr", "settings.json");
    const write = (file: string, value: unknown) =>
        fs.writeFile(file, typeof value === "string" ? value : JSON.stringify(value), "utf8");
    try {
        if (files.global !== undefined) await write(globalFile, files.global);
        if (files.project !== undefined) await write(projectFile, files.project);
        await fn({ root, home, globalFile, projectFile, env: { TYR_CONFIG_HOME: home, ...files.env } });
    } finally {
        await removeProject(root);
        await removeProject(home);
    }
}

test("with no files and no variables every key is the default", async () => {
    await withFixture({}, async ({ root, env, globalFile, projectFile }) => {
        const resolved = await resolveSettings({ root, env });
        assert.deepEqual(resolved.settings, DEFAULT_SETTINGS);
        assert.deepEqual(resolved.warnings, []);
        assert.deepEqual(resolved.errors, []);
        assert.deepEqual(resolved.files, { global: globalFile, project: projectFile });
        for (const spec of SETTING_KEYS) {
            assert.deepEqual(resolved.origins[spec.key], { layer: "default", source: "default" }, spec.key);
        }
    });
});

test("precedence is default < global < project < env, per key, with origins", async () => {
    await withFixture(
        {
            global: { version: 1, checks: { lint: false, format: true }, severity: { threshold: "info" }, ai: { model: "g-model" } },
            project: { version: 1, checks: { lint: true }, severity: { threshold: "error" } },
            env: { TYR_SEVERITY: "warning", TYR_API_KEY: "sk-from-env-0000" },
        },
        async ({ root, env, globalFile, projectFile }) => {
            const { settings, origins } = await resolveSettings({ root, env });
            // Project beats global; env beats project; untouched keys fall through.
            assert.equal(settings.checks.lint, true);
            assert.deepEqual(origins["checks.lint"], { layer: "project", source: projectFile });
            assert.equal(settings.checks.format, true);
            assert.deepEqual(origins["checks.format"], { layer: "global", source: globalFile });
            assert.equal(settings.severity.threshold, "warning");
            assert.deepEqual(origins["severity.threshold"], { layer: "env", source: "TYR_SEVERITY" });
            assert.equal(settings.ai.model, "g-model");
            assert.equal(settings.ai.apiKey, "sk-from-env-0000");
            assert.deepEqual(origins["ai.apiKey"], { layer: "env", source: "TYR_API_KEY" });
            assert.equal(settings.checks.build, true);
            assert.equal(origins["checks.build"].layer, "default");
        },
    );
});

test("the env origin names the variable actually used (ANTHROPIC_API_KEY fallback)", async () => {
    await withFixture({ env: { ANTHROPIC_API_KEY: "sk-anthropic-1234" } }, async ({ root, env }) => {
        const { origins } = await resolveSettings({ root, env });
        assert.deepEqual(origins["ai.apiKey"], { layer: "env", source: "ANTHROPIC_API_KEY" });
    });
});

test("arrays replace, never concatenate, including the empty list", async () => {
    await withFixture(
        {
            global: { notifications: { targets: ["terminal", "desktop"] } },
            project: { notifications: { targets: ["webhook:https://x.test"] } },
        },
        async ({ root, env }) => {
            assert.deepEqual((await resolveSettings({ root, env })).settings.notifications.targets, ["webhook:https://x.test"]);
            const viaEnv = await resolveSettings({ root, env: { ...env, TYR_NOTIFY: "none" } });
            assert.deepEqual(viaEnv.settings.notifications.targets, []);
            assert.equal(viaEnv.origins["notifications.targets"].layer, "env");
        },
    );
    await withFixture({ global: { notifications: { targets: ["desktop"] } }, project: { notifications: { targets: [] } } }, async ({ root, env }) => {
        const { settings, origins } = await resolveSettings({ root, env });
        assert.deepEqual(settings.notifications.targets, []);
        assert.equal(origins["notifications.targets"].layer, "project");
    });
});

test("the result never aliases DEFAULT_SETTINGS or a layer's arrays", async () => {
    await withFixture({}, async ({ root, env }) => {
        const resolved = await resolveSettings({ root, env });
        resolved.settings.notifications.targets.push("mutated");
        resolved.settings.checks.lint = false;
        assert.deepEqual(DEFAULT_SETTINGS.notifications.targets, ["terminal"]);
        assert.equal(DEFAULT_SETTINGS.checks.lint, true);
    });
});

test("no root means no project layer, even if a settings file exists there", async () => {
    await withFixture({ project: { checks: { lint: false } } }, async ({ env }) => {
        const resolved = await resolveSettings({ root: null, env });
        assert.equal(resolved.settings.checks.lint, true);
        assert.equal(resolved.files.project, null);
        assert.deepEqual(resolved.errors, []);
    });
});

test("bad files and variables become warnings or errors, never a throw", async () => {
    await withFixture(
        {
            global: "{ not json",
            project: { checks: { lint: "nope", build: false }, mystery: 1, ai: { apiKey: "sk-committed-0000" } },
            env: { TYR_SEVERITY: "fatal", TYR_CHECKS_TEST: "0" },
        },
        async ({ root, env }) => {
            const { settings, origins, warnings, errors } = await resolveSettings({ root, env });
            assert.equal(errors.length, 1);
            assert.match(errors[0], /malformed JSON/);
            // Valid parts of the project file still apply; the secret never does.
            assert.equal(settings.checks.build, false);
            assert.equal(settings.checks.lint, true);
            assert.equal(settings.ai.apiKey, null);
            assert.equal(origins["ai.apiKey"].layer, "default");
            assert.equal(settings.checks.test, false);
            assert.equal(settings.severity.threshold, "warning");
            assert.ok(warnings.some((w) => /checks\.lint must be a boolean/.test(w)));
            assert.ok(warnings.some((w) => /unknown setting "mystery"/.test(w)));
            assert.ok(warnings.some((w) => /ai\.apiKey is a secret/.test(w)));
            assert.ok(warnings.some((w) => /^TYR_SEVERITY:/.test(w)));
            assert.ok(!warnings.some((w) => w.includes("sk-committed-0000")), "a secret value is never echoed");
        },
    );
});

test("layerOutranks follows the precedence order", () => {
    assert.equal(layerOutranks("env", "project"), true);
    assert.equal(layerOutranks("project", "global"), true);
    assert.equal(layerOutranks("global", "project"), false);
    assert.equal(layerOutranks("default", "default"), false);
});

test("maskSecret shows a kind prefix and the last four characters only", () => {
    assert.equal(maskSecret("sk-ant-api03-abcdefghijklmnopwxyz"), "sk-…wxyz");
    assert.equal(maskSecret("abcdefghijklmnop"), "…mnop");
    assert.equal(maskSecret("sk-short"), "****", "short values are hidden completely");
    assert.equal(maskSecret(""), "****");
    assert.equal(maskSecret(null), null);
});

test("displaySettingValue masks only secrets, unless revealed", () => {
    const apiKey = findSettingKey("ai.apiKey")!;
    const model = findSettingKey("ai.model")!;
    const key = "sk-ant-api03-0123456789abcd";
    assert.equal(displaySettingValue(apiKey, key), "sk-…abcd");
    assert.equal(displaySettingValue(apiKey, key, { reveal: true }), key);
    assert.equal(displaySettingValue(apiKey, null), null);
    assert.equal(displaySettingValue(model, "claude-opus-5-5"), "claude-opus-5-5");
});

test("formatSettingValue uses the spelling `config set` accepts, so values round-trip", () => {
    for (const spec of SETTING_KEYS) {
        const value = DEFAULT_SETTINGS[spec.key.split(".")[0] as keyof typeof DEFAULT_SETTINGS] as Record<string, unknown>;
        const leaf = value[spec.key.split(".")[1]];
        const parsed = parseSettingValue(spec, formatSettingValue(leaf));
        assert.ok(parsed.ok, spec.key);
        assert.deepEqual(parsed.ok && parsed.value, leaf, spec.key);
    }
    assert.equal(formatSettingValue(["terminal", "desktop"]), "terminal,desktop");
    assert.equal(formatSettingValue([]), "");
    assert.equal(formatSettingValue(null), "");
    assert.equal(describeSettingValue([]), "(none)");
    assert.equal(describeSettingValue(null), "(not set)");
});

test("parseSettingValue: none and \"\" are the empty list; blank entries are an error", () => {
    const targets = findSettingKey("notifications.targets")!;
    for (const raw of ["none", "NONE", " None ", "", "  "]) {
        assert.deepEqual(parseSettingValue(targets, raw), { ok: true, value: [] }, JSON.stringify(raw));
    }
    assert.deepEqual(parseSettingValue(targets, "terminal, desktop"), { ok: true, value: ["terminal", "desktop"] });
    const blank = parseSettingValue(targets, " , ,");
    assert.equal(blank.ok, false);
    assert.match(!blank.ok ? blank.error : "", /use "none"/);
});

test("suggestSettingKey catches typos, case, env names and bare leaves", () => {
    assert.equal(suggestSettingKey("chekcs.lint"), "checks.lint");
    assert.equal(suggestSettingKey("Checks.Lint"), "checks.lint");
    assert.equal(suggestSettingKey("TYR_SEVERITY"), "severity.threshold");
    assert.equal(suggestSettingKey("threshold"), "severity.threshold");
    assert.equal(suggestSettingKey("apikey"), "ai.apiKey");
    assert.equal(suggestSettingKey("ai.modle"), "ai.model");
    assert.equal(suggestSettingKey("completely.unrelated.thing"), null);
    assert.equal(suggestSettingKey(""), null);
});
