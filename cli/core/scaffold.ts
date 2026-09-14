// Scaffolder: turns the detection snapshot into the on-disk `.tyr/` tree and
// owns every read/write of Tyr's own files afterwards.
//
// This module is deliberately silent — it writes files and returns data, never
// prints. The reporter owns all user-facing output. Failures that genuinely
// block initialization throw so the caller can report them; logging failures
// never do.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { InitSnapshot, ProjectCommand, TyrConfig, TyrState } from "./types.js";

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
        logsDir,
        logFile: path.join(logsDir, "tyr.log"),
        reportsDir,
    };
}

/* -------------------------------------------------------------------------
 * Snapshot -> on-disk shapes
 * ---------------------------------------------------------------------- */

/** Config records the command string only; `tool`/`evidence` are display data. */
function commandOf(command: ProjectCommand | null): string | null {
    return command === null ? null : command.command;
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
    };

    return {
        version: 1,
        tyrVersion,
        initializedAt: new Date().toISOString(),
        project: {
            // No package.json name in the snapshot; the root directory name is
            // the right fallback for every ecosystem.
            name: path.basename(root),
            root,
            primaryLanguage: project.primaryLanguage,
            languages: project.languages,
            frameworks: project.frameworks,
            packageManager: project.packageManager === null ? null : project.packageManager.name,
            fileCount: discovery.fileCount,
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
        },
    };
}

export function buildInitialState(snapshot: InitSnapshot): TyrState {
    const now = new Date().toISOString();

    return {
        version: 1,
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
function toJsonDocument(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Write via a temp file in the *same* directory, then rename onto the target.
 * The rename is atomic within a filesystem, so an interrupted init can never
 * leave a half-written tyr.json behind; a temp file in /tmp would risk EXDEV.
 */
async function writeFileAtomic(target: string, contents: string): Promise<void> {
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

/** `[<ISO timestamp>] <LEVEL> <message>` plus a newline. */
function formatLogLine(level: "info" | "warn" | "error", message: string): string {
    return `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}\n`;
}

/** Parse a JSON object, or null when it is missing, unreadable, or malformed. */
async function readJsonObject<T>(file: string): Promise<T | null> {
    try {
        const raw = await fs.readFile(file, "utf8");
        const parsed: unknown = JSON.parse(raw);
        // A hand-edited file can hold `null`, an array, or a bare scalar; none
        // of those are a usable config/state document.
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            return null;
        }
        return parsed as T;
    } catch {
        return null;
    }
}

/* -------------------------------------------------------------------------
 * Scaffold + accessors
 * ---------------------------------------------------------------------- */

export async function scaffold(snapshot: InitSnapshot, tyrVersion: string): Promise<TyrPaths> {
    const paths = resolveTyrPaths(snapshot.discovery.root);

    // `recursive` also makes re-running init over a partial tree harmless.
    await fs.mkdir(paths.tyrDir, { recursive: true });
    await Promise.all([
        fs.mkdir(paths.stateDir, { recursive: true }),
        fs.mkdir(paths.logsDir, { recursive: true }),
        fs.mkdir(paths.reportsDir, { recursive: true }),
    ]);

    await writeFileAtomic(paths.configFile, toJsonDocument(buildConfig(snapshot, tyrVersion)));
    await writeFileAtomic(paths.stateFile, toJsonDocument(buildInitialState(snapshot)));

    await fs.writeFile(path.join(paths.tyrDir, ".gitignore"), TYR_GITIGNORE, "utf8");
    // Git will not track an empty directory; .gitkeep keeps reports/ in the tree.
    await fs.writeFile(path.join(paths.reportsDir, ".gitkeep"), "", "utf8");

    // Append rather than truncate so re-initializing keeps the existing history.
    await fs.appendFile(
        paths.logFile,
        formatLogLine(
            "info",
            `tyr init — scaffolded ${TYR_DIR_NAME}/ with Tyr ${tyrVersion} (${snapshot.discovery.fileCount} files scanned)`,
        ),
        "utf8",
    );

    return paths;
}

export async function readConfig(root: string): Promise<TyrConfig | null> {
    return readJsonObject<TyrConfig>(resolveTyrPaths(root).configFile);
}

export async function readState(root: string): Promise<TyrState | null> {
    return readJsonObject<TyrState>(resolveTyrPaths(root).stateFile);
}

export async function writeState(root: string, state: TyrState): Promise<void> {
    const paths = resolveTyrPaths(root);
    await fs.mkdir(paths.stateDir, { recursive: true });
    // The writer never has to remember to stamp this.
    const next: TyrState = { ...state, updatedAt: new Date().toISOString() };
    await writeFileAtomic(paths.stateFile, toJsonDocument(next));
}

export async function appendLog(
    root: string,
    level: "info" | "warn" | "error",
    message: string,
): Promise<void> {
    try {
        const paths = resolveTyrPaths(root);
        await fs.mkdir(paths.logsDir, { recursive: true });
        await fs.appendFile(paths.logFile, formatLogLine(level, message), "utf8");
    } catch {
        // Logging is best-effort: a failed log write must never break a command.
    }
}
