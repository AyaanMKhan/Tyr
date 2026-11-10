import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { Command } from "commander";
import {
    ANTHROPIC_API_KEY_ENV,
    applyEnvGlobals,
    ENV_VARS,
    JSON_ENV,
    QUIET_ENV,
    readEnvSettings,
    VERBOSE_ENV,
} from "../cli/core/env-settings.js";
import { readGlobals, registerGlobalOptions, verbosityOf } from "../cli/core/globals.js";
import { getLogLevel, LOG_LEVEL_ENV, setLogLevel } from "../cli/core/log.js";
import { SETTING_KEYS } from "../cli/core/settings-types.js";

/* ----------------------------- settings ----------------------------- */

test("an empty environment yields an empty patch", () => {
    assert.deepEqual(readEnvSettings({}), { patch: {}, sources: {}, warnings: [] });
});

test("boolean variables accept every spelling, case-insensitively", () => {
    for (const [raw, value] of [
        ["true", true], ["1", true], ["yes", true], ["on", true], ["TRUE", true], [" Yes ", true],
        ["false", false], ["0", false], ["no", false], ["off", false], ["Off", false],
    ] as const) {
        const { patch, sources, warnings } = readEnvSettings({ TYR_CHECKS_TEST: raw });
        assert.deepEqual(patch, { checks: { test: value } }, raw);
        assert.deepEqual(sources, { "checks.test": "TYR_CHECKS_TEST" });
        assert.deepEqual(warnings, []);
    }
});

test("every settings key is read from its own variable", () => {
    const { patch, sources, warnings } = readEnvSettings({
        TYR_CHECKS_BUILD: "0",
        TYR_CHECKS_TEST: "1",
        TYR_CHECKS_LINT: "no",
        TYR_CHECKS_FORMAT: "yes",
        TYR_CHECKS_TYPECHECK: "off",
        TYR_SEVERITY: "error",
        TYR_AGENT_PERMISSION: "read-only",
        TYR_NOTIFY: "terminal, desktop",
        TYR_MODEL: " claude-sonnet-5 ",
        TYR_API_KEY: "sk-test",
    });
    assert.deepEqual(warnings, []);
    assert.deepEqual(patch, {
        checks: { build: false, test: true, lint: false, format: true, typecheck: false },
        severity: { threshold: "error" },
        agent: { permission: "read-only" },
        notifications: { targets: ["terminal", "desktop"] },
        ai: { model: "claude-sonnet-5", apiKey: "sk-test" },
    });
    for (const spec of SETTING_KEYS) assert.equal(sources[spec.key], spec.env);
});

test("invalid values warn with the variable name and are ignored", () => {
    const { patch, sources, warnings } = readEnvSettings({
        TYR_CHECKS_LINT: "maybe",
        TYR_SEVERITY: "fatal",
        TYR_AGENT_PERMISSION: "Edit", // enums are case-sensitive, like the JSON files
        TYR_NOTIFY: " , ,",
        TYR_CHECKS_TEST: "false",
    });
    assert.deepEqual(patch, { checks: { test: false } });
    assert.deepEqual(Object.keys(sources), ["checks.test"]);
    assert.equal(warnings.length, 4);
    assert.match(warnings[0], /^TYR_CHECKS_LINT: checks\.lint must be true or false, got "maybe"; ignored$/);
    assert.match(warnings[1], /^TYR_SEVERITY: .*one of info, warning, error.*"fatal"/);
    assert.match(warnings[2], /^TYR_AGENT_PERMISSION: .*"Edit"/);
    assert.match(warnings[3], /^TYR_NOTIFY: .*use "none"/);
});

test("empty or whitespace-only variables are treated as unset", () => {
    const empty = Object.fromEntries(SETTING_KEYS.map((spec) => [spec.env, ""]));
    assert.deepEqual(readEnvSettings(empty), { patch: {}, sources: {}, warnings: [] });
    const blank = Object.fromEntries(SETTING_KEYS.map((spec) => [spec.env, "  \t"]));
    assert.deepEqual(readEnvSettings(blank), { patch: {}, sources: {}, warnings: [] });
});

