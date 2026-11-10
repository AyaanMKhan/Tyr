// The settings resolver (PLANNING.md 2.7): one call that answers "what is
// each setting, and where did it come from?".
//
//   default  <  global (~/.config/tyr/config.json)  <  project (.tyr/settings.json)  <  env (TYR_*)
//
// Each layer already has its own loader (global-config.ts,
// project-settings.ts, env-settings.ts), and each returns a validated
// SettingsPatch. This module only stacks them. Every SETTING_KEYS entry is a
// leaf, so the deep merge is done key by key: for each key the highest layer
// that sets it wins outright. That gives two properties for free:
//
// - Arrays replace, never concatenate. A project that sets
//   `notifications.targets: []` really means "nowhere", whatever the user's
//   global file lists; merging lists would make that impossible to express.
// - Every key has exactly one origin (layer + source), which is what
//   `tyr config list` / `tyr config get --show-origin` show, and what "why
//   is this value what it is?" debugging needs.
//
// Like the loaders, resolving never throws for a bad file: a malformed or
// unreadable file becomes an entry in `errors` and that layer contributes
// nothing, so Tyr still runs on the remaining layers.
//
// Secrets (`ai.apiKey`) are resolved like any other key, at full value,
// because Tyr has to use them. Anything *displaying* a value must go through
// displaySettingValue()/maskSecret() instead of printing it raw.

import * as path from "node:path";
import { loadGlobalSettings, type GlobalConfigPathOptions } from "./global-config.js";
import { loadProjectSettings } from "./project-settings.js";
import { readEnvSettings } from "./env-settings.js";
import { resolveTyrPaths } from "./scaffold.js";
import {
    DEFAULT_SETTINGS,
    EMPTY_LIST_TOKEN,
    SETTING_KEYS,
    getAtPath,
    setAtPath,
    type SettingKeySpec,
    type SettingsLayer,
    type SettingsPatch,
    type TyrSettings,
} from "./settings-types.js";

/** Layers from lowest to highest precedence. */
export const SETTINGS_LAYERS: readonly SettingsLayer[] = ["default", "global", "project", "env"];

/** Where a key's effective value came from. */
export interface SettingOrigin {
    layer: SettingsLayer;
    /** A file path (global, project), an env var name (env), or "default". */
    source: string;
}

export interface ResolveSettingsOptions {
    /**
     * Project root (the directory containing `.tyr/`). Omit or pass null when
     * the project is not initialized: the project layer is then simply absent.
     */
    root?: string | null;
    /** Environment for the env layer, and for locating the global file. Defaults to process.env. */
    env?: NodeJS.ProcessEnv;
    /** Overrides for locating the global config (tests); `env` is used when it has none. */
    global?: GlobalConfigPathOptions;
}

export interface ResolvedSettings {
    /** The effective settings. Secrets are NOT masked here. */
    settings: TyrSettings;
    /** One entry per SETTING_KEYS key. */
    origins: Record<string, SettingOrigin>;
    /** The files consulted, whether or not they exist. `project` is null without a root. */
    files: { global: string; project: string | null };
    /** Ignored parts of usable layers: unknown keys, bad values, bad env vars, loose file modes. */
    warnings: string[];
    /** Layers ignored entirely: unreadable or malformed files. */
    errors: string[];
}

/**
 * Resolve every setting from all layers. Never throws for a bad file or a
 * bad variable; see `warnings` and `errors`.
 */
export async function resolveSettings(options: ResolveSettingsOptions = {}): Promise<ResolvedSettings> {
    const env = options.env ?? process.env;
    const globalOptions: GlobalConfigPathOptions = { env, ...options.global };
    const root = options.root ?? null;

    const globalLoad = await loadGlobalSettings(globalOptions);
    // A relative TYR_CONFIG_HOME would otherwise make origins cwd-dependent.
    const globalFile = path.resolve(globalLoad.file);
    const projectFile = root === null ? null : resolveTyrPaths(root).settingsFile;
    const projectLoad = root === null ? null : await loadProjectSettings(root);
    const envLoad = readEnvSettings(env);

    // Highest precedence last; `sourceOf` names where each layer's value lives.
    const layers: Array<{ layer: SettingsLayer; patch: SettingsPatch; sourceOf: (key: string) => string }> = [
        { layer: "default", patch: DEFAULT_SETTINGS, sourceOf: () => "default" },
        { layer: "global", patch: globalLoad.patch, sourceOf: () => globalFile },
    ];
    if (projectLoad !== null && projectFile !== null) {
        layers.push({ layer: "project", patch: projectLoad.patch, sourceOf: () => projectFile });
    }
    layers.push({ layer: "env", patch: envLoad.patch, sourceOf: (key) => envLoad.sources[key] ?? "env" });

    let settings = structuredClone(DEFAULT_SETTINGS);
    const origins: Record<string, SettingOrigin> = {};
    for (const spec of SETTING_KEYS) {
        for (let i = layers.length - 1; i >= 0; i--) {
            const value = getAtPath(layers[i].patch, spec.key);
            if (value === undefined) continue;
            // Cloned so a caller mutating `settings` can never reach back
            // into DEFAULT_SETTINGS or a loader's patch.
            settings = setAtPath(settings, spec.key, structuredClone(value));
            origins[spec.key] = { layer: layers[i].layer, source: layers[i].sourceOf(spec.key) };
            break;
        }
    }

    return {
        settings,
        origins,
        files: { global: globalFile, project: projectFile },
        warnings: [...globalLoad.warnings, ...(projectLoad?.warnings ?? []), ...envLoad.warnings],
        errors: [...globalLoad.errors, ...(projectLoad?.errors ?? [])],
    };
}

