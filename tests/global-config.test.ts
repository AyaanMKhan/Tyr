import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
    GLOBAL_CONFIG_VERSION,
    globalConfigDir,
    globalConfigFile,
    loadGlobalSettings,
    writeGlobalSettings,
    type GlobalConfigPathOptions,
} from "../cli/core/global-config.js";
import { setAtPath, unsetAtPath } from "../cli/core/settings-types.js";
import { makeProject, removeProject } from "./helpers.js";

const isWindows = process.platform === "win32";

/** A temp config home; everything goes through TYR_CONFIG_HOME, never the real home. */
async function withConfigHome(fn: (opts: GlobalConfigPathOptions, dir: string) => Promise<void>): Promise<void> {
    const root = await makeProject({});
    const dir = path.join(root, "config", "tyr");
    try {
        await fn({ env: { TYR_CONFIG_HOME: dir }, home: path.join(root, "home") }, dir);
    } finally {
        await removeProject(root);
    }
}

async function writeRaw(dir: string, contents: string, mode = 0o600): Promise<string> {
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "config.json");
    await fs.writeFile(file, contents, { encoding: "utf8", mode });
    await fs.chmod(file, mode);
    return file;
}

// ---------------------------------------------------------------- paths

test("globalConfigDir: TYR_CONFIG_HOME wins over everything", () => {
    const env = { TYR_CONFIG_HOME: "/opt/tyr-conf", XDG_CONFIG_HOME: "/xdg", APPDATA: "C:\\AppData" };
    assert.equal(globalConfigDir(env, "linux", "/home/u"), "/opt/tyr-conf");
    assert.equal(globalConfigDir(env, "darwin", "/Users/u"), "/opt/tyr-conf");
    assert.equal(
        globalConfigDir({ ...env, TYR_CONFIG_HOME: "D:\\tyr" }, "win32", "C:\\Users\\u"),
        "D:\\tyr",
    );
});

test("globalConfigDir: absolute XDG_CONFIG_HOME next, relative ignored", () => {
    assert.equal(globalConfigDir({ XDG_CONFIG_HOME: "/xdg" }, "linux", "/home/u"), "/xdg/tyr");
    assert.equal(globalConfigDir({ XDG_CONFIG_HOME: "/xdg" }, "darwin", "/Users/u"), "/xdg/tyr");
    assert.equal(globalConfigDir({ XDG_CONFIG_HOME: "rel/xdg" }, "linux", "/home/u"), "/home/u/.config/tyr");
    assert.equal(
        globalConfigDir({ XDG_CONFIG_HOME: "C:\\xdg", APPDATA: "C:\\AppData" }, "win32", "C:\\Users\\u"),
        "C:\\xdg\\tyr",
    );
});

