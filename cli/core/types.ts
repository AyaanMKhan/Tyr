// Shared contracts for `tyr init`.
//
// Every detection module produces one of the structures below, and the
// assembled result is what gets serialized into `.tyr/tyr.json`.
// Treat these as a fixed API: the init command wires the modules together
// purely through these shapes.

/* -------------------------------------------------------------------------
 * Discovery — where the project lives and what is in it
 * ---------------------------------------------------------------------- */

export interface DiscoveryResult {
    /** Absolute path to the project root. */
    root: string;
    /** True when `.tyr/` already exists at the root. */
    alreadyInitialized: boolean;
    /** Absolute paths of every scanned (non-ignored) file. */
    files: string[];
    /** Convenience: `files.length`. */
    fileCount: number;
    /** Directories skipped during the walk, relative to root. */
    skippedDirs: string[];
    /**
     * The ignore lists actually used for this scan. Populated by the init
     * command rather than the scanner, so they can be recorded in tyr.json
     * without the scaffolder having to import the scanner's constants.
     */
    ignoredDirs?: string[];
    ignoredExtensions?: string[];
    ignoredFiles?: string[];
    /**
     * User patterns from tyr.json's `scan.extraIgnore`, carried through so a
     * re-init (`--force`) writes them back instead of dropping them. Patterns
     * from `.tyrignore` are not included; that file is its own source of truth.
     */
    extraIgnore?: string[];
}

/* -------------------------------------------------------------------------
 * Git
 * ---------------------------------------------------------------------- */

export interface GitCommit {
    hash: string;
    shortHash: string;
    subject: string;
    author: string;
    /** ISO-8601 timestamp. */
    date: string;
}

export interface GitStatus {
    /** True when there is nothing staged, modified, or untracked. */
    clean: boolean;
    staged: string[];
    modified: string[];
    untracked: string[];
    /** Files with merge conflicts. */
    conflicted: string[];
    /** Commits ahead of / behind the upstream branch, null when no upstream. */
    ahead: number | null;
    behind: number | null;
}

export interface GitRemote {
    name: string;
    fetchUrl: string | null;
    pushUrl: string | null;
}

export interface GitInfo {
    isRepo: boolean;
    /**
     * Branch name. On a detached HEAD this carries a best-effort label (tag
     * name or short hash) rather than null, so check `detached` — never
     * `branch === null` — to test for detached state. Null only when nothing
     * resolves at all.
     */
    branch: string | null;
    /** True when HEAD is detached. */
    detached: boolean;
    /** Most recent commit, or null on a repo with no commits. */
    headCommit: GitCommit | null;
    status: GitStatus | null;
    remotes: GitRemote[];
    /** Name of the remote tracking the current branch (usually "origin"). */
    defaultRemote: string | null;
}

/* -------------------------------------------------------------------------
 * Project identification
 * ---------------------------------------------------------------------- */

export interface LanguageStat {
    /** Display name, e.g. "TypeScript". */
    name: string;
    fileCount: number;
    /** Share of all classified files, 0-100, rounded to one decimal. */
    percentage: number;
}

export interface PackageManagerInfo {
    /** e.g. "npm", "pnpm", "yarn", "bun", "poetry", "uv", "pip", "cargo", "go". */
    name: string;
    /** Lockfile or manifest that proved it, relative to root. */
    evidence: string;
}

/**
 * A command Tyr can run on the project. `command` is the full shell command;
 * `tool` names the underlying tool for display ("Jest", "ESLint", "tsc").
 */
export interface ProjectCommand {
    tool: string;
    command: string;
    /** File that proved it, relative to root. */
    evidence: string;
}

/** The command slots a profile fills, in display order. */
export type CommandKind = "build" | "test" | "lint" | "format" | "typecheck";

/**
 * Whether a detected command looks runnable, judged without actually running
 * it (see verify-commands.ts).
 *
 * - `ok`      the executable resolves and, where probed, answers `--version`
 * - `missing` the executable or npm script does not exist
 * - `failed`  the executable exists but the probe exited non-zero or timed out
 * - `skipped` the command could not be checked (shell syntax, unknown shape)
 */
export interface CommandProbe {
    status: "ok" | "missing" | "failed" | "skipped";
    /** One human-readable line explaining the status. */
    detail: string;
}

/** One probe per command slot; null where the profile had no command. */
export type CommandVerification = Record<CommandKind, CommandProbe | null>;

export interface ProjectProfile {
    /**
     * Name declared by the root manifest (package.json, pyproject.toml or
     * Cargo.toml), or null when none declares a usable one. Consumers fall
     * back to the root directory name.
     */
    name: string | null;
    /** Manifest the name came from, relative to root; null when `name` is. */
    nameSource: string | null;
    /** Sorted by fileCount, descending. */
    languages: LanguageStat[];
    /**
     * The dominant *code* language, or null when nothing was classified.
     * Markdown/JSON/YAML still appear in `languages` but are never chosen
     * here — a repo of 3 .ts files and 40 .md files is a TypeScript project.
     */
    primaryLanguage: string | null;
    /** e.g. ["React", "Next.js", "Express"]. Empty when none detected. */
    frameworks: string[];
    packageManager: PackageManagerInfo | null;
    build: ProjectCommand | null;
    test: ProjectCommand | null;
    lint: ProjectCommand | null;
    format: ProjectCommand | null;
    typecheck: ProjectCommand | null;
    /** Path to README, relative to root, or null. */
    readme: string | null;
    /** Path to CLAUDE.md, relative to root, or null. */
    claudeMd: string | null;
}

