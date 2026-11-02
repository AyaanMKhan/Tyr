// Re-init merge: what `tyr init --force` keeps from the previous `.tyr/`.
//
// A forced re-init re-runs detection, so everything detection owns (git
// snapshot, file counts, language stats, ignore lists, versions) is
// refreshed. `project.root` always comes from the fresh config, which stores
// the portable "." (config schema v2), so a previous absolute root is never
// carried over. What it must not do is throw away the user's own work:
//
// - Commands the user edited in tyr.json. An entry counts as user-edited when
//   it is marked `source: "user"` (interactive editing writes that), or when
//   its command string differs from the `detected` baseline that the previous
//   init recorded next to it. Diffing against the *previous* detection — not
//   today's — is what tells a hand edit apart from a project change: if the
//   user adds a Jest config, the old detected `test` command is refreshed; if
//   the user rewrote `test` by hand, it is kept even though detection moved.
//   Configs written before the baseline existed have nothing to diff against,
//   so a non-null command that differs from fresh detection is kept: losing a
//   hand edit is worse than missing a detection change, and `--reset` (or the
//   next `--force`, once a baseline exists) recovers either way.
// - Keys the user (or a newer Tyr) added that this version does not know
//   about, at the top level and inside each known section.
// - State history: `createdAt`, `runCount`, `lastRunAt`, `status`, and any
//   extra fields such as history or event arrays.
//
// Pure functions only: scaffold.ts reads the old files, migrates them to the
// current schema version (migrate.ts) and writes the result. The previous
// documents are migrated but intentionally not validated, which is why
// everything here treats them as loosely typed.

import type { CommandKind, ConfigCommand, TyrConfig, TyrState } from "./types.js";

export const COMMAND_KINDS: readonly CommandKind[] = ["build", "test", "lint", "format", "typecheck"];

export interface ConfigMergeResult {
    config: TyrConfig;
    /** Command slots whose previous (user-edited) value was kept, in display order. */
    keptCommands: CommandKind[];
    /** Unknown keys carried over, as dotted paths (e.g. "notify", "project.alias"). */
    keptKeys: string[];
}