/** Whether `a` takes precedence over `b`. */
export function layerOutranks(a: SettingsLayer, b: SettingsLayer): boolean {
    return SETTINGS_LAYERS.indexOf(a) > SETTINGS_LAYERS.indexOf(b);
}

/* -------------------------------------------------------------------------
 * Display
 * ---------------------------------------------------------------------- */

/** Below this length a secret is hidden completely: four characters would be too much of it. */
const MIN_PARTIAL_MASK_LENGTH = 12;

/**
 * Mask a secret for display: `sk-ant-api03-…wxyz` -> `sk-…wxyz`. Keeps a
 * short alphabetic prefix ending in "-" (it says *which kind* of key, not
 * which key) and the last four characters, enough to tell two keys apart.
 * Short values are fully hidden as `****`. null stays null ("not set").
 */
export function maskSecret(value: string | null): string | null {
    if (value === null) return null;
    if (value.length < MIN_PARTIAL_MASK_LENGTH) return "****";
    const prefix = /^[A-Za-z]{1,4}-/.exec(value)?.[0] ?? "";
    return `${prefix}…${value.slice(-4)}`;
}

/** The value to show for `spec`: masked when secret unless `reveal`. */
export function displaySettingValue(spec: SettingKeySpec, value: unknown, options: { reveal?: boolean } = {}): unknown {
    if (spec.secret && !options.reveal && (typeof value === "string" || value === null)) return maskSecret(value);
    return value;
}

/**
 * A value as plain text, in the same spelling `tyr config set` accepts, so
 * `tyr config set k "$(tyr config get k)"` round-trips:
 * booleans `true`/`false`, strings bare, lists comma-joined, and both an
 * empty list and null as "" (an empty line). Lists with an entry containing a
 * comma cannot round-trip this way; `--json` is exact.
 */
export function formatSettingValue(value: unknown): string {
    if (value === null || value === undefined) return "";
    if (Array.isArray(value)) return value.map(String).join(",");
    return String(value);
}

/** Like formatSettingValue, but says "(none)" / "(not set)" instead of printing nothing, for tables. */
export function describeSettingValue(value: unknown): string {
    if (value === null || value === undefined) return "(not set)";
    if (Array.isArray(value) && value.length === 0) return `(${EMPTY_LIST_TOKEN})`;
    return formatSettingValue(value);
}

/* -------------------------------------------------------------------------
 * Key lookup with suggestions
 * ---------------------------------------------------------------------- */

/**
 * The closest known key to a mistyped one, or null. Tries, in order: a
 * case-insensitive match, the env variable name (`TYR_SEVERITY` ->
 * `severity.threshold`), a bare last segment (`lint` -> `checks.lint`), then
 * the nearest key by edit distance if it is close enough to be a typo.
 */
export function suggestSettingKey(input: string): string | null {
    const wanted = input.trim();
    if (wanted === "") return null;
    const lower = wanted.toLowerCase();

    const exact = SETTING_KEYS.find((spec) => spec.key.toLowerCase() === lower);
    if (exact) return exact.key;
    const byEnv = SETTING_KEYS.find((spec) => spec.env.toLowerCase() === lower);
    if (byEnv) return byEnv.key;
    const byLeaf = SETTING_KEYS.filter((spec) => spec.key.split(".").pop()!.toLowerCase() === lower);
    if (byLeaf.length === 1) return byLeaf[0].key;

    let best: { key: string; distance: number } | null = null;
    for (const spec of SETTING_KEYS) {
        const distance = editDistance(lower, spec.key.toLowerCase());
        if (best === null || distance < best.distance) best = { key: spec.key, distance };
    }
    const tolerance = Math.max(2, Math.floor(wanted.length / 3));
    return best !== null && best.distance <= tolerance ? best.key : null;
}

/** Levenshtein distance; keys are short, so the plain O(n·m) table is fine. */
function editDistance(a: string, b: string): number {
    let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const current = [i];
        for (let j = 1; j <= b.length; j++) {
            const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
            current.push(Math.min(previous[j] + 1, current[j - 1] + 1, substitution));
        }
        previous = current;
    }
    return previous[b.length];
}
