// Scaffolder: turns the detection snapshot into the on-disk `.tyr/` tree and
// owns every read/write of Tyr's own files afterwards.
//
// This module is deliberately silent — it writes files and returns data, never
// prints. The reporter owns all user-facing output. Failures that genuinely
// block initialization throw so the caller can report them; logging failures
// never do.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CommandKind, ConfigCommand, InitSnapshot, ProjectCommand, TyrConfig, TyrState } from "./types.js";
import { COMMAND_KINDS, mergeConfig, mergeState } from "./reinit-merge.js";
import { CURRENT_CONFIG_VERSION, CURRENT_STATE_VERSION, migrateConfig, migrateState, type MigrationResult } from "./migrate.js";
import { validateConfig, validateState, type ValidationResult } from "./schema.js";
import { writeLog, type LogLevel } from "./log.js";

/** Name of the directory Tyr owns inside a project root. */
export const TYR_DIR_NAME = ".tyr";

/** Every path the scaffold touches, resolved once from the project root. */
export interface TyrPaths {
    /** Absolute project root (the directory that contains `.tyr/`). */
    root: string;
    tyrDir: string;
    configFile: string;
    stateDir: string;
    stateFile: string;
    /** Scan manifest used for change detection; see scan-diff.ts. */
    scanFile: string;
    logsDir: string;
    logFile: string;
    reportsDir: string;
}

/**
 * `.tyr/.gitignore` — Tyr's volatile output is per-machine noise, but tyr.json
 * stays tracked so a team shares one config.
 */
const TYR_GITIGNORE = [
    "# Tyr runtime output — not meant to be committed.",
    "logs/",
    "reports/",
    "state/",
    "",
].join("\n");

/* -------------------------------------------------------------------------
 * Paths
 * ---------------------------------------------------------------------- */

export function resolveTyrPaths(root: string): TyrPaths {
    // Resolve up front: every consumer expects absolute paths, and an atomic
    // rename needs both sides in the same real directory.
    const absRoot = path.resolve(root);
    const tyrDir = path.join(absRoot, TYR_DIR_NAME);
    const stateDir = path.join(tyrDir, "state");
    const logsDir = path.join(tyrDir, "logs");
    const reportsDir = path.join(tyrDir, "reports");

    return {
        root: absRoot,
        tyrDir,
        configFile: path.join(tyrDir, "tyr.json"),
        stateDir,
        stateFile: path.join(stateDir, "state.json"),
        // Lives under state/ so the generated .gitignore already covers it.
        scanFile: path.join(stateDir, "scan.json"),
        logsDir,
        logFile: path.join(logsDir, "tyr.log"),
        reportsDir,
    };
}

/* -------------------------------------------------------------------------
 * Snapshot -> on-disk shapes
 * ---------------------------------------------------------------------- */

/**
 * Config keeps the tool and its evidence alongside the command string, so
 * later commands can explain *why* Tyr runs something without re-detecting.
 * Copied field by field so the on-disk shape never picks up extra keys.
 */
function commandOf(command: ProjectCommand | null): ConfigCommand | null {
    if (command === null) return null;
    const entry: ConfigCommand = { command: command.command, tool: command.tool, evidence: command.evidence };
    // Only the user marker is written; detected is the default and stays implicit.
    if (isUserProvided(command)) entry.source = "user";
    return entry;
}

/** Interactive editing tags the commands it collected; see reinit-merge.ts. */
function isUserProvided(command: ProjectCommand): boolean {
    return (command as { source?: unknown }).source === "user";
}

/**
 * The detection baseline written next to `commands`, so a later `--force` can
 * tell a hand edit from a detection change. User-provided commands are not
 * detection output, so their slot records null.
 */
function detectedCommandsOf(snapshot: InitSnapshot): Record<CommandKind, string | null> {
    const detected = {} as Record<CommandKind, string | null>;
    for (const kind of COMMAND_KINDS) {
        const command = snapshot.project[kind];
        detected[kind] = command === null || isUserProvided(command) ? null : command.command;
    }
    return detected;
}

/** Defensive: accept an array or a Set, keep only strings, never throw. */
function toStringList(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.filter((entry): entry is string => typeof entry === "string");
    }
    if (value instanceof Set) {
        return [...value].filter((entry): entry is string => typeof entry === "string");
    }
    return [];
}

/** What `project.root` holds on disk: the directory that contains `.tyr/`. */
export const PORTABLE_ROOT = ".";

