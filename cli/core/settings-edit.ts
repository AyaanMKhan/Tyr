// Changing one setting in one file: the core of `tyr config set` / `unset`.
//
// The layer writers (writeProjectSettings, writeGlobalSettings) replace a
// whole file with a validated patch, and leave read-modify-write to the
// caller. This module is that caller. Its job is to change exactly one key
// and nothing else, and to refuse loudly instead of losing data:
//
// - A malformed or unreadable file is never rewritten (CONFIG): writing a
//   fresh document over it would silently discard whatever the user was in
//   the middle of typing.
// - Neither is a file written by a newer Tyr, or one with a garbled version.
// - Nor is a file with problems the rewrite would quietly "fix" by dropping
//   them: invalid values for *other* keys, and in the project file unknown
//   keys (writeProjectSettings keeps only known keys; the global writer
//   carries unknown keys over, so they are fine there) and secrets. Each of
//   those is the user's to resolve by hand; the error lists them all.
//   The key being changed is exempt: replacing its bad value is the point.
// - Project writes happen under the `.tyr/` lock, so two `tyr config set`
//   runs (or one racing `tyr init --force`) cannot lose each other's change.
//
// Expected failures are thrown as TyrError with the exit code a script
// would want to branch on (USAGE, NOT_INITIALIZED, CONFIG); the command
// layer prints them. Nothing here prints.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TyrError, EXIT_CODES } from "./errors.js";
import { ENV_VARS } from "./env-settings.js";
import { GLOBAL_CONFIG_VERSION, globalConfigFile, writeGlobalSettings, type GlobalConfigPathOptions } from "./global-config.js";
import { LockTimeoutError, withTyrLock } from "./lock.js";
import { CURRENT_SETTINGS_VERSION, writeProjectSettings } from "./project-settings.js";
import { readJsonFile, resolveTyrPaths } from "./scaffold.js";
import { findProjectRoot } from "./discovery.js";
import {
    SETTING_KEYS,
    checkSettingValue,
    findSettingKey,
    getAtPath,
    leafKeys,
    parseSettingValue,
    sanitizePatch,
    setAtPath,
    unsetAtPath,
    type SettingKeySpec,
    type SettingsPatch,
} from "./settings-types.js";
import { layerOutranks, resolveSettings, suggestSettingKey, type SettingOrigin } from "./settings.js";

/** Which file a change goes to. */
export type SettingsScope = "project" | "global";

/* -------------------------------------------------------------------------
 * Locating the project
 * ---------------------------------------------------------------------- */

export interface ProjectLocation {
    /** The project root findProjectRoot() chose for `cwd`. */
    root: string;
    /** True when `.tyr/tyr.json` exists there (malformed or not: settings do not depend on it). */
    initialized: boolean;
}

/** Find the project root from `cwd` and whether `tyr init` has run there. Never throws. */
export async function locateProject(cwd: string = process.cwd()): Promise<ProjectLocation> {
    const root = await findProjectRoot(cwd);
    const stat = await fs.stat(resolveTyrPaths(root).configFile).catch(() => null);
    return { root, initialized: stat?.isFile() === true };
}

/* -------------------------------------------------------------------------
 * Keys and values
 * ---------------------------------------------------------------------- */

/** The spec for `key`, or a USAGE TyrError with a "did you mean" and every valid key. */
export function requireSettingKey(key: string): SettingKeySpec {
    const spec = findSettingKey(key);
    if (spec) return spec;
    const suggestion = suggestSettingKey(key);
    throw new TyrError(
        `Unknown setting "${key}".` + (suggestion === null ? "" : ` Did you mean "${suggestion}"?`),
        {
            exitCode: EXIT_CODES.USAGE,
            hint: `Valid keys: ${SETTING_KEYS.map((s) => s.key).join(", ")}. Run "tyr config list" to see them with their values.`,
        },
    );
}

/** What `key` accepts, in words, from the ENV_VARS table (shared with the env docs). */
export function acceptedValues(spec: SettingKeySpec): string {
    return ENV_VARS.find((v) => v.kind === "setting" && v.overrides === spec.key)?.accepts ?? spec.type;
}

/** parseSettingValue, as a USAGE TyrError on failure. Never echoes a secret. */
export function parseOrThrow(spec: SettingKeySpec, raw: string): unknown {
    const parsed = parseSettingValue(spec, raw);
    if (parsed.ok) return parsed.value;
    throw new TyrError(spec.secret ? `Invalid value for ${spec.key}` : parsed.error, {
        exitCode: EXIT_CODES.USAGE,
        hint: `${spec.key} accepts: ${acceptedValues(spec)}`,
    });
}

