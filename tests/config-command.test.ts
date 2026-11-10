// `tyr config` (cli/commands/config.ts) and the edits behind it
// (cli/core/settings-edit.ts). The core functions are driven directly with an
// explicit env; the CLI tests spawn the compiled binary with a scrubbed
// environment and a temp TYR_CONFIG_HOME. Neither ever touches ~/.config.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_CODES, TyrError } from "../cli/core/errors.js";
import { locateProject, setSetting, settingsFileFor, unsetSetting } from "../cli/core/settings-edit.js";
import { makeProject, removeProject } from "./helpers.js";

interface Fixture {
    root: string;
    home: string;
    env: NodeJS.ProcessEnv;
    projectFile: string;
    globalFile: string;
}

/** An "initialized" project (tyr.json + starter settings.json) and an empty config home. */
async function withProject(fn: (fixture: Fixture) => Promise<void>, options: { initialized?: boolean } = {}): Promise<void> {
    const files: Record<string, string> = { "package.json": "{}\n" };
    if (options.initialized !== false) {
        files[".tyr/tyr.json"] = "{}\n";
        files[".tyr/settings.json"] = '{\n  "version": 1\n}\n';
    }
    const root = await makeProject(files);
    const home = await makeProject({});
    try {
        await fn({
            root,
            home,
            env: { TYR_CONFIG_HOME: home },
            projectFile: path.join(root, ".tyr", "settings.json"),
            globalFile: path.join(home, "config.json"),
        });
    } finally {
        await removeProject(root);
        await removeProject(home);
    }
}

async function readJson(file: string): Promise<unknown> {
    return JSON.parse(await fs.readFile(file, "utf8"));
}

async function rejectsWith(promise: Promise<unknown>, exitCode: number, message: RegExp): Promise<TyrError> {
    try {
        await promise;
    } catch (error) {
        assert.ok(error instanceof TyrError, `expected a TyrError, got ${String(error)}`);
        assert.equal(error.exitCode, exitCode, error.message);
        assert.match(error.message, message);
        return error;
    }
    assert.fail("expected a rejection");
}

/* -------------------------------------------------------------------------
 * Core: setSetting / unsetSetting
 * ---------------------------------------------------------------------- */