test("TYR_NOTIFY=none is the explicit empty list", () => {
    for (const raw of ["none", "NONE", " None "]) {
        assert.deepEqual(readEnvSettings({ TYR_NOTIFY: raw }).patch, { notifications: { targets: [] } });
    }
    // Empty entries are dropped, values keep their own case.
    assert.deepEqual(readEnvSettings({ TYR_NOTIFY: "terminal,,webhook:https://x.test/A" }).patch, {
        notifications: { targets: ["terminal", "webhook:https://x.test/A"] },
    });
});

test("ai.apiKey falls back to ANTHROPIC_API_KEY, and TYR_API_KEY wins", () => {
    let result = readEnvSettings({ [ANTHROPIC_API_KEY_ENV]: "sk-anthropic" });
    assert.deepEqual(result.patch, { ai: { apiKey: "sk-anthropic" } });
    assert.deepEqual(result.sources, { "ai.apiKey": "ANTHROPIC_API_KEY" });

    result = readEnvSettings({ TYR_API_KEY: "sk-tyr", [ANTHROPIC_API_KEY_ENV]: "sk-anthropic" });
    assert.deepEqual(result.patch, { ai: { apiKey: "sk-tyr" } });
    assert.deepEqual(result.sources, { "ai.apiKey": "TYR_API_KEY" });

    // An empty TYR_API_KEY is unset, so the fallback still applies.
    result = readEnvSettings({ TYR_API_KEY: "", [ANTHROPIC_API_KEY_ENV]: "sk-anthropic" });
    assert.deepEqual(result.sources, { "ai.apiKey": "ANTHROPIC_API_KEY" });

    // Neither set (or both empty): no key, never null.
    assert.deepEqual(readEnvSettings({ TYR_API_KEY: "", [ANTHROPIC_API_KEY_ENV]: " " }).patch, {});
});

test("secret values never appear in warnings", () => {
    const secret = "sk-very-secret-value";
    const { warnings } = readEnvSettings({
        TYR_API_KEY: secret,
        TYR_SEVERITY: "bogus",
        TYR_CHECKS_TEST: "nah",
    });
    assert.equal(warnings.length, 2);
    for (const warning of warnings) assert.ok(!warning.includes(secret));
});

test("readEnvSettings never throws and does not modify its input", () => {
    const env = { TYR_CHECKS_TEST: "1", TYR_NOTIFY: "a" } as NodeJS.ProcessEnv;
    const copy = { ...env };
    readEnvSettings(env);
    assert.deepEqual(env, copy);
    assert.doesNotThrow(() => readEnvSettings({ TYR_MODEL: "\u0000", TYR_SEVERITY: "\n" }));
});

test("ENV_VARS lists every settings variable, the fallback and the global options", () => {
    const names = ENV_VARS.map((v) => v.name);
    for (const spec of SETTING_KEYS) assert.ok(names.includes(spec.env), spec.env);
    for (const name of [ANTHROPIC_API_KEY_ENV, QUIET_ENV, VERBOSE_ENV, JSON_ENV, LOG_LEVEL_ENV]) {
        assert.ok(names.includes(name), name);
    }
    assert.equal(new Set(names).size, names.length);
    const secrets = ENV_VARS.filter((v) => v.secret).map((v) => v.name);
    assert.deepEqual(secrets.sort(), ["ANTHROPIC_API_KEY", "TYR_API_KEY"]);
});

/* ----------------------------- global options ----------------------------- */

test("TYR_QUIET / TYR_VERBOSE / TYR_JSON fill in unset flags", () => {
    assert.deepEqual(applyEnvGlobals({}, {}), { options: {}, warnings: [] });
    assert.deepEqual(applyEnvGlobals({}, { TYR_QUIET: "1" }).options, { quiet: true });
    assert.deepEqual(applyEnvGlobals({}, { TYR_VERBOSE: "yes" }).options, { verbose: true });
    assert.deepEqual(applyEnvGlobals({}, { TYR_JSON: "true" }).options, { json: true });
    // false / empty change nothing.
    assert.deepEqual(applyEnvGlobals({}, { TYR_QUIET: "0", TYR_VERBOSE: "", TYR_JSON: "off" }).options, {});
});