/* -------------------------------------------------------------------------
 * Editing
 * ---------------------------------------------------------------------- */

export interface EditSettingOptions {
    scope: SettingsScope;
    /**
     * Initialized project root, or null. Required (non-null) for the project
     * scope; for the global scope it is used only to tell whether the
     * project's own settings override the new global value.
     */
    root: string | null;
    env?: NodeJS.ProcessEnv;
    /** Locating the global file (tests). Its `env` defaults to `env`. */
    global?: GlobalConfigPathOptions;
}

/** The outcome of one set/unset, and exactly what `--json` reports (after masking). */
export interface SettingEdit {
    action: "set" | "unset";
    key: string;
    scope: SettingsScope;
    file: string;
    /** The key's value in that file before the edit; undefined when absent. */
    previous: unknown;
    /** The key's value in that file after the edit; undefined when absent. */
    value: unknown;
    /** False when the file already said this, so nothing was written. */
    changed: boolean;
    /** Effective value and origin after the edit, all layers considered. */
    effective: { value: unknown; origin: SettingOrigin };
    /** A higher layer that still overrides the edited file for this key, or null. */
    shadowedBy: SettingOrigin | null;
    /** Non-fatal notes about the edit, e.g. carried-over unknown keys. */
    notes: string[];
}

/** `tyr config set`: parse `raw` for `key` and store it in the scope's file. */
export async function setSetting(key: string, raw: string, options: EditSettingOptions): Promise<SettingEdit> {
    const spec = requireSettingKey(key);
    if (spec.secret && options.scope === "project") {
        throw new TyrError(
            `${spec.key} is a secret and cannot be stored in .tyr/settings.json, which is committed with the repository.`,
            {
                exitCode: EXIT_CODES.USAGE,
                hint: `Store it in your global config with "tyr config set --global ${spec.key} -" (reads the value from stdin), or export ${spec.env}.`,
            },
        );
    }
    const value = parseOrThrow(spec, raw);
    return editSetting(spec, "set", (patch) => setAtPath(patch, spec.key, value), options);
}

/** `tyr config unset`: remove `key` from the scope's file, so lower layers apply again. */
export async function unsetSetting(key: string, options: EditSettingOptions): Promise<SettingEdit> {
    // Unsetting a secret in the project file is allowed: it is how a key
    // that was committed by mistake gets removed.
    const spec = requireSettingKey(key);
    return editSetting(spec, "unset", (patch) => unsetAtPath(patch, spec.key), options);
}

/** The file `tyr config set` writes for `scope`; null for the project scope without a root. */
export function settingsFileFor(
    scope: SettingsScope,
    root: string | null,
    options: { env?: NodeJS.ProcessEnv; global?: GlobalConfigPathOptions } = {},
): string | null {
    if (scope === "project") return root === null ? null : resolveTyrPaths(root).settingsFile;
    const global = { env: options.env ?? process.env, ...options.global };
    return path.resolve(global.file ?? globalConfigFile(global.env, global.platform, global.home));
}

async function editSetting(
    spec: SettingKeySpec,
    action: "set" | "unset",
    mutate: (patch: SettingsPatch) => SettingsPatch,
    options: EditSettingOptions,
): Promise<SettingEdit> {
    const env = options.env ?? process.env;
    const globalOptions: GlobalConfigPathOptions = { env, ...options.global };
    let partial: Omit<SettingEdit, "effective" | "shadowedBy">;

    if (options.scope === "project") {
        const root = options.root;
        if (root === null) {
            throw new TyrError("Tyr is not initialized in this project, so there is no .tyr/settings.json to change.", {
                exitCode: EXIT_CODES.NOT_INITIALIZED,
                hint: `Run "tyr init" first, or pass --global to change your per-user config instead.`,
            });
        }
        const file = resolveTyrPaths(root).settingsFile;
        partial = await underLock(root, `tyr config ${action}`, () =>
            rewrite(spec, action, file, "project", mutate, (patch) => writeProjectSettings(root, patch).then(() => [])),
        );
    } else {
        const file = settingsFileFor("global", null, { env, global: options.global })!;
        partial = await rewrite(spec, action, file, "global", mutate, async (patch) => {
            const written = await writeGlobalSettings(patch, { ...globalOptions, file });
            return written.preservedKeys.length === 0
                ? []
                : [`Kept keys this Tyr does not know: ${written.preservedKeys.join(", ")}`];
        });
    }

    // Re-resolve after the write, so "effective" is what Tyr will now use.
    const resolved = await resolveSettings({ root: options.root, env, global: options.global });
    const origin = resolved.origins[spec.key];
    return {
        ...partial,
        effective: { value: getAtPath(resolved.settings, spec.key), origin },
        shadowedBy: layerOutranks(origin.layer, options.scope) ? origin : null,
    };
}