test("set writes the project file, keeps version first and other keys intact", async () => {
    await withProject(async ({ root, env, projectFile }) => {
        const first = await setSetting("checks.lint", "off", { scope: "project", root, env });
        assert.equal(first.changed, true);
        assert.equal(first.file, projectFile);
        assert.equal(first.previous, undefined);
        assert.equal(first.value, false);
        assert.deepEqual(first.effective, { value: false, origin: { layer: "project", source: projectFile } });
        assert.equal(first.shadowedBy, null);

        await setSetting("severity.threshold", "error", { scope: "project", root, env });
        assert.deepEqual(await readJson(projectFile), {
            version: 1,
            checks: { lint: false },
            severity: { threshold: "error" },
        });
        assert.match(await fs.readFile(projectFile, "utf8"), /^\{\n {2}"version": 1,/);

        const again = await setSetting("checks.lint", "false", { scope: "project", root, env });
        assert.equal(again.changed, false, "setting the same value is a no-op");
    });
});

test("unset removes only that key and reports the value that now applies", async () => {
    await withProject(async ({ root, env, projectFile, globalFile }) => {
        await setSetting("checks.lint", "false", { scope: "global", root, env });
        await setSetting("checks.lint", "true", { scope: "project", root, env });
        await setSetting("checks.test", "false", { scope: "project", root, env });

        const edit = await unsetSetting("checks.lint", { scope: "project", root, env });
        assert.equal(edit.changed, true);
        assert.equal(edit.previous, true);
        assert.equal(edit.value, undefined);
        assert.deepEqual(edit.effective, { value: false, origin: { layer: "global", source: globalFile } });
        assert.deepEqual(await readJson(projectFile), { version: 1, checks: { test: false } });

        const missing = await unsetSetting("checks.lint", { scope: "project", root, env });
        assert.equal(missing.changed, false);
    });
});

test("--global writes the per-user file (0600) and can hold the API key", async () => {
    await withProject(async ({ root, env, globalFile }) => {
        const edit = await setSetting("ai.apiKey", "sk-ant-api03-0123456789wxyz", { scope: "global", root, env });
        assert.equal(edit.file, globalFile);
        assert.deepEqual(await readJson(globalFile), { version: 1, ai: { apiKey: "sk-ant-api03-0123456789wxyz" } });
        if (process.platform !== "win32") {
            assert.equal((await fs.stat(globalFile)).mode & 0o777, 0o600);
        }
        // Works without a project too.
        const noProject = await setSetting("ai.model", "m-1", { scope: "global", root: null, env });
        assert.equal(noProject.changed, true);
        await unsetSetting("ai.apiKey", { scope: "global", root: null, env });
        assert.deepEqual(await readJson(globalFile), { version: 1, ai: { model: "m-1" } });
    });
});

test("a secret is refused for the project file, with a hint, and nothing is written", async () => {
    await withProject(async ({ root, env, projectFile }) => {
        const before = await fs.readFile(projectFile, "utf8");
        const error = await rejectsWith(
            setSetting("ai.apiKey", "sk-secret-value-1234", { scope: "project", root, env }),
            EXIT_CODES.USAGE,
            /ai\.apiKey is a secret/,
        );
        assert.match(error.hint ?? "", /--global/);
        assert.match(error.hint ?? "", /TYR_API_KEY/);
        assert.ok(!error.message.includes("sk-secret-value-1234"));
        assert.equal(await fs.readFile(projectFile, "utf8"), before);
    });
});

test("unknown keys are a usage error with a suggestion and the list of keys", async () => {
    await withProject(async ({ root, env }) => {
        const error = await rejectsWith(
            setSetting("chekcs.lint", "false", { scope: "project", root, env }),
            EXIT_CODES.USAGE,
            /Unknown setting "chekcs\.lint"\. Did you mean "checks\.lint"\?/,
        );
        assert.match(error.hint ?? "", /checks\.build, checks\.test/);
    });
});

test("invalid values are a usage error naming what the key accepts", async () => {
    await withProject(async ({ root, env }) => {
        const error = await rejectsWith(
            setSetting("severity.threshold", "fatal", { scope: "project", root, env }),
            EXIT_CODES.USAGE,
            /one of info, warning, error/,
        );
        assert.match(error.hint ?? "", /info\|warning\|error/);
    });
});

test("notifications.targets: none and \"\" both store an empty list", async () => {
    await withProject(async ({ root, env, projectFile }) => {
        for (const raw of ["none", ""]) {
            await setSetting("notifications.targets", "terminal", { scope: "project", root, env });
            const edit = await setSetting("notifications.targets", raw, { scope: "project", root, env });
            assert.deepEqual(edit.value, []);
            assert.deepEqual(await readJson(projectFile), { version: 1, notifications: { targets: [] } });
        }
    });
});

test("project writes need an initialized project (NOT_INITIALIZED)", async () => {
    await withProject(
        async ({ root, env }) => {
            const location = await locateProject(root);
            assert.deepEqual(location, { root, initialized: false });
            await rejectsWith(
                setSetting("checks.lint", "false", { scope: "project", root: null, env }),
                EXIT_CODES.NOT_INITIALIZED,
                /not initialized/,
            );
        },
        { initialized: false },
    );
});

test("a malformed file is never rewritten (CONFIG), project or global", async () => {
    await withProject(async ({ root, env, projectFile, globalFile }) => {
        const broken = '{ "checks": { "lint": false },\n';
        await fs.writeFile(projectFile, broken);
        await fs.writeFile(globalFile, broken);
        await rejectsWith(setSetting("checks.test", "false", { scope: "project", root, env }), EXIT_CODES.CONFIG, /malformed JSON/);
        await rejectsWith(unsetSetting("checks.lint", { scope: "project", root, env }), EXIT_CODES.CONFIG, /malformed JSON/);
        await rejectsWith(setSetting("checks.test", "false", { scope: "global", root, env }), EXIT_CODES.CONFIG, /malformed JSON/);
        assert.equal(await fs.readFile(projectFile, "utf8"), broken);
        assert.equal(await fs.readFile(globalFile, "utf8"), broken);
    });
});

test("problems a rewrite would silently drop block it; the edited key's own bad value does not", async () => {
    await withProject(async ({ root, env, projectFile, globalFile }) => {
        const doc = { version: 1, checks: { lint: "no" }, mystery: true };
        await fs.writeFile(projectFile, JSON.stringify(doc));
        const error = await rejectsWith(
            setSetting("checks.test", "false", { scope: "project", root, env }),
            EXIT_CODES.CONFIG,
            /checks\.lint must be a boolean; unknown setting "mystery"/,
        );
        assert.match(error.hint ?? "", /tyr config path/);
        assert.deepEqual(await readJson(projectFile), doc);

        // Fixing checks.lint itself is allowed once the unknown key is gone.
        await fs.writeFile(projectFile, JSON.stringify({ version: 1, checks: { lint: "no" } }));
        await setSetting("checks.lint", "false", { scope: "project", root, env });
        assert.deepEqual(await readJson(projectFile), { version: 1, checks: { lint: false } });

        // A secret committed by mistake blocks other edits but can be unset.
        await fs.writeFile(projectFile, JSON.stringify({ version: 1, ai: { apiKey: "sk-oops-000000000" } }));
        await rejectsWith(setSetting("checks.lint", "false", { scope: "project", root, env }), EXIT_CODES.CONFIG, /secret ai\.apiKey/);
        await unsetSetting("ai.apiKey", { scope: "project", root, env });
        assert.deepEqual(await readJson(projectFile), { version: 1 });

        // The global writer keeps unknown keys, so they do not block it.
        await fs.writeFile(globalFile, JSON.stringify({ version: 1, future: { flag: 1 } }));
        const edit = await setSetting("ai.model", "m", { scope: "global", root, env });
        assert.deepEqual(edit.notes, ["Kept keys this Tyr does not know: future.flag"]);
        assert.deepEqual(await readJson(globalFile), { version: 1, ai: { model: "m" }, future: { flag: 1 } });
    });
});

test("a file from a newer Tyr is never rewritten", async () => {
    await withProject(async ({ root, env, projectFile, globalFile }) => {
        await fs.writeFile(projectFile, JSON.stringify({ version: 99 }));
        await fs.writeFile(globalFile, JSON.stringify({ version: 99 }));
        await rejectsWith(setSetting("checks.lint", "false", { scope: "project", root, env }), EXIT_CODES.CONFIG, /newer Tyr/);
        await rejectsWith(setSetting("checks.lint", "false", { scope: "global", root, env }), EXIT_CODES.CONFIG, /newer Tyr/);
    });
});

test("a higher layer that still overrides the edit is reported as shadowedBy", async () => {
    await withProject(async ({ root, env, projectFile }) => {
        const withEnv = { ...env, TYR_CHECKS_LINT: "1" };
        const edit = await setSetting("checks.lint", "false", { scope: "project", root, env: withEnv });
        assert.deepEqual(edit.shadowedBy, { layer: "env", source: "TYR_CHECKS_LINT" });
        assert.equal(edit.effective.value, true);

        const global = await setSetting("checks.lint", "true", { scope: "global", root, env });
        assert.deepEqual(global.shadowedBy, { layer: "project", source: projectFile });
    });
});

test("settingsFileFor names the project file or the global file", async () => {
    await withProject(async ({ root, env, projectFile, globalFile }) => {
        assert.equal(settingsFileFor("project", root, { env }), projectFile);
        assert.equal(settingsFileFor("project", null, { env }), null);
        assert.equal(settingsFileFor("global", null, { env }), globalFile);
    });
});

/* -------------------------------------------------------------------------
 * The compiled CLI
 * ---------------------------------------------------------------------- */

// Compiled to .test-build/tests/; the CLI is compiled beside it.
const CLI = fileURLToPath(new URL("../cli/index.js", import.meta.url));

/** process.env without anything that would change Tyr's settings. */
function cleanEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(process.env)) {
        if (name.startsWith("TYR_") || name === "ANTHROPIC_API_KEY" || name === "XDG_CONFIG_HOME") continue;
        env[name] = value;
    }
    return { ...env, ...extra };
}

