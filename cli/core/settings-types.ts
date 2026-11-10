// Shared contract for Tyr's user settings (PLANNING.md 2.7).
//
// tyr.json is Tyr's *detection snapshot*: what `tyr init` found. Settings are
// the user's *preferences*: what Tyr should do about it. They resolve from
// layers, lowest precedence first:
//
//   default  <  global (~/.config/tyr/config.json)  <  project (.tyr/settings.json)  <  env (TYR_*)
//
// This module is pure (no I/O). Each layer's loader produces a SettingsPatch;
// the resolver deep-merges them over DEFAULT_SETTINGS.

export type Severity = "info" | "warning" | "error";
export const SEVERITIES: readonly Severity[] = ["info", "warning", "error"];

/** How far the reviewing agent may go: read only, propose patches, or edit files. */
export type AgentPermission = "read-only" | "suggest" | "edit";
export const AGENT_PERMISSIONS: readonly AgentPermission[] = ["read-only", "suggest", "edit"];

export interface TyrSettings {
    /** Which detected commands Tyr runs as checks. */
    checks: {
        build: boolean;
        test: boolean;
        lint: boolean;
        format: boolean;
        typecheck: boolean;
    };
    /** Findings below this severity are not reported. */
    severity: { threshold: Severity };
    agent: { permission: AgentPermission };
    /** Where findings are sent, e.g. "terminal", "desktop", "webhook:https://…". */
    notifications: { targets: string[] };
    ai: {
        /** Model id used for reviews. */
        model: string;
        /** API key. Secret: only the global file and env may set it. */
        apiKey: string | null;
    };
}

export const DEFAULT_SETTINGS: TyrSettings = {
    checks: { build: true, test: true, lint: true, format: false, typecheck: true },
    severity: { threshold: "warning" },
    agent: { permission: "suggest" },
    notifications: { targets: ["terminal"] },
    ai: { model: "claude-opus-5-5", apiKey: null },
};

