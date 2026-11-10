// Project settings: `.tyr/settings.json`, the user's preferences for this
// repository (PLANNING.md 2.7).
//
// tyr.json is the *detection snapshot* — what `tyr init` found — and is
// rewritten by every `tyr init --force`. Preferences (which checks run, the
// severity threshold, what the agent may do, where findings go) are authored
// by people, so they live in their own file that Tyr creates once and never
// regenerates. Both files are committed so a team shares them.
//
// This file is the "project" layer of the settings stack described in
// settings-types.ts (default < global < project < env). This module only
// reads and writes the file; merging the layers is the resolver's job.
//
// On disk: `{ "version": 1, ...keys nested as in TyrSettings }`. A missing
// `version` means 1. Like migrate.ts, a file from a newer Tyr is never
// rewritten (its keys may mean something this version would misread); on
// read it is ignored with a warning rather than half-applied.
//
// Secrets (SETTING_KEYS entries marked `secret`, today `ai.apiKey`) are
// refused here in both directions: this file is committed, so a key written
// to it would be published with the repository. They belong in the global
// config (~/.config/tyr/config.json) or the environment.
//
// Silent like the rest of core/: problems come back as `warnings` / `errors`
// for the caller to report, and loading never throws.

import * as fs from "node:fs/promises";
import type { InitSnapshot } from "./types.js";
import { readJsonFile, resolveTyrPaths, toJsonDocument, writeFileAtomic } from "./scaffold.js";
import { SETTING_KEYS, getAtPath, sanitizePatch, setAtPath, unsetAtPath, type SettingsPatch } from "./settings-types.js";

/** Schema version of `.tyr/settings.json` (and the shared settings-file format). */
export const CURRENT_SETTINGS_VERSION = 1;

/** The keys that may never be stored in the committed project file. */
const SECRET_KEYS: readonly string[] = SETTING_KEYS.filter((spec) => spec.secret === true).map((spec) => spec.key);

export interface ProjectSettingsLoad {
    /** Valid, non-secret settings from the file; `{}` when missing or unusable. */
    patch: SettingsPatch;
    /** True when `.tyr/settings.json` does not exist (then nothing else is reported). */
    missing: boolean;
    /** Ignored parts of an otherwise usable file: unknown keys, bad values, secrets, a newer version. */
    warnings: string[];
    /** Why the whole file was ignored: unreadable, malformed JSON, not an object, a garbled version. */
    errors: string[];
}

type VersionCheck = { kind: "ok" } | { kind: "newer"; version: number } | { kind: "invalid"; error: string };

/** Mirrors migrate.ts: missing = 1, otherwise a positive integer. */
function checkVersion(declared: unknown): VersionCheck {
    if (declared === undefined) return { kind: "ok" };
    if (typeof declared !== "number" || !Number.isInteger(declared) || declared < 1) {
        return { kind: "invalid", error: `version: expected a positive integer, got ${JSON.stringify(declared)}` };
    }
    return declared > CURRENT_SETTINGS_VERSION ? { kind: "newer", version: declared } : { kind: "ok" };
}

function newerMessage(version: number): string {
    return `settings.json is version ${version}, written by a newer Tyr (this Tyr understands up to ${CURRENT_SETTINGS_VERSION}); upgrade Tyr`;
}

function secretMessage(key: string): string {
    return `${key} is a secret and cannot be stored in .tyr/settings.json, which is committed; set it in the global config (~/.config/tyr/config.json) or the environment instead`;
}

/** Secret keys present (with any value, even null) in a settings object. */
function secretsIn(value: unknown): string[] {
    return SECRET_KEYS.filter((key) => getAtPath(value, key) !== undefined);
}

/**
 * Load `.tyr/settings.json` as a SettingsPatch. Never throws.
 *
 * Lenient but validated: unknown keys, wrongly typed values and secrets are
 * dropped one by one with a warning, so a single typo never disables the rest
 * of the file. Only a file that cannot be read as a settings object at all
 * (malformed JSON, an array, a garbled `version`) is an error, and then the
 * patch is empty — the other layers still apply.
 */