test("an explicit flag wins over the env variables", () => {
    assert.deepEqual(applyEnvGlobals({ verbose: true }, { TYR_QUIET: "1" }).options, { verbose: true });
    assert.deepEqual(applyEnvGlobals({ quiet: true }, { TYR_VERBOSE: "1" }).options, { quiet: true });
    assert.deepEqual(applyEnvGlobals({ json: true }, { TYR_JSON: "0" }).options, { json: true });
});

test("conflicting or invalid env globals warn and are ignored", () => {
    let result = applyEnvGlobals({}, { TYR_QUIET: "1", TYR_VERBOSE: "1" });
    assert.deepEqual(result.options, {});
    assert.match(result.warnings[0], /TYR_QUIET and TYR_VERBOSE are both set/);

    result = applyEnvGlobals({}, { TYR_JSON: "please" });
    assert.deepEqual(result.options, {});
    assert.deepEqual(result.warnings, ['TYR_JSON: must be true or false, got "please"; ignored']);
});

test("TYR_VERBOSE implies debug logging unless a level is set more specifically", () => {
    assert.equal(applyEnvGlobals({}, { TYR_VERBOSE: "1" }).options.logLevel, undefined);
    assert.equal(applyEnvGlobals({}, { TYR_VERBOSE: "1", TYR_LOG_LEVEL: "warn" }).options.logLevel, "warn");
    assert.equal(applyEnvGlobals({}, { TYR_VERBOSE: "1", TYR_LOG_LEVEL: "bad" }).options.logLevel, undefined);
    assert.equal(
        applyEnvGlobals({ logLevel: "error" }, { TYR_VERBOSE: "1", TYR_LOG_LEVEL: "warn" }).options.logLevel,
        "error",
    );
});

const ENV_NAMES = [QUIET_ENV, VERBOSE_ENV, JSON_ENV, LOG_LEVEL_ENV];
const savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));

afterEach(() => {
    setLogLevel(undefined);
    for (const name of ENV_NAMES) {
        if (savedEnv[name] === undefined) delete process.env[name];
        else process.env[name] = savedEnv[name];
    }
});

test("readGlobals and the preAction hook apply the env variables end to end", async () => {
    const run = async (args: string[]) => {
        const program = new Command().exitOverride();
        registerGlobalOptions(program);
        let seen = { verbosity: "", json: false, level: "" };
        program.command("noop").action((_opts, command: Command) => {
            const globals = readGlobals(command);
            seen = { verbosity: verbosityOf(globals), json: globals.json === true, level: getLogLevel() };
        });
        await program.parseAsync(["node", "tyr", ...args]);
        return seen;
    };

    for (const name of ENV_NAMES) delete process.env[name];
    assert.deepEqual(await run(["noop"]), { verbosity: "normal", json: false, level: "info" });

    process.env[QUIET_ENV] = "1";
    assert.deepEqual(await run(["noop"]), { verbosity: "quiet", json: false, level: "info" });
    // --verbose beats TYR_QUIET instead of tripping commander's conflict check.
    assert.deepEqual(await run(["--verbose", "noop"]), { verbosity: "verbose", json: false, level: "debug" });

    delete process.env[QUIET_ENV];
    process.env[VERBOSE_ENV] = "1";
    assert.deepEqual(await run(["noop"]), { verbosity: "verbose", json: false, level: "debug" });
    process.env[LOG_LEVEL_ENV] = "warn";
    assert.deepEqual(await run(["noop"]), { verbosity: "verbose", json: false, level: "warn" });

    delete process.env[VERBOSE_ENV];
    process.env[JSON_ENV] = "1";
    assert.deepEqual(await run(["noop"]), { verbosity: "quiet", json: true, level: "warn" });
});
