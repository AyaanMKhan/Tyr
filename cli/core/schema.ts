// Runtime validation of `.tyr/tyr.json` and `.tyr/state/state.json`.
//
// Both files are hand-editable, so a parsed document is `unknown` until it has
// been checked here. The validators run AFTER migration (migrate.ts) and
// expect the current schema version. Rules:
//
// - A field that is present with the wrong type is an error, and so is a
//   missing field that has no sensible default (identity fields such as
//   `version`, `project.root`, `state.status`). Errors make the document
//   unusable: readConfig/readState return null and loadConfig/loadState
//   report the messages.
// - A missing field that detection can always refill (file counts, language
//   lists, git snapshot, docs paths, scan lists) is filled with its documented
//   default and reported as a warning, so an older or trimmed file keeps
//   working. Fields marked optional in types.ts may be absent silently.
// - Unknown keys are preserved untouched, at every level: reinit-merge.ts
//   carries them forward, and a newer Tyr's additions must survive.
//
// Messages use dotted paths: `commands.test.command: expected string, got number`.
//
// No dependencies: the schema is small and a hand-written walker keeps the
// messages exact.

import type { CommandKind, TyrConfig, TyrState } from "./types.js";
import { CURRENT_CONFIG_VERSION, CURRENT_STATE_VERSION } from "./migrate.js";

export type ValidationResult<T> =
    | { ok: true; value: T; warnings: string[] }
    | { ok: false; errors: string[]; warnings: string[] };

type JsonObject = Record<string, unknown>;

const COMMAND_KINDS: readonly CommandKind[] = ["build", "test", "lint", "format", "typecheck"];
const STATUSES: readonly TyrState["status"][] = ["initialized", "running", "stopped", "error"];
const WORKSPACE_TOOLS = ["npm", "yarn", "pnpm", "cargo", "nested"];

function isObject(value: unknown): value is JsonObject {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** `null`, `array`, or the `typeof` name: what a message says we got. */
function describe(value: unknown): string {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    return typeof value;
}

/**
 * Collects errors and warnings while walking one document. Each `field`
 * check reads `obj[key]`, applies a default when the key is missing (if one
 * is given), and otherwise checks the type.
 */
class Checker {
    readonly errors: string[] = [];
    readonly warnings: string[] = [];

    expected(where: string, what: string, got: unknown): void {
        this.errors.push(`${where}: expected ${what}, got ${describe(got)}`);
    }

    /**
     * Shared handling for a missing key. Returns true when the key is
     * present and the caller should type-check it.
     */
    private present(obj: JsonObject, key: string, where: string, spec: FieldSpec): boolean {
        if (key in obj && obj[key] !== undefined) return true;
        if (spec.optional) return false;
        if ("default" in spec) {
            obj[key] = typeof spec.default === "function" ? (spec.default as () => unknown)() : spec.default;
            this.warnings.push(`${where}: missing, defaulted to ${JSON.stringify(obj[key])}`);
            return false;
        }
        this.errors.push(`${where}: missing (expected ${spec.what})`);
        return false;
    }

    field(obj: JsonObject, key: string, prefix: string, spec: FieldSpec): void {
        const where = prefix + key;
        if (!this.present(obj, key, where, spec)) return;
        const value = obj[key];
        if (!spec.test(value)) {
            this.expected(where, spec.what, value);
            return;
        }
        spec.inner?.(value, where, this);
    }

    /** A required nested object, created empty (with a warning) when it has a default. */
    section(obj: JsonObject, key: string, prefix: string, required: boolean): JsonObject | null {
        const where = prefix + key;
        const value = obj[key];
        if (value === undefined) {
            if (required) {
                this.errors.push(`${where}: missing (expected object)`);
                return null;
            }
            obj[key] = {};
            this.warnings.push(`${where}: missing, defaulted to {}`);
            return obj[key] as JsonObject;
        }
        if (!isObject(value)) {
            this.expected(where, "object", value);
            return null;
        }
        return value;
    }
}

interface FieldSpec {
    what: string;
    test: (value: unknown) => boolean;
    /** Absent is fine and nothing is filled in. */
    optional?: boolean;
    /** Filled in (with a warning) when absent. A function is called for a fresh value. */
    default?: unknown;
    /** Further checks once the top-level type matched. */
    inner?: (value: unknown, where: string, checker: Checker) => void;
}

/* -------------------------------------------------------------------------
 * Primitive specs
 * ---------------------------------------------------------------------- */

const isString = (v: unknown): boolean => typeof v === "string";
const isNonEmptyString = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";
const isStringOrNull = (v: unknown): boolean => v === null || typeof v === "string";
const isBoolean = (v: unknown): boolean => typeof v === "boolean";
const isCount = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v) && v >= 0;