export async function loadProjectSettings(root: string): Promise<ProjectSettingsLoad> {
    const file = resolveTyrPaths(root).settingsFile;
    const read = await readJsonFile(file);
    if (read.kind === "missing") return { patch: {}, missing: true, warnings: [], errors: [] };
    if (read.kind === "invalid") return { patch: {}, missing: false, warnings: [], errors: [`settings.json: ${read.error}`] };

    const { version, ...body } = read.value;
    const versionCheck = checkVersion(version);
    if (versionCheck.kind === "invalid") {
        return { patch: {}, missing: false, warnings: [], errors: [`settings.json: ${versionCheck.error}`] };
    }
    if (versionCheck.kind === "newer") {
        // A warning, not an error: nothing is wrong with the file, this Tyr is
        // just too old to read it. Tyr runs on the other layers meanwhile.
        return { patch: {}, missing: false, warnings: [`${newerMessage(versionCheck.version)}; its settings are ignored`], errors: [] };
    }

    // Strip secrets before validation so they are reported once, as secrets,
    // and can never reach the patch — a committed `"apiKey": null` would
    // otherwise override a key set in the global config.
    const warnings: string[] = [];
    let raw: Record<string, unknown> = body;
    for (const key of secretsIn(raw)) {
        warnings.push(`settings.json: ${secretMessage(key)}; ignored`);
        raw = unsetAtPath(raw, key);
    }

    const sanitized = sanitizePatch(raw, "settings.json");
    return { patch: sanitized.patch, missing: false, warnings: [...warnings, ...sanitized.warnings], errors: [] };
}

/**
 * The on-disk document for `patch`: `version` first, then keys in
 * SETTING_KEYS order regardless of the order they were set in, so rewriting
 * the file produces minimal, predictable diffs. Unknown keys are dropped.
 */
export function projectSettingsDocument(patch: SettingsPatch): Record<string, unknown> {
    let doc: Record<string, unknown> = { version: CURRENT_SETTINGS_VERSION };
    for (const spec of SETTING_KEYS) {
        const value = getAtPath(patch, spec.key);
        if (value !== undefined) doc = setAtPath(doc, spec.key, value);
    }
    return doc;
}

/**
 * Replace `.tyr/settings.json` with `patch`, atomically.
 *
 * Throws — nothing is written — when the patch holds a secret (this file is
 * committed), holds an unknown key or an invalid value, or when the existing
 * file was written by a newer Tyr. The caller owns read-modify-write: load,
 * change the patch, write it back (under the `.tyr/` lock if it races
 * anything).
 */
export async function writeProjectSettings(root: string, patch: SettingsPatch): Promise<void> {
    const secrets = secretsIn(patch);
    if (secrets.length > 0) throw new Error(secrets.map(secretMessage).join("; "));

    const { warnings } = sanitizePatch(patch, "settings");
    if (warnings.length > 0) throw new Error(`Refusing to write .tyr/settings.json: ${warnings.join("; ")}`);

    const paths = resolveTyrPaths(root);
    const existing = await readJsonFile(paths.settingsFile);
    if (existing.kind === "ok") {
        const check = checkVersion(existing.value.version);
        if (check.kind === "newer") throw new Error(`Refusing to overwrite .tyr/settings.json: ${newerMessage(check.version)}`);
    }

    await fs.mkdir(paths.tyrDir, { recursive: true });
    await writeFileAtomic(paths.settingsFile, toJsonDocument(projectSettingsDocument(patch)));
}

/**
 * The starter settings.json `tyr init` writes: just `{ "version": 1 }`.
 *
 * Deliberately empty. The file is never regenerated, so anything written here
 * is frozen: e.g. `checks.lint: false` for a project with no linter today
 * would silently keep linting off after one is added. A check with no
 * detected command cannot run anyway, so disabling it buys nothing. Leaving
 * every key out keeps the project following DEFAULT_SETTINGS and the user's
 * global config until someone chooses otherwise. The snapshot parameter is
 * kept so starter contents can later depend on detection without changing
 * scaffold().
 */
export function initialProjectSettings(_snapshot: InitSnapshot): SettingsPatch {
    return {};
}

/**
 * Create `file` with `patch` unless something already exists at that path
 * (even a malformed file: it is the user's to fix, not Tyr's to replace).
 * Used by scaffold(), which holds the `.tyr/` lock.
 */
export async function writeInitialProjectSettings(file: string, patch: SettingsPatch): Promise<"created" | "kept"> {
    try {
        await fs.lstat(file);
        return "kept";
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeFileAtomic(file, toJsonDocument(projectSettingsDocument(patch)));
    return "created";
}
