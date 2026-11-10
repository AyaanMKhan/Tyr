// Global, per-user settings (PLANNING.md 2.7): ~/.config/tyr/config.json.
//
// This is the "global" layer of the settings stack described in
// settings-types.ts (default < global < project < env). It holds what belongs
// to a *person* rather than a repository: the API key, and personal defaults
// such as the model or notification targets that should follow the user into
// every project. Unlike `.tyr/settings.json`, which is meant to be committed,
// this file MAY hold secrets — that is its purpose — so it is written with
// mode 0600 inside a 0700 directory, and a loose mode on a file that holds a
// secret produces a warning on every load.
//
// On-disk format (shared with the project file):
//
//   { "version": 1, "ai": { "apiKey": "…" }, "checks": { "lint": false } }
//
// `version` is stripped before sanitizePatch(); a missing version counts as 1.
// A file from a newer Tyr is still read best-effort (with a warning, since
// skipping the user's API key would be worse than misreading a renamed key),
// but is never rewritten: a newer Tyr may have changed meanings this version
// would silently drop.
//
// Like the rest of cli/core this module is silent: it returns data, warnings
// and errors, never prints. Path resolution is pure and takes env, platform
// and home directory as arguments so tests never touch the real home dir.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readJsonFile, toJsonDocument } from "./scaffold.js";
import {
    SETTING_KEYS,
    findSettingKey,
    getAtPath,
    sanitizePatch,
    setAtPath,
    type SettingsPatch,
} from "./settings-types.js";

/** Format version Tyr writes. Bump with a migration when the shape changes. */
export const GLOBAL_CONFIG_VERSION = 1;

/** File name inside the global config directory. */
export const GLOBAL_CONFIG_FILE_NAME = "config.json";

/** Owner-only: the file may hold an API key. */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

type Env = Record<string, string | undefined>;

/** Inputs for locating the global config; defaults are the real process. */
export interface GlobalConfigPathOptions {
    env?: Env;
    platform?: NodeJS.Platform;
    home?: string;
    /** Explicit file path; bypasses directory resolution entirely. */
    file?: string;
}

/** Path flavour of the *target* platform, so win32 rules test fine on macOS. */
function pathFor(platform: NodeJS.Platform): typeof path.posix {
    return platform === "win32" ? path.win32 : path.posix;
}

/** Treat empty strings like unset: `FOO= tyr …` should not mean "the cwd". */
function nonEmpty(value: string | undefined): string | undefined {
    return value === undefined || value.trim() === "" ? undefined : value;
}

/**
 * Directory that holds the global config, first match wins:
 *
 * 1. `TYR_CONFIG_HOME` — an explicit override (tests, portable installs).
 * 2. `$XDG_CONFIG_HOME/tyr` — only when absolute; the XDG spec says relative
 *    values are invalid and must be ignored.
 * 3. win32: `%APPDATA%\tyr` (falling back to `<home>\AppData\Roaming\tyr`).
 * 4. `<home>/.config/tyr` — on macOS too, as the planning doc specifies;
 *    CLI tools there commonly use ~/.config rather than ~/Library.
 *
 * Pure: depends only on its arguments.
 */
export function globalConfigDir(
    env: Env = process.env,
    platform: NodeJS.Platform = process.platform,
    home: string = os.homedir(),
): string {
    const p = pathFor(platform);
    const override = nonEmpty(env.TYR_CONFIG_HOME);
    if (override !== undefined) return p.normalize(override);

    const xdg = nonEmpty(env.XDG_CONFIG_HOME);
    if (xdg !== undefined && p.isAbsolute(xdg)) return p.join(xdg, "tyr");

    if (platform === "win32") {
        const appData = nonEmpty(env.APPDATA);
        return appData !== undefined && p.isAbsolute(appData)
            ? p.join(appData, "tyr")
            : p.join(home, "AppData", "Roaming", "tyr");
    }
    return p.join(home, ".config", "tyr");
}

/** `<globalConfigDir>/config.json`. Pure. */
export function globalConfigFile(
    env: Env = process.env,
    platform: NodeJS.Platform = process.platform,
    home: string = os.homedir(),
): string {
    return pathFor(platform).join(globalConfigDir(env, platform, home), GLOBAL_CONFIG_FILE_NAME);
}

