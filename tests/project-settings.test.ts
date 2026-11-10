// `.tyr/settings.json`: the project settings layer (project-settings.ts) and
// its creation by scaffold().

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
    CURRENT_SETTINGS_VERSION,
    initialProjectSettings,
    loadProjectSettings,
    writeProjectSettings,
} from "../cli/core/project-settings.js";
import { resolveTyrPaths, scaffold } from "../cli/core/scaffold.js";
import type { SettingsPatch } from "../cli/core/settings-types.js";
import { InitSnapshot, ProjectProfile } from "../cli/core/types.js";
import { makeProject, removeProject } from "./helpers.js";

const JEST = { tool: "Jest", command: "npm run test", evidence: "jest.config.js" };
const TSC = { tool: "tsc", command: "npx tsc --noEmit", evidence: "tsconfig.json" };

function snapshotWith(project: Partial<ProjectProfile>, root: string): InitSnapshot {
    return {
        discovery: { root: path.resolve(root), alreadyInitialized: false, files: [], fileCount: 0, skippedDirs: [] },
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

/** A project whose `.tyr/settings.json` holds `contents` (raw text). */
async function withSettings(contents: string, run: (root: string) => Promise<void>): Promise<void> {
    const root = await makeProject({ ".tyr/settings.json": contents });
    try {
        await run(root);
    } finally {
        await removeProject(root);
    }
}

async function readSettingsText(root: string): Promise<string> {
    return fs.readFile(resolveTyrPaths(root).settingsFile, "utf8");
}

test("missing settings.json loads as an empty patch", async () => {
    const root = await makeProject({});
    try {
        assert.deepEqual(await loadProjectSettings(root), { patch: {}, missing: true, warnings: [], errors: [] });
    } finally {
        await removeProject(root);
    }
});

test("settings round-trip with version first and a stable key order", async () => {
    const root = await makeProject({});
    try {
        // Deliberately out of SETTING_KEYS order.
        const patch: SettingsPatch = {
            notifications: { targets: ["terminal", "desktop"] },
            ai: { model: "claude-sonnet-5" },
            checks: { lint: false, build: true },
            agent: { permission: "read-only" },
            severity: { threshold: "error" },
        };
        await writeProjectSettings(root, patch);

        const loaded = await loadProjectSettings(root);
        assert.deepEqual(loaded, { patch, missing: false, warnings: [], errors: [] });

        const text = await readSettingsText(root);
        assert.ok(text.endsWith("}\n"));
        assert.deepEqual(Object.keys(JSON.parse(text)), ["version", "checks", "severity", "agent", "notifications", "ai"]);
        assert.deepEqual(Object.keys(JSON.parse(text).checks), ["build", "lint"]);
        assert.equal(JSON.parse(text).version, CURRENT_SETTINGS_VERSION);

        // Same patch in a different order writes byte-identical output.
        await writeProjectSettings(root, { severity: patch.severity, checks: { build: true, lint: false }, ...patch });
        assert.equal(await readSettingsText(root), text);
    } finally {
        await removeProject(root);
    }
});

test("a missing version reads as version 1", async () => {
    await withSettings(JSON.stringify({ checks: { test: false } }), async (root) => {
        const loaded = await loadProjectSettings(root);
        assert.deepEqual(loaded.patch, { checks: { test: false } });
        assert.deepEqual(loaded.warnings, []);
    });
});

test("unknown keys and bad values are warnings; the rest still applies", async () => {
    const doc = { version: 1, checks: { test: false, lint: "yes" }, colour: "blue", severity: { threshold: "loud" } };
    await withSettings(JSON.stringify(doc), async (root) => {
        const loaded = await loadProjectSettings(root);
        assert.deepEqual(loaded.patch, { checks: { test: false } });
        assert.deepEqual(loaded.errors, []);
        assert.equal(loaded.warnings.length, 3);
        assert.ok(loaded.warnings.some((w) => /unknown setting "colour"/.test(w)));
        assert.ok(loaded.warnings.some((w) => /checks\.lint must be a boolean/.test(w)));
        assert.ok(loaded.warnings.some((w) => /severity\.threshold must be one of/.test(w)));
    });
});

test("a secret in settings.json is ignored with a warning, even null", async () => {
    for (const apiKey of ["sk-live-123", null]) {
        await withSettings(JSON.stringify({ version: 1, ai: { apiKey, model: "m" } }), async (root) => {
            const loaded = await loadProjectSettings(root);
            assert.deepEqual(loaded.patch, { ai: { model: "m" } });
            assert.equal(loaded.warnings.length, 1);
            assert.match(loaded.warnings[0], /ai\.apiKey is a secret.*committed.*ignored/);
        });
    }
});

test("writing a secret is refused and leaves the file alone", async () => {
    await withSettings(JSON.stringify({ version: 1 }), async (root) => {
        const before = await readSettingsText(root);
        await assert.rejects(
            writeProjectSettings(root, { ai: { apiKey: "sk-live-123" } }),
            /ai\.apiKey is a secret.*global config.*environment/,
        );
        await assert.rejects(writeProjectSettings(root, { ai: { apiKey: null } }), /ai\.apiKey is a secret/);
        assert.equal(await readSettingsText(root), before);
    });
});

test("writing an invalid value or unknown key is refused", async () => {
    const root = await makeProject({});
    try {
        await assert.rejects(writeProjectSettings(root, { checks: { test: "yes" } } as unknown as SettingsPatch), /checks\.test/);
        await assert.rejects(writeProjectSettings(root, { colour: "blue" } as unknown as SettingsPatch), /unknown setting "colour"/);
        assert.equal((await loadProjectSettings(root)).missing, true);
    } finally {
        await removeProject(root);
    }
});

test("a settings.json from a newer Tyr is ignored on read and never overwritten", async () => {
    const newer = JSON.stringify({ version: CURRENT_SETTINGS_VERSION + 1, checks: { test: false } });
    await withSettings(newer, async (root) => {
        const loaded = await loadProjectSettings(root);
        assert.deepEqual(loaded.patch, {});
        assert.deepEqual(loaded.errors, []);
        assert.equal(loaded.warnings.length, 1);
        assert.match(loaded.warnings[0], /newer Tyr.*upgrade Tyr/);

        await assert.rejects(writeProjectSettings(root, { checks: { test: true } }), /newer Tyr/);
        assert.equal(await readSettingsText(root), newer);
    });
});

test("malformed JSON, a non-object or a garbled version is an error, never a throw", async () => {
    for (const contents of ["{ \"checks\": ", "[1, 2]", JSON.stringify({ version: "one", checks: { test: false } })]) {
        await withSettings(contents, async (root) => {
            const loaded = await loadProjectSettings(root);
            assert.deepEqual(loaded.patch, {});
            assert.equal(loaded.missing, false);
            assert.equal(loaded.errors.length, 1);
            assert.match(loaded.errors[0], /^settings\.json: /);
        });
    }
});

test("the starter settings are empty, so nothing detection-dependent is frozen into the file", () => {
    const snapshot = snapshotWith({ test: JEST, typecheck: TSC }, "/tmp/app");
    assert.deepEqual(initialProjectSettings(snapshot), {});
});

test("scaffold creates settings.json once and keeps it on --force and --reset", async () => {
    const root = await makeProject({});
    try {
        const first = await scaffold(snapshotWith({ test: JEST }, root), "1.0.0");
        assert.equal(first.settings, "created");
        assert.equal(first.settingsFile, path.join(root, ".tyr", "settings.json"));
        assert.deepEqual(JSON.parse(await readSettingsText(root)), { version: 1 });
        const loaded = await loadProjectSettings(root);
        assert.deepEqual(loaded.warnings, []);

        // The user edits it by hand...
        const edited = '{\n  "version": 1,\n  "severity": { "threshold": "error" } // mine\n}\n';
        await fs.writeFile(first.settingsFile, edited, "utf8");

        // ...and neither a merging re-init nor a reset touches it, even though
        // it is not valid JSON any more (it is the user's to fix).
        const forced = await scaffold(snapshotWith({ test: JEST, lint: JEST }, root), "1.0.0");
        assert.equal(forced.settings, "kept");
        assert.equal(await readSettingsText(root), edited);

        const reset = await scaffold(snapshotWith({}, root), "1.0.0", { reset: true });
        assert.equal(reset.settings, "kept");
        assert.equal(await readSettingsText(root), edited);
    } finally {
        await removeProject(root);
    }
});

test(".tyr/.gitignore does not ignore settings.json", async () => {
    const root = await makeProject({});
    try {
        await scaffold(snapshotWith({}, root), "1.0.0");
        const ignore = await fs.readFile(path.join(root, ".tyr", ".gitignore"), "utf8");
        const patterns = ignore.split("\n").filter((line) => line.trim() !== "" && !line.startsWith("#"));
        assert.ok(!patterns.some((p) => /settings|\*\.json|^\*$/.test(p)), `unexpected pattern in ${JSON.stringify(patterns)}`);
    } finally {
        await removeProject(root);
    }
});