export function buildConfig(snapshot: InitSnapshot, tyrVersion: string): TyrConfig {
    const { discovery, git, project } = snapshot;
    const root = path.resolve(discovery.root);

    // The authoritative ignore lists live in discovery.ts, which owns the walk.
    // DiscoveryResult does not carry them today, so read them off the object if
    // a later discovery version attaches them and fall back to empty arrays —
    // duplicating the lists here would let the two copies drift.
    // TODO: integrator — surface discovery's IGNORED_DIRS / IGNORED_EXTENSIONS
    // on DiscoveryResult (or pass them in) so `scan` reflects the real walk.
    const scanSource = discovery as unknown as {
        ignoredDirs?: unknown;
        ignoredExtensions?: unknown;
        ignoredFiles?: unknown;
        extraIgnore?: unknown;
    };

    return {
        version: CURRENT_CONFIG_VERSION,
        tyrVersion,
        initializedAt: new Date().toISOString(),
        project: {
            // The manifest name when one declares it; otherwise the root
            // directory name, which is the right fallback for every ecosystem.
            name: project.name ?? path.basename(root),
            // Stored relative to the directory holding `.tyr/`, so tyr.json is
            // machine-independent and safe to commit. readConfig rehydrates it
            // to the absolute path; see TyrConfig.project.root.
            root: PORTABLE_ROOT,
            primaryLanguage: project.primaryLanguage,
            languages: project.languages,
            frameworks: project.frameworks,
            packageManager: project.packageManager === null ? null : project.packageManager.name,
            fileCount: discovery.fileCount,
            workspace: project.workspace && { tool: project.workspace.tool, packages: project.workspace.packages.map((pkg) => pkg.path) },
        },
        commands: {
            build: commandOf(project.build),
            test: commandOf(project.test),
            lint: commandOf(project.lint),
            format: commandOf(project.format),
            typecheck: commandOf(project.typecheck),
        },
        git: {
            isRepo: git.isRepo,
            branch: git.branch,
            detached: git.detached,
            remote: git.defaultRemote,
            // Full hash, not the short one: this is what change detection diffs.
            headCommit: git.headCommit === null ? null : git.headCommit.hash,
        },
        docs: {
            readme: project.readme,
            claudeMd: project.claudeMd,
        },
        scan: {
            ignoredDirs: toStringList(scanSource.ignoredDirs),
            ignoredExtensions: toStringList(scanSource.ignoredExtensions),
            ignoredFiles: toStringList(scanSource.ignoredFiles),
            // User patterns, preserved across `--force` re-inits. Always written,
            // even when empty, so the knob is discoverable in tyr.json.
            extraIgnore: toStringList(scanSource.extraIgnore),
        },
        detected: {
            commands: detectedCommandsOf(snapshot),
        },
    };
}

export function buildInitialState(snapshot: InitSnapshot): TyrState {
    const now = new Date().toISOString();

    return {
        version: CURRENT_STATE_VERSION,
        status: "initialized",
        createdAt: now,
        updatedAt: now,
        lastIndexedCommit: snapshot.git.headCommit === null ? null : snapshot.git.headCommit.hash,
        lastScanFileCount: snapshot.discovery.fileCount,
        runCount: 0,
        lastRunAt: null,
    };
}

/* -------------------------------------------------------------------------
 * File primitives
 * ---------------------------------------------------------------------- */