function str(extra: Partial<FieldSpec> = {}): FieldSpec {
    return { what: "string", test: isString, ...extra };
}
function nonEmpty(extra: Partial<FieldSpec> = {}): FieldSpec {
    return { what: "non-empty string", test: isNonEmptyString, ...extra };
}
function strOrNull(extra: Partial<FieldSpec> = {}): FieldSpec {
    return { what: "string or null", test: isStringOrNull, ...extra };
}
function bool(extra: Partial<FieldSpec> = {}): FieldSpec {
    return { what: "boolean", test: isBoolean, ...extra };
}
function count(extra: Partial<FieldSpec> = {}): FieldSpec {
    return { what: "non-negative integer", test: isCount, ...extra };
}
function oneOf(values: readonly string[], extra: Partial<FieldSpec> = {}): FieldSpec {
    return {
        what: values.map((v) => JSON.stringify(v)).join(" | "),
        test: (v) => typeof v === "string" && values.includes(v),
        ...extra,
    };
}

/** An array whose every element passes `element`; element messages carry `[i]`. */
function arrayOf(element: FieldSpec, extra: Partial<FieldSpec> = {}): FieldSpec {
    return {
        what: "array",
        test: Array.isArray,
        inner(value, where, checker) {
            (value as unknown[]).forEach((item, index) => {
                const at = `${where}[${index}]`;
                if (!element.test(item)) checker.expected(at, element.what, item);
                else element.inner?.(item, at, checker);
            });
        },
        ...extra,
    };
}

function stringList(extra: Partial<FieldSpec> = {}): FieldSpec {
    return arrayOf(str(), { what: "array of strings", ...extra });
}

/** An object checked field by field; unknown keys are left alone. */
function objectOf(fields: Record<string, FieldSpec>, extra: Partial<FieldSpec> = {}): FieldSpec {
    return {
        what: "object",
        test: isObject,
        inner(value, where, checker) {
            for (const [key, spec] of Object.entries(fields)) {
                checker.field(value as JsonObject, key, `${where}.`, spec);
            }
        },
        ...extra,
    };
}

/** `spec`, or null. */
function nullable(spec: FieldSpec, extra: Partial<FieldSpec> = {}): FieldSpec {
    return {
        what: `${spec.what} or null`,
        test: (v) => v === null || spec.test(v),
        inner: (v, where, checker) => {
            if (v !== null) spec.inner?.(v, where, checker);
        },
        ...extra,
    };
}

/* -------------------------------------------------------------------------
 * tyr.json
 * ---------------------------------------------------------------------- */

const LANGUAGE_STAT = objectOf({
    name: str(),
    fileCount: count(),
    percentage: { what: "number", test: (v) => typeof v === "number" && Number.isFinite(v) },
});

/**
 * One command slot. `command` is what Tyr runs, so it must be a non-empty
 * string; `tool` and `evidence` are display-only and default to "" when a
 * hand-written entry leaves them out.
 */
const CONFIG_COMMAND = objectOf({
    command: nonEmpty(),
    tool: str({ default: "" }),
    evidence: str({ default: "" }),
    source: oneOf(["detected", "user"], { optional: true }),
});

const WORKSPACE = objectOf({
    tool: oneOf(WORKSPACE_TOOLS),
    packages: stringList(),
});