function resolveFile(options: GlobalConfigPathOptions): string {
    return options.file ?? globalConfigFile(options.env, options.platform, options.home);
}

/** Result of reading the global config. `errors` means the file was unusable. */
export interface GlobalSettingsLoad {
    file: string;
    /** Valid settings from the file; `{}` when missing or unusable. */
    patch: SettingsPatch;
    /** True when there is no file (not an error: most users start without one). */
    missing: boolean;
    /** File format version as read (1 when absent); null when missing or unusable. */
    version: number | null;
    warnings: string[];
    errors: string[];
}

type VersionCheck = { kind: "ok"; version: number } | { kind: "newer"; version: number } | { kind: "invalid" };

function checkVersion(raw: Record<string, unknown>): VersionCheck {
    const version = raw.version;
    if (version === undefined) return { kind: "ok", version: 1 };
    if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return { kind: "invalid" };
    return version > GLOBAL_CONFIG_VERSION ? { kind: "newer", version } : { kind: "ok", version };
}

/** True when `raw` holds a non-empty value for any secret key (ai.apiKey). */
function holdsSecret(raw: unknown): boolean {
    return SETTING_KEYS.some((spec) => {
        if (!spec.secret) return false;
        const value = getAtPath(raw, spec.key);
        return typeof value === "string" && value.trim() !== "";
    });
}

/**
 * Read and validate the global config. Never throws.
 *
 * - Missing file: `missing: true`, empty patch, no warnings.
 * - Unreadable / malformed JSON / not an object: one error, empty patch.
 * - Unknown keys and bad values: warnings; the rest of the file still applies.
 * - Newer version: warning, read best-effort.
 * - POSIX: a secret in a group/world-readable file warns with a chmod hint.
 */
export async function loadGlobalSettings(options: GlobalConfigPathOptions = {}): Promise<GlobalSettingsLoad> {
    const file = resolveFile(options);
    const platform = options.platform ?? process.platform;
    const result: GlobalSettingsLoad = { file, patch: {}, missing: false, version: null, warnings: [], errors: [] };

    const read = await readJsonFile(file);
    if (read.kind === "missing") return { ...result, missing: true };
    if (read.kind === "invalid") return { ...result, errors: [`${file}: ${read.error}`] };

    const { version: _version, ...settings } = read.value;
    const version = checkVersion(read.value);
    if (version.kind === "invalid") {
        result.warnings.push(`${file}: "version" must be a positive integer; treating the file as version 1`);
        result.version = 1;
    } else {
        result.version = version.version;
        if (version.kind === "newer") {
            result.warnings.push(
                `${file}: written by a newer Tyr (version ${version.version}, this Tyr understands ${GLOBAL_CONFIG_VERSION}); ` +
                    "reading it best-effort, and it will not be rewritten",
            );
        }
    }

    const sanitized = sanitizePatch(settings, file);
    result.patch = sanitized.patch;
    result.warnings.push(...sanitized.warnings);

    // Windows has no POSIX mode bits (stat reports 0o666 for every file), so
    // the check would always fire there and mean nothing.
    if (platform !== "win32" && holdsSecret(settings)) {
        try {
            const stat = await fs.stat(file);
            if ((stat.mode & 0o077) !== 0) {
                const mode = (stat.mode & 0o777).toString(8).padStart(3, "0");
                result.warnings.push(
                    `${file} holds an API key but is readable by other users (mode ${mode}); run: chmod 600 "${file}"`,
                );
            }
        } catch {
            // The file was readable a moment ago; a stat race is not worth an error.
        }
    }
    return result;
}

/** Result of writing the global config. */
export interface GlobalSettingsWrite {
    file: string;
    /** The exact document written, including `version`. */
    document: Record<string, unknown>;
    /** Dotted keys unknown to this Tyr that were carried over from the old file. */
    preservedKeys: string[];
}