/** Read-modify-write one file. `write` gets the full new patch and returns notes. */
async function rewrite(
    spec: SettingKeySpec,
    action: "set" | "unset",
    file: string,
    scope: SettingsScope,
    mutate: (patch: SettingsPatch) => SettingsPatch,
    write: (patch: SettingsPatch) => Promise<string[]>,
): Promise<Omit<SettingEdit, "effective" | "shadowedBy">> {
    const read = await readJsonFile(file);
    if (read.kind === "invalid") {
        throw configError(file, scope, [read.error]);
    }
    let body: Record<string, unknown> = {};
    if (read.kind === "ok") {
        const { version, ...rest } = read.value;
        const versionProblem = checkVersion(version, scope === "project" ? CURRENT_SETTINGS_VERSION : GLOBAL_CONFIG_VERSION);
        if (versionProblem !== null) throw configError(file, scope, [versionProblem]);
        body = rest;
    }

    const problems = rewriteProblems(body, spec, scope);
    if (problems.length > 0) throw configError(file, scope, problems);

    // Everything else in the file is valid (checked just above), so this
    // drops nothing but the key being changed.
    const base = sanitizePatch(unsetAtPath(body, spec.key), file).patch;
    const previous = getAtPath(body, spec.key);
    const next = mutate(base);
    const value = getAtPath(next, spec.key);
    const result = { action, key: spec.key, scope, file, previous, value, notes: [] as string[] };

    // Nothing to do: leave the file (and its mtime, and git) untouched.
    // A file whose value for this key was invalid still gets rewritten.
    const previousValid = previous !== undefined && checkSettingValue(spec, previous) === null;
    if (JSON.stringify(previous) === JSON.stringify(value) && (previous === undefined || previousValid)) {
        return { ...result, changed: false };
    }
    try {
        result.notes = await write(next);
    } catch (error) {
        if (error instanceof TyrError) throw error;
        throw new TyrError(`Could not write ${file}: ${(error as Error).message}`, {
            exitCode: EXIT_CODES.CONFIG,
            hint: "Fix or remove the file by hand, then retry.",
            cause: error,
        });
    }
    return { ...result, changed: true };
}

/**
 * Problems in an existing file that a rewrite would silently erase. The
 * key being edited is skipped: its old value is about to be replaced.
 */
function rewriteProblems(body: Record<string, unknown>, edited: SettingKeySpec, scope: SettingsScope): string[] {
    const problems: string[] = [];
    for (const spec of SETTING_KEYS) {
        if (spec.key === edited.key) continue;
        const value = getAtPath(body, spec.key);
        if (value === undefined) continue;
        if (scope === "project" && spec.secret) {
            problems.push(`it contains the secret ${spec.key}, which belongs in the global config or the environment`);
            continue;
        }
        const problem = checkSettingValue(spec, value);
        if (problem !== null) problems.push(problem);
    }
    if (scope === "project") {
        const known = (key: string) => SETTING_KEYS.some((spec) => key === spec.key || key.startsWith(`${spec.key}.`));
        for (const key of leafKeys(body)) {
            if (!known(key)) problems.push(`unknown setting "${key}"`);
        }
    }
    return problems;
}

/**
 * Same rules as the loaders: missing = 1; otherwise a positive integer no
 * newer than `supported`. A newer file may use keys or meanings this Tyr
 * would drop on rewrite, so it is never rewritten.
 */
function checkVersion(version: unknown, supported: number): string | null {
    if (version === undefined) return null;
    if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
        return `"version" must be a positive integer, got ${JSON.stringify(version)}`;
    }
    if (version > supported) {
        return `it was written by a newer Tyr (version ${version}; this Tyr understands up to ${supported}); upgrade Tyr to change it`;
    }
    return null;
}

function configError(file: string, scope: SettingsScope, problems: string[]): TyrError {
    const pathCommand = scope === "global" ? "tyr config path --global" : "tyr config path";
    return new TyrError(`Refusing to rewrite ${file}: ${problems.join("; ")}.`, {
        exitCode: EXIT_CODES.CONFIG,
        hint: `Nothing was changed. Fix the file by hand ("${pathCommand}" prints its location), then retry.`,
    });
}

/** withTyrLock, with a lock timeout reported as a TyrError rather than a crash. */
async function underLock<T>(root: string, owner: string, fn: () => Promise<T>): Promise<T> {
    try {
        return await withTyrLock(root, owner, fn);
    } catch (error) {
        if (error instanceof LockTimeoutError) {
            throw new TyrError(error.message, { exitCode: EXIT_CODES.FAILURE, cause: error });
        }
        throw error;
    }
}