export interface StateMergeResult {
    state: TyrState;
    /** State fields carried over from the previous state.json. */
    keptFields: string[];
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Accept a hand-edited command entry only if it still has the shape Tyr runs:
 * a non-empty command string. Anything else is treated as absent.
 */
function asCommand(value: unknown): ConfigCommand | null {
    if (!isObject(value) || typeof value.command !== "string" || value.command.trim() === "") {
        return null;
    }
    return value as unknown as ConfigCommand;
}

/**
 * Interactive editing marks its commands as user-provided. `source` is the
 * field; `evidence: "user"` is accepted too so either encoding is honoured.
 */
function isMarkedUser(value: unknown): boolean {
    return isObject(value) && (value.source === "user" || value.evidence === "user");
}

/** Copy keys of `previous` that `fresh` does not define, recording their paths. */
function carryUnknownKeys(fresh: JsonObject, previous: JsonObject, prefix: string, kept: string[]): void {
    for (const [key, value] of Object.entries(previous)) {
        if (!(key in fresh)) {
            fresh[key] = value;
            kept.push(prefix + key);
        }
    }
}

/**
 * Decide, per command slot, whether the previous value was a user edit.
 * Returns true when the previous value should win over fresh detection.
 */
function isUserEdited(kind: CommandKind, previous: JsonObject, fresh: TyrConfig): boolean {
    const commands = isObject(previous.commands) ? previous.commands : null;
    if (commands === null || !(kind in commands)) {
        return false;
    }
    const raw = commands[kind];
    if (isMarkedUser(raw)) {
        return true;
    }

    const old = asCommand(raw);
    // A malformed entry (not null, but no usable command) is a broken edit,
    // not a choice to keep; let detection repair it.
    if (old === null && raw !== null) {
        return false;
    }
    const oldCommand = old === null ? null : old.command;

    const detected = isObject(previous.detected) && isObject(previous.detected.commands)
        ? previous.detected.commands
        : null;
    if (detected !== null && kind in detected) {
        const baseline = detected[kind];
        // Null in place of a detected command is a deliberate "don't run this".
        return oldCommand !== (typeof baseline === "string" ? baseline : null);
    }

    // Legacy config without a baseline: an empty slot is never treated as an
    // edit, and a command is kept only when detection would now say otherwise.
    if (oldCommand === null) {
        return false;
    }
    return oldCommand !== (fresh.commands[kind]?.command ?? null);
}

/**
 * Merge a freshly built config with the previous tyr.json. `previous` is the
 * migrated (not validated) previous document — typed loosely because it may
 * be hand-edited. `version` and `project.root` always come from `fresh`.
 */
export function mergeConfig(fresh: TyrConfig, previous: unknown): ConfigMergeResult {
    const keptCommands: CommandKind[] = [];
    const keptKeys: string[] = [];
    if (!isObject(previous)) {
        return { config: fresh, keptCommands, keptKeys };
    }

    // Copy so the caller's `fresh` is never mutated.
    const config = structuredClone(fresh);

    // The first init's timestamp is history, not detection.
    if (typeof previous.initializedAt === "string") {
        config.initializedAt = previous.initializedAt;
    }

    const prevCommands = isObject(previous.commands) ? previous.commands : {};
    for (const kind of COMMAND_KINDS) {
        if (isUserEdited(kind, previous, fresh)) {
            const raw = prevCommands[kind];
            config.commands[kind] = raw === null ? null : (raw as ConfigCommand);
            keptCommands.push(kind);
        }
    }

    // Unknown keys inside each known section (e.g. a user-added
    // `commands.e2e`), then unknown top-level keys.
    const sections = config as unknown as JsonObject;
    for (const section of ["project", "commands", "git", "docs", "scan"]) {
        if (isObject(previous[section]) && isObject(sections[section])) {
            carryUnknownKeys(sections[section] as JsonObject, previous[section] as JsonObject, `${section}.`, keptKeys);
        }
    }
    carryUnknownKeys(sections, previous, "", keptKeys);

    return { config, keptCommands, keptKeys };
}

const STATUSES: readonly TyrState["status"][] = ["initialized", "running", "stopped", "error"];

/**
 * Merge a fresh initial state with the previous state.json. Detection-derived
 * fields (`lastIndexedCommit`, `lastScanFileCount`, `updatedAt`, `version`)
 * come from `fresh`; history survives.
 */
export function mergeState(fresh: TyrState, previous: unknown): StateMergeResult {
    const keptFields: string[] = [];
    if (!isObject(previous)) {
        return { state: fresh, keptFields };
    }

    const state = { ...fresh } as TyrState & JsonObject;

    if (typeof previous.createdAt === "string") {
        state.createdAt = previous.createdAt;
        keptFields.push("createdAt");
    }
    if (typeof previous.runCount === "number" && Number.isFinite(previous.runCount) && previous.runCount >= 0) {
        state.runCount = previous.runCount;
        keptFields.push("runCount");
    }
    if (typeof previous.lastRunAt === "string" || previous.lastRunAt === null) {
        state.lastRunAt = previous.lastRunAt;
        keptFields.push("lastRunAt");
    }
    // None of the statuses is clearly transient from here. "running" in
    // particular may be true: the daemon (PID file in .tyr/state/) owns
    // liveness and is the one to correct a stale value, so re-init must not
    // guess. Only a missing or unknown status falls back to "initialized".
    if (STATUSES.includes(previous.status as TyrState["status"])) {
        state.status = previous.status as TyrState["status"];
        keptFields.push("status");
    }

    // History/event arrays and anything a newer Tyr wrote.
    carryUnknownKeys(state, previous, "", keptFields);

    return { state, keptFields };
}