/** Unknown leaf keys of a raw settings object, with their values. */
function unknownLeaves(obj: unknown, prefix = ""): Array<[string, unknown]> {
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
        return prefix && !findSettingKey(prefix) ? [[prefix, obj]] : [];
    }
    // A known key whose stored value is (wrongly) an object is not "unknown";
    // it is a bad value, and the caller's patch decides what replaces it.
    if (prefix && findSettingKey(prefix)) return [];
    return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
        unknownLeaves(v, prefix ? `${prefix}.${k}` : k),
    );
}

/**
 * Build the on-disk document in a stable order: `version` first, then known
 * keys in SETTING_KEYS order (so diffs and `cat` stay readable whatever order
 * keys were set in), then carried-over unknown keys sorted by path.
 */
function toDocument(patch: SettingsPatch, preserved: Array<[string, unknown]>): Record<string, unknown> {
    let doc: Record<string, unknown> = { version: GLOBAL_CONFIG_VERSION };
    for (const spec of SETTING_KEYS) {
        const value = getAtPath(patch, spec.key);
        if (value !== undefined) doc = setAtPath(doc, spec.key, value);
    }
    for (const [key, value] of [...preserved].sort(([a], [b]) => a.localeCompare(b))) {
        // Never let a carried-over key clobber a known one (e.g. an old
        // `"ai": "x"` scalar where the patch now sets ai.model).
        if (getAtPath(doc, key) === undefined) doc = setAtPath(doc, key, value);
    }
    return doc;
}

/**
 * Atomically write `contents` with an owner-only mode. scaffold.ts's
 * writeFileAtomic cannot set a mode, and the temp file must be 0600 from
 * creation: chmod-after-write would leave a window in which the key is
 * world-readable. `wx` refuses to follow a pre-planted temp-file symlink.
 */
async function writeSecretFileAtomic(target: string, contents: string): Promise<void> {
    const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
    try {
        await fs.writeFile(tmp, contents, { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
        // The umask can only clear bits, but be explicit in case the
        // filesystem applied something else (e.g. default ACL inheritance).
        await fs.chmod(tmp, FILE_MODE);
        await fs.rename(tmp, target);
    } catch (error) {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        throw error;
    }
}

/**
 * Replace the global config with `patch` (the full desired contents, not a
 * delta: callers load, edit with setAtPath/unsetAtPath, then write).
 *
 * - Throws on an invalid patch (unknown key or bad value): that is a caller
 *   bug, and writing it would only produce warnings on every later load.
 * - Throws when the existing file is from a newer Tyr or is malformed JSON,
 *   rather than overwriting settings this version cannot fully understand.
 * - Keys this Tyr does not know are carried over from the existing file, so
 *   a hand-added setting (or one from a sibling Tyr build) survives `set`.
 * - Creates the directory with 0700 and the file with 0600. An existing
 *   directory's mode is left alone; it may be a shared TYR_CONFIG_HOME.
 */
export async function writeGlobalSettings(
    patch: SettingsPatch,
    options: GlobalConfigPathOptions = {},
): Promise<GlobalSettingsWrite> {
    const file = resolveFile(options);

    const checked = sanitizePatch(patch, "settings");
    if (checked.warnings.length > 0) {
        throw new Error(`Refusing to write ${file}: ${checked.warnings.join("; ")}`);
    }

    let preserved: Array<[string, unknown]> = [];
    const existing = await readJsonFile(file);
    if (existing.kind === "invalid") {
        throw new Error(`Refusing to overwrite ${file}: ${existing.error}. Fix or remove it first.`);
    }
    if (existing.kind === "ok") {
        const version = checkVersion(existing.value);
        if (version.kind === "newer") {
            throw new Error(
                `Refusing to overwrite ${file}: it was written by a newer Tyr (version ${version.version}, ` +
                    `this Tyr writes ${GLOBAL_CONFIG_VERSION}). Upgrade Tyr to change it.`,
            );
        }
        if (version.kind === "invalid") {
            throw new Error(`Refusing to overwrite ${file}: "version" is not a positive integer. Fix or remove it first.`);
        }
        const { version: _version, ...settings } = existing.value;
        preserved = unknownLeaves(settings);
    }

    const document = toDocument(checked.patch, preserved);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: DIR_MODE });
    await writeSecretFileAtomic(file, toJsonDocument(document));
    return { file, document, preservedKeys: preserved.map(([key]) => key) };
}
