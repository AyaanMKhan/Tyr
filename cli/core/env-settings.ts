// Environment-variable overrides (PLANNING.md 2.7): the top settings layer,
// plus env equivalents of the global CLI options.
//
//   default  <  global config  <  project settings  <  env (this module)
//
// Like settings-types.ts this module is pure: it reads only the `env` object
// it is handed (process.env by default) and never throws. A bad value becomes
// a warning naming the variable and is otherwise ignored, because a typo in a
// shell profile or CI file must never stop every `tyr` command from starting.
//
// Empty values. One rule for every variable: an empty or whitespace-only
// value means "unset". Two reasons:
//   - CI systems and templated .env files routinely export a variable as ""
//     when the secret or input behind it is missing. Treating that as a real
//     value would, e.g., wipe a working API key from the global config, or
//     silently switch notifications off.
//   - It keeps `TYR_API_KEY=""` falling through to ANTHROPIC_API_KEY, which is
//     what someone who exported an empty TYR_API_KEY by accident expects.
// The one place where "empty" is a meaningful value is notifications.targets,
// where [] means "notify nowhere". Instead of making "" special for that one
// variable, it has an explicit spelling: TYR_NOTIFY=none. Explicit beats
// ambiguous, and every variable keeps the same empty-means-unset rule. The
// spelling is EMPTY_LIST_TOKEN, understood by parseSettingValue itself, so
// `tyr config set notifications.targets none` means the same thing.

import { LOG_LEVEL_ENV, LOG_THRESHOLDS, parseLogLevel, type LogThreshold } from "./log.js";
import {
    EMPTY_LIST_TOKEN,
    parseSettingValue,
    setAtPath,
    SETTING_KEYS,
    type SettingKeySpec,
    type SettingsPatch,
} from "./settings-types.js";

/** Conventional Anthropic SDK variable, read for ai.apiKey when TYR_API_KEY is unset. */
export const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";

/** TYR_NOTIFY value meaning "no notification targets" (see the header comment). */
export const NOTIFY_NONE = EMPTY_LIST_TOKEN;

/** Env equivalents of global CLI flags. An explicit flag always wins over these. */
export const QUIET_ENV = "TYR_QUIET";
export const VERBOSE_ENV = "TYR_VERBOSE";
export const JSON_ENV = "TYR_JSON";

/* -------------------------------------------------------------------------
 * The table of every variable Tyr reads
 * ---------------------------------------------------------------------- */

export interface EnvVarSpec {
    /** Variable name, e.g. "TYR_CHECKS_TEST". */
    name: string;
    /** "setting": overrides a settings key. "cli": stands in for a global flag. */
    kind: "setting" | "cli";
    /** The settings key ("checks.test") or the flag ("--quiet") it overrides. */
    overrides: string;
    /** Human-readable accepted values, for docs and `tyr config`. */
    accepts: string;
    /** Secret values are never echoed in warnings or listings. */
    secret?: boolean;
    description: string;
}

const BOOLEAN_ACCEPTS = "true|false, 1|0, yes|no, on|off";

function acceptsFor(spec: SettingKeySpec): string {
    switch (spec.type) {
        case "boolean":
            return BOOLEAN_ACCEPTS;
        case "enum":
            return (spec.values ?? []).join("|");
        case "string-list":
            return `comma-separated list, or "${NOTIFY_NONE}" for an empty list`;
        case "string":
        case "nullable-string":
            return "any non-empty string";
    }
}

/**
 * Every environment variable Tyr reads, in display order: one per settings
 * key (generated from SETTING_KEYS so the two cannot drift), the
 * ANTHROPIC_API_KEY fallback, then the global-option variables. README's
 * "Environment variables" table mirrors this list.
 */
export const ENV_VARS: readonly EnvVarSpec[] = [
    ...SETTING_KEYS.flatMap((spec): EnvVarSpec[] => {
        const own: EnvVarSpec = {
            name: spec.env,
            kind: "setting",
            overrides: spec.key,
            accepts: acceptsFor(spec),
            ...(spec.secret ? { secret: true } : {}),
            description: spec.description,
        };
        if (spec.key !== "ai.apiKey") return [own];
        return [
            own,
            {
                name: ANTHROPIC_API_KEY_ENV,
                kind: "setting",
                overrides: spec.key,
                accepts: acceptsFor(spec),
                secret: true,
                description: `Fallback for ${spec.key} when ${spec.env} is unset`,
            },
        ];
    }),
    {
        name: QUIET_ENV,
        kind: "cli",
        overrides: "--quiet",
        accepts: BOOLEAN_ACCEPTS,
        description: "Only print warnings and errors (ignored if --quiet or --verbose is passed)",
    },
    {
        name: VERBOSE_ENV,
        kind: "cli",
        overrides: "--verbose",
        accepts: BOOLEAN_ACCEPTS,
        description: "Show extra detail (ignored if --quiet or --verbose is passed)",
    },
    {
        name: JSON_ENV,
        kind: "cli",
        overrides: "--json",
        accepts: BOOLEAN_ACCEPTS,
        description: "Print machine-readable JSON to stdout",
    },
    {
        name: LOG_LEVEL_ENV,
        kind: "cli",
        overrides: "--log-level",
        accepts: LOG_THRESHOLDS.join("|"),
        description: "Minimum level written to .tyr/logs/tyr.log; inherited by the background process",
    },
];