export type DeepPartial<T> = {
    [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/** One layer's contribution: any subset of TyrSettings. */
export type SettingsPatch = DeepPartial<TyrSettings>;

export type SettingsLayer = "default" | "global" | "project" | "env";

export type SettingValueType = "boolean" | "enum" | "string" | "string-list" | "nullable-string";

export interface SettingKeySpec {
    /** Dotted path into TyrSettings, e.g. "checks.test". */
    key: string;
    type: SettingValueType;
    /** Allowed values for "enum". */
    values?: readonly string[];
    /** Environment variable that overrides it. */
    env: string;
    /** Secrets are masked on display and may not live in the committed project file. */
    secret?: boolean;
    description: string;
}

/** Every user-settable key. Single source of truth for get/set, env and validation. */
export const SETTING_KEYS: readonly SettingKeySpec[] = [
    { key: "checks.build", type: "boolean", env: "TYR_CHECKS_BUILD", description: "Run the detected build command" },
    { key: "checks.test", type: "boolean", env: "TYR_CHECKS_TEST", description: "Run the detected test command" },
    { key: "checks.lint", type: "boolean", env: "TYR_CHECKS_LINT", description: "Run the detected linter" },
    { key: "checks.format", type: "boolean", env: "TYR_CHECKS_FORMAT", description: "Run the detected formatter check" },
    { key: "checks.typecheck", type: "boolean", env: "TYR_CHECKS_TYPECHECK", description: "Run the detected type checker" },
    { key: "severity.threshold", type: "enum", values: SEVERITIES, env: "TYR_SEVERITY", description: "Lowest severity that gets reported" },
    { key: "agent.permission", type: "enum", values: AGENT_PERMISSIONS, env: "TYR_AGENT_PERMISSION", description: "What the reviewing agent may do" },
    { key: "notifications.targets", type: "string-list", env: "TYR_NOTIFY", description: "Comma-separated notification targets" },
    { key: "ai.model", type: "string", env: "TYR_MODEL", description: "Model used for reviews" },
    { key: "ai.apiKey", type: "nullable-string", env: "TYR_API_KEY", secret: true, description: "API key (global config or env only)" },
];

export function findSettingKey(key: string): SettingKeySpec | undefined {
    return SETTING_KEYS.find((spec) => spec.key === key);
}

export type ParseResult = { ok: true; value: unknown } | { ok: false; error: string };

/** Parse a string (from the command line or an env var) into the key's typed value. */
export function parseSettingValue(spec: SettingKeySpec, raw: string): ParseResult {
    const text = raw.trim();
    switch (spec.type) {
        case "boolean": {
            const lower = text.toLowerCase();
            if (["true", "1", "yes", "on"].includes(lower)) return { ok: true, value: true };
            if (["false", "0", "no", "off"].includes(lower)) return { ok: true, value: false };
            return { ok: false, error: `${spec.key} must be true or false, got "${raw}"` };
        }
        case "enum":
            if (spec.values?.includes(text)) return { ok: true, value: text };
            return { ok: false, error: `${spec.key} must be one of ${spec.values?.join(", ")}, got "${raw}"` };
        case "string":
            if (text === "") return { ok: false, error: `${spec.key} must not be empty` };
            return { ok: true, value: text };
        case "nullable-string":
            return { ok: true, value: text === "" ? null : text };
        case "string-list":
            return { ok: true, value: text === "" ? [] : text.split(",").map((s) => s.trim()).filter((s) => s !== "") };
    }
}

/** Check an already-typed value (e.g. from a JSON file) against the key's type. */
export function checkSettingValue(spec: SettingKeySpec, value: unknown): string | null {
    switch (spec.type) {
        case "boolean":
            return typeof value === "boolean" ? null : `${spec.key} must be a boolean`;
        case "enum":
            return typeof value === "string" && spec.values?.includes(value)
                ? null
                : `${spec.key} must be one of ${spec.values?.join(", ")}`;
        case "string":
            return typeof value === "string" && value.trim() !== "" ? null : `${spec.key} must be a non-empty string`;
        case "nullable-string":
            return value === null || typeof value === "string" ? null : `${spec.key} must be a string or null`;
        case "string-list":
            return Array.isArray(value) && value.every((v) => typeof v === "string")
                ? null
                : `${spec.key} must be an array of strings`;
    }
}

export function getAtPath(obj: unknown, key: string): unknown {
    let cur: unknown = obj;
    for (const part of key.split(".")) {
        if (cur === null || typeof cur !== "object") return undefined;
        cur = (cur as Record<string, unknown>)[part];
    }
    return cur;
}

/** Returns a copy of `obj` with `key` set to `value`, creating intermediate objects. */
export function setAtPath<T extends object>(obj: T, key: string, value: unknown): T {
    const parts = key.split(".");
    const root: Record<string, unknown> = structuredClone(obj) as Record<string, unknown>;
    let cur = root;
    for (const part of parts.slice(0, -1)) {
        const next = cur[part];
        if (next === null || typeof next !== "object" || Array.isArray(next)) cur[part] = {};
        cur = cur[part] as Record<string, unknown>;
    }
    cur[parts[parts.length - 1]] = value;
    return root as T;
}

/** Returns a copy of `obj` without `key`; empty parent objects are pruned. */
export function unsetAtPath<T extends object>(obj: T, key: string): T {
    const root = structuredClone(obj) as Record<string, unknown>;
    const parts = key.split(".");
    const chain: Record<string, unknown>[] = [root];
    for (const part of parts.slice(0, -1)) {
        const next = chain[chain.length - 1][part];
        if (next === null || typeof next !== "object") return root as T;
        chain.push(next as Record<string, unknown>);
    }
    delete chain[chain.length - 1][parts[parts.length - 1]];
    for (let i = chain.length - 1; i > 0; i--) {
        if (Object.keys(chain[i]).length === 0) delete chain[i - 1][parts[i - 1]];
    }
    return root as T;
}

/**
 * Validate a raw JSON object as a SettingsPatch: keeps only known keys with
 * valid values. Unknown keys and bad values become warnings, never errors, so
 * one typo does not disable every other setting.
 */
export function sanitizePatch(raw: unknown, source: string): { patch: SettingsPatch; warnings: string[] } {
    const warnings: string[] = [];
    let patch: SettingsPatch = {};
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        return { patch, warnings: [`${source}: settings must be a JSON object`] };
    }
    for (const spec of SETTING_KEYS) {
        const value = getAtPath(raw, spec.key);
        if (value === undefined) continue;
        const problem = checkSettingValue(spec, value);
        if (problem !== null) warnings.push(`${source}: ${problem}; ignored`);
        else patch = setAtPath(patch, spec.key, value);
    }
    for (const key of leafKeys(raw)) {
        if (!findSettingKey(key)) warnings.push(`${source}: unknown setting "${key}"; ignored`);
    }
    return { patch, warnings };
}

function leafKeys(obj: unknown, prefix = ""): string[] {
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return prefix ? [prefix] : [];
    return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
        leafKeys(v, prefix ? `${prefix}.${k}` : k),
    );
}