function tyr(fixture: Fixture, args: string[], options: { env?: NodeJS.ProcessEnv; input?: string } = {}) {
    const result = spawnSync(process.execPath, [CLI, ...args], {
        cwd: fixture.root,
        encoding: "utf8",
        input: options.input ?? "",
        env: cleanEnv({ ...fixture.env, ...options.env }),
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("tyr config get prints the bare value; --show-origin and --json add the origin", async () => {
    await withProject(async (fixture) => {
        assert.deepEqual(tyr(fixture, ["config", "get", "checks.lint"]), { status: 0, stdout: "true\n", stderr: "" });
        assert.equal(tyr(fixture, ["config", "get", "checks.lint", "--show-origin"]).stdout, "default\ttrue\n");
        assert.equal(tyr(fixture, ["config", "get", "notifications.targets"]).stdout, "terminal\n");

        const env = tyr(fixture, ["config", "get", "severity.threshold", "--show-origin"], { env: { TYR_SEVERITY: "error" } });
        assert.equal(env.stdout, "env:TYR_SEVERITY\terror\n");

        const json = JSON.parse(tyr(fixture, ["config", "get", "notifications.targets", "--json"]).stdout);
        assert.deepEqual(json, {
            ok: true,
            key: "notifications.targets",
            value: ["terminal"],
            origin: { layer: "default", source: "default" },
            warnings: [],
            errors: [],
        });
    });
});

test("tyr config get: unknown key exits 2 with a suggestion; --json gets a JSON error", async () => {
    await withProject(async (fixture) => {
        const text = tyr(fixture, ["config", "get", "severity"]);
        assert.equal(text.status, EXIT_CODES.USAGE);
        assert.equal(text.stdout, "");
        assert.match(text.stderr, /Unknown setting "severity"\./);
        assert.match(text.stderr, /hint: Valid keys: checks\.build/);

        const json = tyr(fixture, ["config", "get", "chekcs.lint", "--json"]);
        assert.equal(json.status, EXIT_CODES.USAGE);
        assert.equal(JSON.parse(json.stdout).error.code, "USAGE");
        assert.match(JSON.parse(json.stdout).error.message, /Did you mean "checks\.lint"/);
    });
});

test("tyr config set / unset round-trip through the project file", async () => {
    await withProject(async (fixture) => {
        const set = tyr(fixture, ["config", "set", "checks.lint", "false"]);
        assert.equal(set.status, 0, set.stderr);
        assert.match(set.stdout, /Set checks\.lint = false in \.tyr\/settings\.json/);
        assert.equal(tyr(fixture, ["config", "get", "checks.lint"]).stdout, "false\n");

        const none = tyr(fixture, ["config", "set", "notifications.targets", "none"]);
        assert.equal(none.status, 0, none.stderr);
        assert.equal(tyr(fixture, ["config", "get", "notifications.targets"]).stdout, "\n");
        assert.deepEqual(await readJson(fixture.projectFile), {
            version: 1,
            checks: { lint: false },
            notifications: { targets: [] },
        });

        const unset = tyr(fixture, ["config", "unset", "checks.lint"]);
        assert.equal(unset.status, 0, unset.stderr);
        assert.match(unset.stdout, /Removed checks\.lint/);
        assert.match(unset.stdout, /Effective value: true \(default\)/);

        const json = JSON.parse(tyr(fixture, ["config", "set", "agent.permission", "edit", "--json"]).stdout);
        assert.equal(json.ok, true);
        assert.equal(json.scope, "project");
        assert.equal(json.value, "edit");
        assert.equal(json.changed, true);
        assert.deepEqual(json.warnings, []);
    });
});

test("tyr config set --global stores the API key; every display masks it unless --reveal", async () => {
    await withProject(async (fixture) => {
        const key = "sk-ant-api03-abcdefghijklmnopWXYZ";
        const set = tyr(fixture, ["config", "set", "--global", "ai.apiKey", "-"], { input: `${key}\n` });
        assert.equal(set.status, 0, set.stderr);
        assert.match(set.stdout, /Set ai\.apiKey = sk-…WXYZ/);
        assert.ok(!set.stdout.includes(key));
        assert.deepEqual(await readJson(fixture.globalFile), { version: 1, ai: { apiKey: key } });

        assert.equal(tyr(fixture, ["config", "get", "ai.apiKey"]).stdout, "sk-…WXYZ\n");
        assert.equal(tyr(fixture, ["config", "get", "ai.apiKey", "--reveal"]).stdout, `${key}\n`);
        const list = tyr(fixture, ["config", "list"]);
        assert.ok(!list.stdout.includes(key));
        assert.match(list.stdout, /ai\.apiKey\s+sk-…WXYZ\s+global \(/);
        const listJson = JSON.parse(tyr(fixture, ["config", "--json"]).stdout);
        const row = listJson.settings.find((r: { key: string }) => r.key === "ai.apiKey");
        assert.deepEqual(row, {
            key: "ai.apiKey",
            value: "sk-…WXYZ",
            layer: "global",
            source: fixture.globalFile,
            env: "TYR_API_KEY",
            secret: true,
            masked: true,
        });
    });
});

test("tyr config set ai.apiKey without --global exits 2 with a hint", async () => {
    await withProject(async (fixture) => {
        const result = tyr(fixture, ["config", "set", "ai.apiKey", "sk-ant-api03-abcdefghijkl"]);
        assert.equal(result.status, EXIT_CODES.USAGE);
        assert.match(result.stderr, /ai\.apiKey is a secret/);
        assert.match(result.stderr, /hint: .*--global.*TYR_API_KEY/);
        assert.ok(!result.stderr.includes("sk-ant-api03-abcdefghijkl"));
    });
});

test("tyr config set warns when an env var overrides the key in this shell", async () => {
    await withProject(async (fixture) => {
        const result = tyr(fixture, ["config", "set", "checks.lint", "false"], { env: { TYR_CHECKS_LINT: "true" } });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /TYR_CHECKS_LINT is set in this environment and overrides checks\.lint/);
        assert.deepEqual(await readJson(fixture.projectFile), { version: 1, checks: { lint: false } });

        const json = JSON.parse(
            tyr(fixture, ["config", "set", "checks.test", "false", "--json"], { env: { TYR_CHECKS_TEST: "1" } }).stdout,
        );
        assert.deepEqual(json.shadowedBy, { layer: "env", source: "TYR_CHECKS_TEST" });
        assert.equal(json.warnings.length, 1);
    });
});

test("tyr config set exits 3 before tyr init, and works with --global", async () => {
    await withProject(
        async (fixture) => {
            const result = tyr(fixture, ["config", "set", "checks.lint", "false"]);
            assert.equal(result.status, EXIT_CODES.NOT_INITIALIZED);
            assert.match(result.stderr, /not initialized/);
            assert.match(result.stderr, /hint: Run "tyr init" first, or pass --global/);
            assert.equal(tyr(fixture, ["config", "set", "-g", "checks.lint", "false"]).status, 0);
            // The project layer is simply absent; reading still works.
            assert.equal(tyr(fixture, ["config", "get", "checks.lint", "--show-origin"]).stdout, `global:${fixture.globalFile}\tfalse\n`);
        },
        { initialized: false },
    );
});

test("tyr config set refuses a malformed file with exit 4; list reports it and keeps going", async () => {
    await withProject(async (fixture) => {
        const broken = '{ "checks": ';
        await fs.writeFile(fixture.projectFile, broken);
        const set = tyr(fixture, ["config", "set", "checks.lint", "false"]);
        assert.equal(set.status, EXIT_CODES.CONFIG);
        assert.match(set.stderr, /Refusing to rewrite .*settings\.json: malformed JSON/);
        assert.equal(await fs.readFile(fixture.projectFile, "utf8"), broken);

        const list = tyr(fixture, ["config"]);
        assert.equal(list.status, 0);
        assert.match(list.stdout, /^KEY\s+VALUE\s+ORIGIN\n/);
        assert.match(list.stderr, /malformed JSON.*\(file ignored\)/);
    });
});

test("tyr config path prints the project or global file", async () => {
    await withProject(async (fixture) => {
        assert.deepEqual(tyr(fixture, ["config", "path"]), { status: 0, stdout: `${fixture.projectFile}\n`, stderr: "" });
        const global = tyr(fixture, ["config", "path", "--global"]);
        assert.equal(global.stdout, `${fixture.globalFile}\n`);
        assert.match(global.stderr, /does not exist yet/);
        assert.deepEqual(JSON.parse(tyr(fixture, ["config", "path", "--json"]).stdout), {
            ok: true,
            scope: "project",
            file: fixture.projectFile,
            exists: true,
        });
    });
});

test("a mistyped subcommand is a usage error, not a silent list", async () => {
    await withProject(async (fixture) => {
        const result = tyr(fixture, ["config", "lsit"]);
        assert.equal(result.status, EXIT_CODES.USAGE);
        assert.equal(result.stdout, "");
    });
});