/** Humans read and diff these files, so pretty-print and end with a newline. */
export function toJsonDocument(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Write via a temp file in the *same* directory, then rename onto the target.
 * The rename is atomic within a filesystem, so an interrupted init can never
 * leave a half-written tyr.json behind; a temp file in /tmp would risk EXDEV.
 */
export async function writeFileAtomic(target: string, contents: string): Promise<void> {
    const tmp = path.join(
        path.dirname(target),
        `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`,
    );

    try {
        await fs.writeFile(tmp, contents, "utf8");
        await fs.rename(tmp, target);
    } catch (error) {
        // Best-effort cleanup; the original failure is what the caller needs.
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        throw error;
    }
}

/** Outcome of reading one of Tyr's JSON files, keeping the reason on failure. */
export type JsonFileRead =
    | { kind: "ok"; value: Record<string, unknown> }
    | { kind: "missing" }
    | { kind: "invalid"; error: string };

/** Read and parse a JSON object file, saying why when it cannot. Never throws. */
export async function readJsonFile(file: string): Promise<JsonFileRead> {
    let raw: string;
    try {
        raw = await fs.readFile(file, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
        return { kind: "invalid", error: `unreadable: ${(error as Error).message}` };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        return { kind: "invalid", error: `malformed JSON: ${(error as Error).message}` };
    }
    // A hand-edited file can hold `null`, an array, or a bare scalar; none
    // of those are a usable config/state document.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        const got = parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed;
        return { kind: "invalid", error: `expected a JSON object, got ${got}` };
    }
    return { kind: "ok", value: parsed as Record<string, unknown> };
}

/**
 * Parse a JSON object, or null when it is missing, unreadable, or malformed.
 * The result is NOT validated: `T` is only a hint for callers that check the
 * shape themselves (scan-diff.ts). tyr.json and state.json go through
 * loadConfig / loadState, which migrate and validate.
 */
export async function readJsonObject<T = Record<string, unknown>>(file: string): Promise<T | null> {
    const read = await readJsonFile(file);
    return read.kind === "ok" ? (read.value as T) : null;
}

/* -------------------------------------------------------------------------
 * Scaffold + accessors
 * ---------------------------------------------------------------------- */

export interface ScaffoldOptions {
    /**
     * Discard the existing tyr.json and state.json instead of merging with
     * them (`tyr init --reset`). `scan.extraIgnore` still arrives through the
     * snapshot, exactly as before merging existed.
     */
    reset?: boolean;
}

/** What scaffold() carried over from an existing `.tyr/`; empty on a fresh init. */
export interface ScaffoldPreserved {
    /** Command slots whose user-edited value survived re-detection. */
    commands: CommandKind[];
    /** Unknown tyr.json keys carried over, as dotted paths. */
    configKeys: string[];
    /** state.json fields carried over (history, counters, extra keys). */
    stateFields: string[];
}

export interface ScaffoldResult extends TyrPaths {
    preserved: ScaffoldPreserved;
}

/**
 * Write `.tyr/`. When a previous tyr.json / state.json exists (a `--force`
 * re-init) they are merged rather than overwritten — see reinit-merge.ts —
 * unless `options.reset` is set. Files in `state/` other than state.json
 * (scan manifest, a daemon PID file) are never touched here.
 */
export async function scaffold(
    snapshot: InitSnapshot,
    tyrVersion: string,
    options: ScaffoldOptions = {},
): Promise<ScaffoldResult> {
    const paths = resolveTyrPaths(snapshot.discovery.root);

    // Read before anything is written. Missing or malformed files read as
    // null and simply produce a fresh config/state. Previous documents are
    // migrated to the current schema before merging (so e.g. a v1 absolute
    // root never leaks into the merge) but deliberately NOT validated: the
    // merge is lenient on purpose, so a half-broken hand edit still has its
    // commands and unknown keys carried over. Writing the merged result is
    // what upgrades tyr.json on disk; see loadConfig for why reads don't.
    const [previousConfig, previousState] = options.reset
        ? [null, null]
        : await Promise.all([
              readPreviousDocument(paths.configFile, migrateConfig),
              readPreviousDocument(paths.stateFile, migrateState),
          ]);
    const config = mergeConfig(buildConfig(snapshot, tyrVersion), previousConfig);
    const state = mergeState(buildInitialState(snapshot), previousState);

    // `recursive` also makes re-running init over a partial tree harmless.
    await fs.mkdir(paths.tyrDir, { recursive: true });
    await Promise.all([
        fs.mkdir(paths.stateDir, { recursive: true }),
        fs.mkdir(paths.logsDir, { recursive: true }),
        fs.mkdir(paths.reportsDir, { recursive: true }),
    ]);

    await writeFileAtomic(paths.configFile, toJsonDocument(config.config));
    await writeFileAtomic(paths.stateFile, toJsonDocument(state.state));

    await fs.writeFile(path.join(paths.tyrDir, ".gitignore"), TYR_GITIGNORE, "utf8");
    // Git will not track an empty directory; .gitkeep keeps reports/ in the tree.
    await fs.writeFile(path.join(paths.reportsDir, ".gitkeep"), "", "utf8");

    // Append rather than truncate so re-initializing keeps the existing
    // history (subject to the shared size cap / rotation in log.ts).
    await writeLog(
        paths.logFile,
        "info",
        `tyr init — scaffolded ${TYR_DIR_NAME}/ with Tyr ${tyrVersion} (${snapshot.discovery.fileCount} files scanned)`,
    );

    return {
        ...paths,
        preserved: { commands: config.keptCommands, configKeys: config.keptKeys, stateFields: state.keptFields },
    };
}

/**
 * A previous tyr.json / state.json for scaffold() to merge with, upgraded to
 * the current schema. A document from a newer Tyr is refused with an error
 * rather than overwritten with an older shape (`--reset` skips reading it).
 * Any other migration failure (e.g. a garbled `version`) falls back to the
 * raw document, which the lenient merge can still mine for user edits.
 */
async function readPreviousDocument(
    file: string,
    migrate: (raw: unknown) => MigrationResult,
): Promise<Record<string, unknown> | null> {
    const raw = await readJsonObject(file);
    if (raw === null) return null;
    const migrated = migrate(raw);
    if (migrated.ok) return migrated.value;
    if (migrated.reason === "newer") {
        throw new Error(
            `${path.basename(file)} was written by a newer version of Tyr; upgrade Tyr, or re-run with --reset to discard it. (${migrated.errors.join("; ")})`,
        );
    }
    return raw;
}

/**
 * Everything learned while loading tyr.json or state.json, for callers (a
 * future `tyr status`) that need to explain a problem rather than just see
 * `null`.
 */
export interface LoadResult<T> {
    /** The validated document, or null when it is missing or unusable. */
    value: T | null;
    /** True when the file does not exist (then `errors` is empty). */
    missing: boolean;
    /** Why `value` is null: parse, migration or validation errors, dotted paths. */
    errors: string[];
    /** Non-fatal findings, e.g. a missing field that was filled with its default. */
    warnings: string[];
    /** Migration steps applied while reading; empty when the file was current. */
    migrated: string[];
}

function loadFailure<T>(errors: string[], warnings: string[] = [], migrated: string[] = []): LoadResult<T> {
    return { value: null, missing: false, errors, warnings, migrated };
}

/** read JSON -> migrate -> validate, shared by loadConfig and loadState. */
async function loadDocument<T>(
    file: string,
    migrate: (raw: unknown) => MigrationResult,
    validate: (raw: unknown) => ValidationResult<T>,
): Promise<LoadResult<T> & { document: Record<string, unknown> | null }> {
    const name = path.basename(file);
    const read = await readJsonFile(file);
    if (read.kind === "missing") {
        return { value: null, missing: true, errors: [], warnings: [], migrated: [], document: null };
    }
    if (read.kind === "invalid") return { ...loadFailure<T>([`${name}: ${read.error}`]), document: null };

    const migration = migrate(read.value);
    if (!migration.ok) return { ...loadFailure<T>(migration.errors), document: null };

    const validation = validate(migration.value);
    if (!validation.ok) {
        return { ...loadFailure<T>(validation.errors, validation.warnings, migration.steps), document: null };
    }
    return {
        value: validation.value,
        missing: false,
        errors: [],
        warnings: validation.warnings,
        migrated: migration.steps,
        document: migration.value,
    };
}

/**
 * Load `.tyr/tyr.json`: parse, migrate to the current schema, validate.
 *
 * `project.root` is stored relative to the directory containing `.tyr/`
 * (normally "."); the returned config has it rehydrated to that absolute
 * path, so in-memory consumers always see an absolute root.
 *
 * Write-back policy: a config migrated here is NOT written back. tyr.json is
 * a tracked, hand-edited file, and a read-only command (`tyr start`, `tyr
 * status`) silently rewriting it would surprise users with a dirty working
 * tree and could clobber a concurrent edit. It is upgraded on disk only when
 * `tyr init` scaffolds (scaffold() migrates, merges and rewrites it).
 */
export async function loadConfig(root: string): Promise<LoadResult<TyrConfig>> {
    const paths = resolveTyrPaths(root);
    const { document: _document, ...result } = await loadDocument(paths.configFile, migrateConfig, validateConfig);
    if (result.value !== null) {
        result.value.project.root = path.resolve(paths.root, result.value.project.root);
    }
    return result;
}

/**
 * Load `.tyr/state/state.json`: parse, migrate, validate.
 *
 * Write-back policy: unlike tyr.json, state.json is Tyr-owned, untracked
 * runtime data, so a state that needed migration is written back here
 * (best-effort, `updatedAt` untouched) and later reads skip the upgrade.
 * What is written is the migrated document, not the default-filled value,
 * so validation defaults never get baked in silently.
 */
export async function loadState(root: string): Promise<LoadResult<TyrState>> {
    const paths = resolveTyrPaths(root);
    const { document, ...result } = await loadDocument(paths.stateFile, migrateState, validateState);
    if (document !== null && result.migrated.length > 0) {
        await writeFileAtomic(paths.stateFile, toJsonDocument(document)).catch(() => undefined);
    }
    return result;
}

/** loadConfig's value: null when tyr.json is missing, malformed, from a newer Tyr, or invalid. */
export async function readConfig(root: string): Promise<TyrConfig | null> {
    return (await loadConfig(root)).value;
}

/** loadState's value: null when state.json is missing, malformed, from a newer Tyr, or invalid. */
export async function readState(root: string): Promise<TyrState | null> {
    return (await loadState(root)).value;
}

export async function writeState(root: string, state: TyrState): Promise<void> {
    const paths = resolveTyrPaths(root);
    await fs.mkdir(paths.stateDir, { recursive: true });
    // The writer never has to remember to stamp this.
    const next: TyrState = { ...state, updatedAt: new Date().toISOString() };
    await writeFileAtomic(paths.stateFile, toJsonDocument(next));
}

/**
 * Append a record to `.tyr/logs/tyr.log` if `level` passes the `--log-level`
 * / `TYR_LOG_LEVEL` threshold, rotating the file once it reaches its size
 * cap. Best-effort: never throws. See log.ts.
 */
export async function appendLog(root: string, level: LogLevel, message: string): Promise<void> {
    await writeLog(resolveTyrPaths(root).logFile, level, message);
}