export function validateConfig(raw: unknown): ValidationResult<TyrConfig> {
    const checker = new Checker();
    if (!isObject(raw)) {
        checker.expected("tyr.json", "object", raw);
        return { ok: false, errors: checker.errors, warnings: checker.warnings };
    }
    const doc = structuredClone(raw);

    checker.field(doc, "version", "", {
        what: `${CURRENT_CONFIG_VERSION}`,
        test: (v) => v === CURRENT_CONFIG_VERSION,
    });
    checker.field(doc, "tyrVersion", "", str({ default: "unknown" }));
    checker.field(doc, "initializedAt", "", str({ default: "unknown" }));

    const project = checker.section(doc, "project", "", true);
    if (project !== null) {
        const p = "project.";
        checker.field(project, "name", p, str());
        checker.field(project, "root", p, nonEmpty());
        checker.field(project, "primaryLanguage", p, strOrNull({ default: null }));
        checker.field(project, "languages", p, arrayOf(LANGUAGE_STAT, { default: () => [] }));
        checker.field(project, "frameworks", p, stringList({ default: () => [] }));
        checker.field(project, "packageManager", p, strOrNull({ default: null }));
        checker.field(project, "fileCount", p, count({ default: 0 }));
        checker.field(project, "workspace", p, nullable(WORKSPACE, { optional: true }));
    }

    const commands = checker.section(doc, "commands", "", true);
    if (commands !== null) {
        for (const kind of COMMAND_KINDS) {
            checker.field(commands, kind, "commands.", nullable(CONFIG_COMMAND, { default: null }));
        }
        // Extra slots (e.g. a user-added `commands.e2e`) are kept as-is.
    }

    const git = checker.section(doc, "git", "", false);
    if (git !== null) {
        checker.field(git, "isRepo", "git.", bool({ default: false }));
        checker.field(git, "branch", "git.", strOrNull({ default: null }));
        checker.field(git, "detached", "git.", bool({ optional: true }));
        checker.field(git, "remote", "git.", strOrNull({ default: null }));
        checker.field(git, "headCommit", "git.", strOrNull({ default: null }));
    }

    const docs = checker.section(doc, "docs", "", false);
    if (docs !== null) {
        checker.field(docs, "readme", "docs.", strOrNull({ default: null }));
        checker.field(docs, "claudeMd", "docs.", strOrNull({ default: null }));
    }

    const scan = checker.section(doc, "scan", "", false);
    if (scan !== null) {
        checker.field(scan, "ignoredDirs", "scan.", stringList({ default: () => [] }));
        checker.field(scan, "ignoredExtensions", "scan.", stringList({ default: () => [] }));
        checker.field(scan, "ignoredFiles", "scan.", stringList({ optional: true }));
        checker.field(scan, "extraIgnore", "scan.", stringList({ optional: true }));
    }

    const detectedCommands: Record<string, FieldSpec> = {};
    for (const kind of COMMAND_KINDS) detectedCommands[kind] = strOrNull({ default: null });
    checker.field(doc, "detected", "", objectOf({ commands: objectOf(detectedCommands) }, { optional: true }));

    if (checker.errors.length > 0) {
        return { ok: false, errors: checker.errors, warnings: checker.warnings };
    }
    return { ok: true, value: doc as unknown as TyrConfig, warnings: checker.warnings };
}

/* -------------------------------------------------------------------------
 * state.json
 * ---------------------------------------------------------------------- */

export function validateState(raw: unknown): ValidationResult<TyrState> {
    const checker = new Checker();
    if (!isObject(raw)) {
        checker.expected("state.json", "object", raw);
        return { ok: false, errors: checker.errors, warnings: checker.warnings };
    }
    const doc = structuredClone(raw);

    checker.field(doc, "version", "", {
        what: `${CURRENT_STATE_VERSION}`,
        test: (v) => v === CURRENT_STATE_VERSION,
    });
    checker.field(doc, "status", "", oneOf(STATUSES));
    checker.field(doc, "createdAt", "", str());
    checker.field(doc, "updatedAt", "", str());
    checker.field(doc, "lastIndexedCommit", "", strOrNull({ default: null }));
    checker.field(doc, "lastScanFileCount", "", count({ default: 0 }));
    checker.field(doc, "runCount", "", count({ default: 0 }));
    checker.field(doc, "lastRunAt", "", strOrNull({ default: null }));
    checker.field(doc, "pid", "", nullable(count(), { optional: true }));
    checker.field(doc, "startedAt", "", strOrNull({ optional: true }));

    if (checker.errors.length > 0) {
        return { ok: false, errors: checker.errors, warnings: checker.warnings };
    }
    return { ok: true, value: doc as unknown as TyrState, warnings: checker.warnings };
}