/* -------------------------------------------------------------------------
 * The assembled snapshot + on-disk config
 * ---------------------------------------------------------------------- */

/** Everything the detection phase learned, passed to the scaffolder. */
export interface InitSnapshot {
    discovery: DiscoveryResult;
    git: GitInfo;
    project: ProjectProfile;
}

/**
 * A detected command as recorded in tyr.json. Same fields as ProjectCommand,
 * spelled out separately because this one is an on-disk format: keep it
 * stable even if the in-memory detection result grows.
 */
export interface ConfigCommand {
    /** Full shell command, e.g. "npm run test". */
    command: string;
    /** Underlying tool for display, e.g. "Jest". */
    tool: string;
    /** File that proved it, relative to root. */
    evidence: string;
}

/** Shape of `.tyr/tyr.json`. */
export interface TyrConfig {
    /** Schema version of this config file. */
    version: number;
    /** Tyr version that wrote it. */
    tyrVersion: string;
    /** ISO-8601 timestamp of `tyr init`. */
    initializedAt: string;
    project: {
        name: string;
        root: string;
        primaryLanguage: string | null;
        languages: LanguageStat[];
        frameworks: string[];
        packageManager: string | null;
        fileCount: number;
    };
    commands: {
        build: ConfigCommand | null;
        test: ConfigCommand | null;
        lint: ConfigCommand | null;
        format: ConfigCommand | null;
        typecheck: ConfigCommand | null;
    };
    git: {
        isRepo: boolean;
        branch: string | null;
        remote: string | null;
        headCommit: string | null;
    };
    docs: {
        readme: string | null;
        claudeMd: string | null;
    };
    scan: {
        ignoredDirs: string[];
        ignoredExtensions: string[];
        /** Exact file names skipped. Optional: absent in older tyr.json files. */
        ignoredFiles?: string[];
        /**
         * Extra gitignore-style patterns applied on top of the built-in rules
         * (syntax documented in cli/core/ignore.ts). Optional so configs
         * written before this field existed remain valid.
         */
        extraIgnore?: string[];
    };
}

/** Shape of `.tyr/state/state.json`. */
export interface TyrState {
    version: number;
    /** Lifecycle of the project as Tyr sees it. */
    status: "initialized" | "running" | "stopped" | "error";
    createdAt: string;
    updatedAt: string;
    /** Git commit Tyr last indexed, for change detection. */
    lastIndexedCommit: string | null;
    /** File count at last scan. */
    lastScanFileCount: number;
    /** Incremented on every Tyr run. */
    runCount: number;
    lastRunAt: string | null;
}

/* -------------------------------------------------------------------------
 * Scan manifest — incremental re-scan / change detection
 * ---------------------------------------------------------------------- */

/**
 * Cheap identity of a file at scan time. Size plus modification time catches
 * every ordinary edit without reading contents; see scan-diff.ts for the
 * cases it can miss.
 */
export interface FileFingerprint {
    size: number;
    /** `fs.Stats.mtimeMs`, kept at full (fractional) precision. */
    mtimeMs: number;
}

/** Shape of `.tyr/state/scan.json`. */
export interface ScanManifest {
    /** Schema version of this manifest. */
    version: number;
    /** ISO-8601 timestamp of the scan that produced it. */
    scannedAt: string;
    /** Convenience: number of entries in `files`. */
    fileCount: number;
    /**
     * Root-relative POSIX paths (always `/`, never `\`) mapped to their
     * fingerprints. Relative so the manifest survives moving the checkout.
     */
    files: Record<string, FileFingerprint>;
}

/** Result of comparing two manifests. Every list is sorted. */
export interface ScanDiff {
    /** In the new scan only. */
    added: string[];
    /** In the previous scan only. */
    removed: string[];
    /** In both, with a different size or mtime. */
    modified: string[];
    /** In both with an identical fingerprint; a count, since nobody lists them. */
    unchanged: number;
}

/* -------------------------------------------------------------------------
 * Reporter — the animated console UI
 * ---------------------------------------------------------------------- */

/** A single in-flight task line, resolved exactly once. */
export interface TaskHandle {
    /** Replace the spinner with `✓ <text>` (defaults to the original label). */
    succeed(text?: string): void;
    /** Replace the spinner with `✗ <text>`. */
    fail(text?: string): void;
    /** Replace the spinner with `- <text>` for a skipped/absent result. */
    skip(text?: string): void;
    /** Update the label while still spinning. */
    update(text: string): void;
}

export interface Reporter {
    /** Section heading, e.g. "Initializing Tyr...". */
    header(text: string): void;
    /** Start a spinning task line. */
    task(label: string): TaskHandle;
    /** Emit a finished `✓ <text>` line without spinning first. */
    success(text: string): void;
    /** Emit an informational line. */
    info(text: string): void;
    /**
     * Emit a dimmed `- <text>` line for a negative-but-normal result, e.g.
     * "Tests: none detected". Keeps absent findings in the same visual column
     * as the `✓` lines instead of breaking the alignment.
     */
    muted(text: string): void;
    /** Emit a warning line. */
    warn(text: string): void;
    /** Emit an error line. */
    error(text: string): void;
    /** Emit a dimmed detail line, shown only with `--verbose`. */
    debug(text: string): void;
    /** Blank spacer line. */
    blank(): void;
    /** Final summary line. */
    done(text: string): void;
    /** Tear down any active spinner; safe to call twice. */
    stop(): void;
}