/* -------------------------------------------------------------------------
 * Settings layer
 * ---------------------------------------------------------------------- */

export interface EnvSettings {
    /** Only the keys an env var validly set. */
    patch: SettingsPatch;
    /** Setting key -> the variable that supplied it, e.g. { "ai.apiKey": "ANTHROPIC_API_KEY" }. */
    sources: Record<string, string>;
    /** One line per ignored variable, naming it. Never contains a secret value. */
    warnings: string[];
}

/** The variable's value, or undefined when it is unset, empty or whitespace. */
function readVar(env: NodeJS.ProcessEnv, name: string): string | undefined {
    const raw = env[name];
    return raw === undefined || raw.trim() === "" ? undefined : raw;
}

/**
 * Read the env settings layer. Pure and total: unset/empty variables are
 * skipped, invalid ones produce a warning and are skipped.
 */
export function readEnvSettings(env: NodeJS.ProcessEnv = process.env): EnvSettings {
    let patch: SettingsPatch = {};
    const sources: Record<string, string> = {};
    const warnings: string[] = [];

    for (const spec of SETTING_KEYS) {
        let name = spec.env;
        let raw = readVar(env, name);
        // TYR_API_KEY wins; the conventional ANTHROPIC_API_KEY is the fallback
        // so an existing Anthropic setup works with no Tyr-specific config.
        if (raw === undefined && spec.key === "ai.apiKey") {
            name = ANTHROPIC_API_KEY_ENV;
            raw = readVar(env, name);
        }
        if (raw === undefined) continue;

        // Empty values never get here (readVar), so a list's "" -> [] rule
        // cannot fire from the environment; TYR_NOTIFY=none is the way.
        const parsed = parseSettingValue(spec, raw);
        if (!parsed.ok) {
            // Contract errors quote the raw value, which helps spot a typo,
            // but a secret's value must never reach a terminal or a log.
            warnings.push(
                spec.secret
                    ? `${name}: invalid value for ${spec.key}; ignored`
                    : `${name}: ${parsed.error}; ignored`,
            );
            continue;
        }
        patch = setAtPath(patch, spec.key, parsed.value);
        sources[spec.key] = name;
    }

    return { patch, sources, warnings };
}

/* -------------------------------------------------------------------------
 * Global CLI options
 * ---------------------------------------------------------------------- */

/** The global flags this module can fill in; structurally a subset of GlobalOptions. */
export interface EnvGlobalFlags {
    verbose?: boolean;
    quiet?: boolean;
    json?: boolean;
    logLevel?: LogThreshold;
}

/**
 * Layer TYR_QUIET / TYR_VERBOSE / TYR_JSON under the parsed command-line
 * flags. Precedence is flag > env > default:
 *
 * - Verbosity is decided as a unit. If --quiet or --verbose was passed, both
 *   env variables are ignored, so `TYR_QUIET=1 tyr init --verbose` is
 *   verbose rather than a conflict error. If both env variables are true
 *   they cancel out with a warning (the flags themselves conflict).
 * - --json is a plain switch with no --no-json; TYR_JSON=0 is how a script
 *   turns an inherited TYR_JSON=1 back off.
 * - Like --verbose, TYR_VERBOSE implies debug logging, but only when nothing
 *   more specific is set: --log-level wins, and so does TYR_LOG_LEVEL (both
 *   come from the environment, and the dedicated variable is more specific).
 *
 * TYR_LOG_LEVEL itself is still resolved by log.ts; it is only consulted
 * here for that last rule. Returns a new object; `flags` is not modified.
 */
export function applyEnvGlobals<T extends EnvGlobalFlags>(
    flags: T,
    env: NodeJS.ProcessEnv = process.env,
): { options: T & EnvGlobalFlags; warnings: string[] } {
    const warnings: string[] = [];
    const options: T & EnvGlobalFlags = { ...flags };

    const bool = (name: string): boolean | undefined => {
        const raw = readVar(env, name);
        if (raw === undefined) return undefined;
        const parsed = parseSettingValue({ key: name, type: "boolean", env: name, description: "" }, raw);
        if (parsed.ok) return parsed.value as boolean;
        warnings.push(`${name}: must be true or false, got "${raw}"; ignored`);
        return undefined;
    };
    const quiet = bool(QUIET_ENV);
    const verbose = bool(VERBOSE_ENV);
    const json = bool(JSON_ENV);

    if (flags.quiet === undefined && flags.verbose === undefined) {
        if (quiet === true && verbose === true) {
            warnings.push(`${QUIET_ENV} and ${VERBOSE_ENV} are both set; ignoring both`);
        } else if (quiet === true) {
            options.quiet = true;
        } else if (verbose === true) {
            options.verbose = true;
            const envLevel = readVar(env, LOG_LEVEL_ENV);
            if (flags.logLevel === undefined && envLevel !== undefined) {
                try {
                    options.logLevel = parseLogLevel(envLevel);
                } catch {
                    // Invalid TYR_LOG_LEVEL: log.ts ignores it too, so verbose's debug applies.
                }
            }
        }
    }
    if (flags.json === undefined && json === true) {
        options.json = true;
    }

    return { options, warnings };
}
