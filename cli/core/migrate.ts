// Schema version migration for `.tyr/tyr.json` and `.tyr/state/state.json`.
//
// Each document carries a numeric `version`. A missing `version` counts as 1,
// since the earliest files predate the field being read by anything. Reading
// a document runs it through an ordered chain of pure steps, one per version
// bump, until it reaches the current version; scaffold.ts then validates the
// result (schema.ts).
//
// A document whose version is NEWER than this Tyr understands is refused,
// never downgraded or rewritten: a newer Tyr may have changed the meaning of
// fields this version would silently misread or drop. Callers surface the
// error ("written by a newer Tyr") and leave the file alone.
//
// Adding a migration: bump the CURRENT_* constant, append a step whose
// `from` is the previous current version, and keep the step pure (it gets
// its own deep copy and must not touch the filesystem).
//
// Config history:
//   v1  original format. `project.root` held the absolute, machine-specific
//       path of the project; very early files stored commands as bare strings.
//   v2  `project.root` is stored relative to the directory that contains
//       `.tyr/` (always "." when Tyr writes it), so tyr.json is portable and
//       safe to commit. readConfig rehydrates it to an absolute path.
//       Commands are always objects ({ command, tool, evidence }).
//
// State history:
//   v1  current.

import * as path from "node:path";

export const CURRENT_CONFIG_VERSION = 2;
export const CURRENT_STATE_VERSION = 1;

type JsonObject = Record<string, unknown>;

export interface MigrationStep {
    /** Version this step upgrades from; it produces `from + 1`. */
    from: number;
    /** One line for logs and `tyr status`, e.g. "config v1 -> v2: ...". */
    description: string;
    /** Pure: receives a private deep copy and returns the upgraded document. */
    apply: (doc: JsonObject) => JsonObject;
}

export type MigrationResult =
    | {
          ok: true;
          /** The upgraded document (a copy; the input is never mutated). */
          value: JsonObject;
          fromVersion: number;
          toVersion: number;
          /** Descriptions of the steps that ran, in order; empty when already current. */
          steps: string[];
      }
    | {
          ok: false;
          /**
           * `newer`: written by a newer Tyr, must be left untouched.
           * `invalid`: not an object, or an unusable `version` field.
           */
          reason: "newer" | "invalid";
          errors: string[];
      };

function isObject(value: unknown): value is JsonObject {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Absolute on either platform, so a file written on Linux is recognised on Windows and vice versa. */
function isAbsoluteAnywhere(p: string): boolean {
    return path.posix.isAbsolute(p) || path.win32.isAbsolute(p);
}

/** `"npm run build"` from very early configs -> the object form. */
function commandFromString(command: string): JsonObject {
    const tool = command.trim().split(/\s+/)[0] ?? "";
    return { command, tool, evidence: "tyr.json" };
}

export const CONFIG_MIGRATIONS: readonly MigrationStep[] = [
    {
        from: 1,
        description: "config v1 -> v2: store project.root relative to the project (\".\")",
        apply(doc) {
            const project = doc.project;
            if (isObject(project) && typeof project.root === "string" && isAbsoluteAnywhere(project.root)) {
                // The absolute path is wherever the project happened to live
                // when it was initialized; the location of `.tyr/` is the truth.
                project.root = ".";
            }
            const commands = doc.commands;
            if (isObject(commands)) {
                for (const [kind, value] of Object.entries(commands)) {
                    if (typeof value === "string") {
                        commands[kind] = value.trim() === "" ? null : commandFromString(value);
                    }
                }
            }
            doc.version = 2;
            return doc;
        },
    },
];

export const STATE_MIGRATIONS: readonly MigrationStep[] = [];

/**
 * Run `raw` through `steps` up to `current`. Exported for tests; use
 * migrateConfig / migrateState.
 */
export function runMigrations(
    raw: unknown,
    current: number,
    steps: readonly MigrationStep[],
    label: string,
): MigrationResult {
    if (!isObject(raw)) {
        return { ok: false, reason: "invalid", errors: [`${label}: expected a JSON object`] };
    }

    const declared = raw.version;
    let version: number;
    if (declared === undefined) {
        version = 1;
    } else if (typeof declared === "number" && Number.isInteger(declared) && declared >= 1) {
        version = declared;
    } else {
        return {
            ok: false,
            reason: "invalid",
            errors: [`version: expected a positive integer, got ${JSON.stringify(declared)}`],
        };
    }

    if (version > current) {
        return {
            ok: false,
            reason: "newer",
            errors: [
                `version: ${label} is version ${version}, written by a newer Tyr (this Tyr understands up to ${current}); upgrade Tyr`,
            ],
        };
    }

    let doc = structuredClone(raw);
    const fromVersion = version;
    const ran: string[] = [];
    while (version < current) {
        const step = steps.find((candidate) => candidate.from === version);
        if (step === undefined) {
            // A programming error (gap in the chain), not a user error.
            return { ok: false, reason: "invalid", errors: [`version: no migration from ${label} v${version}`] };
        }
        doc = step.apply(doc);
        version += 1;
        doc.version = version;
        ran.push(step.description);
    }
    // A missing version on an otherwise current doc gets stamped too.
    doc.version = version;

    return { ok: true, value: doc, fromVersion, toVersion: version, steps: ran };
}

export function migrateConfig(raw: unknown): MigrationResult {
    return runMigrations(raw, CURRENT_CONFIG_VERSION, CONFIG_MIGRATIONS, "tyr.json");
}

export function migrateState(raw: unknown): MigrationResult {
    return runMigrations(raw, CURRENT_STATE_VERSION, STATE_MIGRATIONS, "state.json");
}