test("globalConfigDir: platform defaults", () => {
    assert.equal(globalConfigDir({}, "linux", "/home/u"), "/home/u/.config/tyr");
    assert.equal(globalConfigDir({}, "darwin", "/Users/u"), "/Users/u/.config/tyr");
    assert.equal(
        globalConfigDir({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "win32", "C:\\Users\\u"),
        "C:\\Users\\u\\AppData\\Roaming\\tyr",
    );
    assert.equal(globalConfigDir({}, "win32", "C:\\Users\\u"), "C:\\Users\\u\\AppData\\Roaming\\tyr");
    // APPDATA only matters on Windows.
    assert.equal(globalConfigDir({ APPDATA: "/appdata" }, "linux", "/home/u"), "/home/u/.config/tyr");
});

test("globalConfigDir: empty variables count as unset", () => {
    assert.equal(
        globalConfigDir({ TYR_CONFIG_HOME: "", XDG_CONFIG_HOME: "  " }, "linux", "/home/u"),
        "/home/u/.config/tyr",
    );
});

test("globalConfigFile is config.json in the directory", () => {
    assert.equal(globalConfigFile({}, "linux", "/home/u"), "/home/u/.config/tyr/config.json");
    assert.equal(globalConfigFile({}, "win32", "C:\\Users\\u"), "C:\\Users\\u\\AppData\\Roaming\\tyr\\config.json");
});

// ---------------------------------------------------------------- load

test("loadGlobalSettings: a missing file is not an error", async () => {
    await withConfigHome(async (opts, dir) => {
        const load = await loadGlobalSettings(opts);
        assert.equal(load.file, path.join(dir, "config.json"));
        assert.equal(load.missing, true);
        assert.deepEqual(load.patch, {});
        assert.deepEqual(load.warnings, []);
        assert.deepEqual(load.errors, []);
    });
});

test("loadGlobalSettings: malformed JSON is an error with an empty patch", async () => {
    await withConfigHome(async (opts, dir) => {
        await writeRaw(dir, "{ not json");
        const load = await loadGlobalSettings(opts);
        assert.equal(load.missing, false);
        assert.deepEqual(load.patch, {});
        assert.equal(load.errors.length, 1);
        assert.match(load.errors[0], /malformed JSON/);
    });
});

test("loadGlobalSettings: non-object JSON is an error", async () => {
    await withConfigHome(async (opts, dir) => {
        await writeRaw(dir, "[1, 2]");
        const load = await loadGlobalSettings(opts);
        assert.deepEqual(load.patch, {});
        assert.equal(load.errors.length, 1);
    });
});

test("loadGlobalSettings: unknown keys and bad values warn, valid keys still apply", async () => {
    await withConfigHome(async (opts, dir) => {
        await writeRaw(
            dir,
            JSON.stringify({
                version: 1,
                checks: { lint: false, test: "yes" },
                severity: { threshold: "catastrophic" },
                ai: { model: "claude-sonnet-5" },
                colour: "blue",
            }),
        );
        const load = await loadGlobalSettings(opts);
        assert.deepEqual(load.errors, []);
        assert.deepEqual(load.patch, { checks: { lint: false }, ai: { model: "claude-sonnet-5" } });
        assert.equal(load.version, 1);
        const text = load.warnings.join("\n");
        assert.match(text, /checks\.test must be a boolean/);
        assert.match(text, /severity\.threshold must be one of/);
        assert.match(text, /unknown setting "colour"/);
        assert.doesNotMatch(text, /unknown setting "version"/);
    });
});

test("loadGlobalSettings: a missing version counts as 1", async () => {
    await withConfigHome(async (opts, dir) => {
        await writeRaw(dir, JSON.stringify({ agent: { permission: "edit" } }));
        const load = await loadGlobalSettings(opts);
        assert.equal(load.version, 1);
        assert.deepEqual(load.warnings, []);
        assert.deepEqual(load.patch, { agent: { permission: "edit" } });
    });
});

test("loadGlobalSettings: a newer version warns but is read best-effort", async () => {
    await withConfigHome(async (opts, dir) => {
        await writeRaw(dir, JSON.stringify({ version: GLOBAL_CONFIG_VERSION + 1, ai: { apiKey: "sk-x" } }));
        const load = await loadGlobalSettings(opts);
        assert.deepEqual(load.errors, []);
        assert.equal(load.version, GLOBAL_CONFIG_VERSION + 1);
        assert.match(load.warnings.join("\n"), /newer Tyr/);
        assert.deepEqual(load.patch, { ai: { apiKey: "sk-x" } });
    });
});

test("loadGlobalSettings: a garbled version warns and is treated as 1", async () => {
    await withConfigHome(async (opts, dir) => {
        await writeRaw(dir, JSON.stringify({ version: "two", ai: { model: "m" } }));
        const load = await loadGlobalSettings(opts);
        assert.equal(load.version, 1);
        assert.match(load.warnings.join("\n"), /"version" must be a positive integer/);
        assert.deepEqual(load.patch, { ai: { model: "m" } });
    });
});

test("loadGlobalSettings: a secret in a group/world-readable file warns", { skip: isWindows }, async () => {
    await withConfigHome(async (opts, dir) => {
        const file = await writeRaw(dir, JSON.stringify({ version: 1, ai: { apiKey: "sk-secret" } }), 0o644);
        const load = await loadGlobalSettings(opts);
        const warning = load.warnings.find((w) => w.includes("chmod 600"));
        assert.ok(warning, `expected a chmod warning, got ${JSON.stringify(load.warnings)}`);
        assert.match(warning, /mode 644/);
        assert.ok(!warning.includes("sk-secret"), "the warning must not echo the key");
        assert.ok(warning.includes(file));

        await fs.chmod(file, 0o600);
        const fixed = await loadGlobalSettings(opts);
        assert.deepEqual(fixed.warnings, []);
    });
});

test("loadGlobalSettings: loose permissions without a secret do not warn", { skip: isWindows }, async () => {
    await withConfigHome(async (opts, dir) => {
        await writeRaw(dir, JSON.stringify({ version: 1, ai: { model: "m", apiKey: null } }), 0o644);
        const load = await loadGlobalSettings(opts);
        assert.deepEqual(load.warnings, []);
    });
});

test("loadGlobalSettings: the permission check is skipped for platform win32", async () => {
    await withConfigHome(async (opts, dir) => {
        await writeRaw(dir, JSON.stringify({ ai: { apiKey: "sk-x" } }), 0o644);
        const load = await loadGlobalSettings({ ...opts, platform: "win32" });
        assert.deepEqual(load.warnings, []);
    });
});

// ---------------------------------------------------------------- write

test("writeGlobalSettings round-trips through loadGlobalSettings", async () => {
    await withConfigHome(async (opts) => {
        const patch = {
            ai: { apiKey: "sk-abc", model: "claude-opus-5-5" },
            notifications: { targets: ["terminal", "desktop"] },
            checks: { format: true },
        };
        const written = await writeGlobalSettings(patch, opts);
        const load = await loadGlobalSettings(opts);
        assert.equal(load.file, written.file);
        assert.deepEqual(load.errors, []);
        assert.deepEqual(load.warnings, []);
        assert.deepEqual(load.patch, patch);
        assert.equal(load.version, GLOBAL_CONFIG_VERSION);
    });
});

test("writeGlobalSettings writes version first and keys in a stable order", async () => {
    await withConfigHome(async (opts) => {
        // Deliberately scrambled insertion order.
        const { file } = await writeGlobalSettings(
            { ai: { apiKey: "k", model: "m" }, severity: { threshold: "error" }, checks: { lint: false, build: true } },
            opts,
        );
        const text = await fs.readFile(file, "utf8");
        assert.equal(
            text,
            JSON.stringify(
                {
                    version: 1,
                    checks: { build: true, lint: false },
                    severity: { threshold: "error" },
                    ai: { model: "m", apiKey: "k" },
                },
                null,
                2,
            ) + "\n",
        );
    });
});

test("writeGlobalSettings creates a 0700 directory and a 0600 file", { skip: isWindows }, async () => {
    await withConfigHome(async (opts, dir) => {
        const { file } = await writeGlobalSettings({ ai: { apiKey: "sk" } }, opts);
        assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
        assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
        // Only the target remains: no temp files left behind.
        assert.deepEqual(await fs.readdir(dir), ["config.json"]);
    });
});

test("writeGlobalSettings tightens a previously loose file", { skip: isWindows }, async () => {
    await withConfigHome(async (opts, dir) => {
        const file = await writeRaw(dir, JSON.stringify({ ai: { apiKey: "old" } }), 0o644);
        await writeGlobalSettings({ ai: { apiKey: "new" } }, opts);
        assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
        assert.deepEqual((await loadGlobalSettings(opts)).warnings, []);
    });
});

test("writeGlobalSettings supports load → set/unset → write", async () => {
    await withConfigHome(async (opts) => {
        await writeGlobalSettings({ ai: { apiKey: "sk", model: "m" } }, opts);
        let { patch } = await loadGlobalSettings(opts);
        patch = setAtPath(patch, "checks.lint", false);
        patch = unsetAtPath(patch, "ai.model");
        await writeGlobalSettings(patch, opts);
        assert.deepEqual((await loadGlobalSettings(opts)).patch, { checks: { lint: false }, ai: { apiKey: "sk" } });

        await writeGlobalSettings(unsetAtPath(unsetAtPath(patch, "ai.apiKey"), "checks.lint"), opts);
        assert.deepEqual((await loadGlobalSettings(opts)).patch, {});
    });
});

test("writeGlobalSettings carries over keys this Tyr does not know", async () => {
    await withConfigHome(async (opts, dir) => {
        await writeRaw(dir, JSON.stringify({ version: 1, ai: { model: "old", temperature: 0.2 }, future: { x: 1 } }));
        const result = await writeGlobalSettings({ ai: { model: "new" } }, opts);
        assert.deepEqual(result.preservedKeys.sort(), ["ai.temperature", "future.x"]);
        const raw = JSON.parse(await fs.readFile(result.file, "utf8"));
        assert.deepEqual(raw, { version: 1, ai: { model: "new", temperature: 0.2 }, future: { x: 1 } });
    });
});

test("writeGlobalSettings rejects an invalid patch", async () => {
    await withConfigHome(async (opts, dir) => {
        await assert.rejects(
            writeGlobalSettings({ severity: { threshold: "loud" as never } }, opts),
            /severity\.threshold must be one of/,
        );
        await assert.rejects(writeGlobalSettings({ bogus: 1 } as never, opts), /unknown setting "bogus"/);
        await assert.rejects(fs.access(path.join(dir, "config.json")));
    });
});

test("writeGlobalSettings refuses to overwrite a newer file", async () => {
    await withConfigHome(async (opts, dir) => {
        const original = JSON.stringify({ version: GLOBAL_CONFIG_VERSION + 1, ai: { apiKey: "keep" } });
        const file = await writeRaw(dir, original);
        await assert.rejects(writeGlobalSettings({ ai: { apiKey: "x" } }, opts), /newer Tyr/);
        assert.equal(await fs.readFile(file, "utf8"), original);
    });
});

test("writeGlobalSettings refuses to overwrite malformed JSON", async () => {
    await withConfigHome(async (opts, dir) => {
        const file = await writeRaw(dir, "{ oops");
        await assert.rejects(writeGlobalSettings({ ai: { model: "m" } }, opts), /malformed JSON/);
        assert.equal(await fs.readFile(file, "utf8"), "{ oops");
    });
});

test("an explicit file option bypasses directory resolution", async () => {
    await withConfigHome(async (_opts, dir) => {
        const file = path.join(dir, "elsewhere", "custom.json");
        await writeGlobalSettings({ ai: { model: "m" } }, { file });
        const load = await loadGlobalSettings({ file });
        assert.equal(load.file, file);
        assert.deepEqual(load.patch, { ai: { model: "m" } });
    });
});
