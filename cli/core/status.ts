// Status collector for `tyr status` (PLANNING.md 2.12): everything Tyr knows
// about a project, gathered into one JSON-serializable StatusReport.
//
// Sources, all read-only:
//   .tyr/tyr.json            project profile           loadConfig   (scaffold.ts)
//   .tyr/state/state.json    lifecycle, run counters   loadState    (scaffold.ts)
//   .tyr/state/daemon.pid    background process        readDaemonStatus (daemon.ts)
//   .tyr/reports/            recent reports            listReports  (reports.ts)
//   .tyr/state/findings.json open findings             readFindingsState (engine/review.ts)
//   .tyr/state/engine.json   check results, problems   readEngineState (engine/repo-state.ts)
//   .tyr/state/scan.json     indexed file list         loadScanManifest (scan-diff.ts)
//   git HEAD + a fresh scan  drift since the index
//
// "Currently open" findings come from findings.json, the engine's record of
// its last review pass (the same list regressions are computed against).
// Reports are only written when findings change, so the newest report can be
// stale; it is used only as a fallback when findings.json does not exist.
// The user's `severity.threshold` is applied, so status shows what reports
// show.
//
// collectStatus never throws. A missing `.tyr/` or tyr.json yields
// `{ initialized: false }`; every other problem (corrupt JSON, a newer
// schema, a git timeout, a slow scan) becomes an entry in `warnings` and a
// null field. Like the other core modules it never prints: the renderer and
// `--json` output live in cli/commands/status.ts.
//
// The report is printed verbatim by `tyr status --json`, so field names are a
// public contract: add fields freely, but do not rename or remove them
// without bumping STATUS_REPORT_VERSION.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readDaemonStatus, type DaemonStatus } from "./daemon.js";
import { scanProject } from "./discovery.js";
import { getCurrentBranch, getHeadCommit } from "./git.js";
import { runGit } from "./git-exec.js";
import { loadUserIgnorePatterns } from "./ignore.js";
import { FINDING_SEVERITIES, listReports, readReport, type Finding, type FindingSeverity, type ReportSummary } from "./reports.js";
import { loadConfig, loadState, readJsonFile, resolveTyrPaths } from "./scaffold.js";
import { loadScanManifest, toManifestPath } from "./scan-diff.js";
import { resolveSettings } from "./settings.js";
import type { Severity } from "./settings-types.js";
import type { CommandKind, TyrConfig, TyrState, WorkspaceTool } from "./types.js";
import { compareFindings, SEVERITY_RANK, type EngineFinding } from "../engine/findings.js";
import { CHECK_KINDS, type CheckKind, type CheckOutcome, type CheckReason } from "../engine/model.js";
import { engineStateFile, readEngineState } from "../engine/repo-state.js";
import { findingsStateFile, readFindingsState } from "../engine/review.js";

/* -------------------------------------------------------------------------
 * Report shape (the `tyr status --json` contract)
 * ---------------------------------------------------------------------- */

/** Bumped only on a breaking change to StatusReport (a rename or removal). */
export const STATUS_REPORT_VERSION = 1;

/** Default cap on `findings.items`. */
export const DEFAULT_MAX_FINDINGS = 20;
/** Default number of entries in `lastRun.recentReports`. */
export const DEFAULT_RECENT_REPORTS = 5;
/** Default time budget for the drift file scan before giving up on it. */
export const DEFAULT_SCAN_TIMEOUT_MS = 10_000;

/** Either shape; switch on `initialized`. */
export type StatusReport = UninitializedStatus | InitializedStatus;

/** No `.tyr/` directory, or `.tyr/` without a tyr.json. */
export interface UninitializedStatus {
    statusVersion: typeof STATUS_REPORT_VERSION;
    initialized: false;
    /** Absolute project root that was inspected. */
    root: string;
    /** ISO-8601 time the status was collected. */
    collectedAt: string;
    /** Why the project counts as not initialized. */
    reason: "no-tyr-dir" | "no-config";
    /** Command to run next. */
    suggestion: "tyr init";
}

export interface InitializedStatus {
    statusVersion: typeof STATUS_REPORT_VERSION;
    initialized: true;
    /** Absolute project root (the directory containing `.tyr/`). */
    root: string;
    /** ISO-8601 time the status was collected. */
    collectedAt: string;
    /** Project profile from tyr.json; null when tyr.json is corrupt or invalid (see `warnings`). */
    project: StatusProject | null;
    /** state.json; null when it is missing, corrupt or invalid (see `warnings`). */
    state: StatusState | null;
    daemon: StatusDaemon;
    lastRun: StatusLastRun;
    findings: StatusFindings;
    /** Summary of `.tyr/state/engine.json`; null when the engine never wrote one. */
    engine: StatusEngine | null;
    drift: StatusDrift;
    /** Everything that went wrong while collecting, in collection order. Empty when all is well. */
    warnings: StatusWarning[];
}

/** Which part of the collection a warning came from. */
export type StatusWarningSource = "config" | "state" | "daemon" | "reports" | "findings" | "engine" | "drift" | "settings";

export interface StatusWarning {
    source: StatusWarningSource;
    /** One human-readable line, ready to print. */
    message: string;
}

/** One toolchain slot from tyr.json `commands`. */
export interface StatusCommand {
    /** Full shell command, e.g. "npm run test". */
    command: string;
    /** Tool display name, e.g. "Jest". */
    tool: string;
    /** "user" when typed by the user, otherwise "detected". */
    source: "detected" | "user";
}

export interface StatusProject {
    name: string;
    /** Absolute project root as recorded in tyr.json. */
    root: string;
    primaryLanguage: string | null;
    /** Sorted by file count, descending; `percentage` is 0-100. */
    languages: { name: string; fileCount: number; percentage: number }[];
    frameworks: string[];
    packageManager: string | null;
    /** Monorepo layout, or null for a single package. */
    workspace: { tool: WorkspaceTool; packages: string[] } | null;
    /** Every command slot, null where nothing is configured. */
    commands: Record<CommandKind, StatusCommand | null>;
    git: {
        isRepo: boolean;
        /** Branch at init time (or a detached-HEAD label). */
        branch: string | null;
        remote: string | null;
    };
    docs: { readme: string | null; claudeMd: string | null };
    /** Tyr version that wrote tyr.json. */
    tyrVersion: string;
    /** tyr.json schema version after migration. */
    configVersion: number;
    /** ISO-8601 time of `tyr init`. */
    initializedAt: string;
    /** Migration steps applied while reading (tyr.json on disk is older); empty when current. */
    migrated: string[];
}

export interface StatusState {
    /** Lifecycle as recorded in state.json. Use `daemon.running` for liveness. */
    status: TyrState["status"];
    createdAt: string;
    updatedAt: string;
    runCount: number;
    lastRunAt: string | null;
    /** Pid recorded in state.json (informational; daemon.pid is authoritative). */
    pid: number | null;
    startedAt: string | null;
}

export interface StatusDaemon {
    running: boolean;
    pid: number | null;
    /** ISO-8601 start time from the pid file, when known. */
    startedAt: string | null;
    /** Milliseconds since `startedAt`; null unless running with a known start time. */
    uptimeMs: number | null;
    /** A pid file exists but its process is gone (crash, reboot, hard kill). */
    stale: boolean;
}

export interface StatusLastRun {
    /** state.json `lastRunAt`. */
    lastRunAt: string | null;
    /** state.json `runCount`; 0 when state is unavailable. */
    runCount: number;
    /** Newest-first report metadata from `.tyr/reports/`, capped (see `reportCount`). */
    recentReports: StatusReportSummary[];
    /** Total reports on disk. */
    reportCount: number;
}

export interface StatusReportSummary {
    /** Report id (file stem); pass to readReport(). */
    id: string;
    kind: string;
    title: string;
    createdAt: string;
    summary: string;
    findingCounts: Record<FindingSeverity, number>;
    /** Absolute path of the report's JSON file (the .md sibling sits next to it). */
    jsonFile: string;
}

/** One open finding. The reports.ts Finding plus engine metadata when known. */
export interface StatusFinding extends Finding {
    /** Which detector produced it: "check", "diff" or "llm". Absent for report-only findings. */
    source?: string;
    /** For check findings, which check. */
    checkKind?: string;
    /** True when this finding is a regression (passed before, fails now). */
    regression?: boolean;
    /** Stable identity across passes. */
    fingerprint?: string;
}

export interface StatusFindings {
    /**
     * Where the list came from:
     * - "engine": `.tyr/state/findings.json`, the engine's last review pass (authoritative)
     * - "report": the newest review report, used when findings.json does not exist
     * - "none": neither exists yet; everything below is empty
     */
    source: "engine" | "report" | "none";
    /** When that pass / report was produced. */
    updatedAt: string | null;
    /** Report written for that pass, when there is one. */
    reportId: string | null;
    /** Severity threshold applied (settings `severity.threshold`); null when the source was already filtered. */
    threshold: Severity | null;
    /** Findings at or above the threshold. */
    total: number;
    /** Counts of those findings, keyed by every FINDING_SEVERITIES entry. */
    counts: Record<FindingSeverity, number>;
    /** How many of them are regressions. */
    regressions: number;
    /** Most severe first, capped at `maxFindings`; `total` says how many exist. */
    items: StatusFinding[];
    /** True when `items` was cut short. */
    truncated: boolean;
}

/** Last and last-good run of one check, without output. */
export interface StatusCheck {
    kind: CheckKind;
    command: string;
    outcome: CheckOutcome;
    exitCode: number | null;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    /** Why the run started; null when the record does not say. */
    trigger: CheckReason | null;
    headCommit: string | null;
    /** finishedAt of the most recent passing run; null when it never passed. */
    lastPassedAt: string | null;
}

/** An open check-level problem: a check failing right now. */
export interface StatusProblem {
    /** e.g. "check:test". */
    key: string;
    kind: CheckKind;
    title: string;
    /** Short excerpt of the failing output. */
    detail: string;
    firstSeenAt: string;
    lastSeenAt: string;
    /** True when the check passed on an earlier run. */
    regression: boolean;
}

export interface StatusEngine {
    /** Last time the engine updated engine.json. */
    updatedAt: string;
    /** True when no check is currently failing. */
    healthy: boolean;
    /** Most recent run per check, in CHECK_KINDS order; checks that never ran are omitted. */
    checks: StatusCheck[];
    /** Open problems, oldest first. */
    problems: StatusProblem[];
    /** Uncommitted changes as of the engine's last pass; null when not snapshotted. */
    workingTree: {
        headCommit: string | null;
        branch: string | null;
        filesChanged: number;
        additions: number;
        deletions: number;
        untracked: number;
        takenAt: string;
    } | null;
}

export interface StatusDrift {
    /** Whether the project is a git work tree right now. */
    isRepo: boolean;
    /** HEAD recorded at the last index (state.json, else tyr.json); null when unknown or not a repo then. */
    indexedHead: string | null;
    /** HEAD now; null outside a repo, on an unborn branch, or when git failed. */
    currentHead: string | null;
    /** Current branch, or a detached-HEAD label; null outside a repo. */
    currentBranch: string | null;
    /** True/false when both heads are known; null otherwise. */
    headChanged: boolean | null;
    /** Commits on HEAD not on indexedHead; null when not computable (e.g. the indexed commit is gone). */
    commitsSinceIndex: number | null;
    /** When the index was taken (scan manifest, else tyr.json initializedAt). */
    indexedAt: string | null;
    /** File count at the last index (scan manifest, else state.json, else tyr.json). */
    indexedFileCount: number | null;
    /** Files a fresh scan finds now; null when the scan was skipped, timed out or failed. */
    currentFileCount: number | null;
    /** currentFileCount - indexedFileCount; null when either is unknown. */
    fileCountDelta: number | null;
    /** Files present now but not in the scan manifest; null without a manifest or a scan. */
    filesAdded: number | null;
    /** Files in the scan manifest that are gone now; null without a manifest or a scan. */
    filesRemoved: number | null;
}

/* -------------------------------------------------------------------------
 * Options
 * ---------------------------------------------------------------------- */

export interface CollectStatusOptions {
    /** Clock for `collectedAt` and daemon uptime. Default `new Date()`. */
    now?: Date;
    /** Daemon probe (tests). Default readDaemonStatus. */
    daemonStatus?: (root: string) => Promise<DaemonStatus>;
    /** Severity threshold override. Default: the resolved `severity.threshold` setting. */
    threshold?: Severity;
    /** Cap on `findings.items`. Default DEFAULT_MAX_FINDINGS. */
    maxFindings?: number;
    /** Entries in `lastRun.recentReports`. Default DEFAULT_RECENT_REPORTS. */
    recentReports?: number;
    /** Set false to skip the drift file scan (`currentFileCount` is then null). Default true. */
    scanFiles?: boolean;
    /** Time budget for the drift file scan. Default DEFAULT_SCAN_TIMEOUT_MS. */
    scanTimeoutMs?: number;
}

/* -------------------------------------------------------------------------
 * Collection
 * ---------------------------------------------------------------------- */

/**
 * Gather the status of the project at `root`. Never throws: problems are
 * reported in `warnings` (or as an UninitializedStatus).
 */
export async function collectStatus(root: string, options: CollectStatusOptions = {}): Promise<StatusReport> {
    const paths = resolveTyrPaths(root);
    const now = options.now ?? new Date();
    const collectedAt = now.toISOString();

    const initialized = await initializationOf(paths.tyrDir, paths.configFile);
    if (initialized !== "ok") {
        return {
            statusVersion: STATUS_REPORT_VERSION,
            initialized: false,
            root: paths.root,
            collectedAt,
            reason: initialized,
            suggestion: "tyr init",
        };
    }

    const warnings: StatusWarning[] = [];
    const warn = (source: StatusWarningSource, message: string): void => {
        warnings.push({ source, message });
    };

    // Independent reads run together; each step is guarded so one failure
    // only costs its own section.
    const [configLoad, stateLoad, daemonRaw] = await Promise.all([
        guard(() => loadConfig(paths.root), null),
        guard(() => loadState(paths.root), null),
        guard(() => (options.daemonStatus ?? readDaemonStatus)(paths.root), null),
    ]);

    // tyr.json
    let config: TyrConfig | null = null;
    if (configLoad === null) {
        warn("config", "tyr.json could not be read");
    } else {
        config = configLoad.value;
        for (const error of configLoad.errors) warn("config", `tyr.json: ${stripPrefix(error, "tyr.json")}`);
        for (const warning of configLoad.warnings) warn("config", `tyr.json: ${stripPrefix(warning, "tyr.json")}`);
        if (config === null && configLoad.errors.length === 0) warn("config", "tyr.json is unusable");
    }

    // state.json
    let state: TyrState | null = null;
    if (stateLoad === null) {
        warn("state", "state.json could not be read");
    } else {
        state = stateLoad.value;
        if (stateLoad.missing) warn("state", "state.json is missing; run `tyr init --force` to recreate it");
        for (const error of stateLoad.errors) warn("state", `state.json: ${stripPrefix(error, "state.json")}`);
        for (const warning of stateLoad.warnings) warn("state", `state.json: ${stripPrefix(warning, "state.json")}`);
    }

    // Daemon
    const daemon = daemonOf(daemonRaw, now);
    if (daemonRaw === null) warn("daemon", "could not check the background process");
    else if (daemon.stale) warn("daemon", `stale PID file${daemon.pid === null ? "" : ` (pid ${daemon.pid})`}: the background process is not running; \`tyr start\` replaces it`);
    if (state?.status === "running" && daemonRaw !== null && !daemon.running) {
        warn("daemon", "state.json says running, but no background process is alive");
    }

    const [lastRun, findings, engine, drift] = await Promise.all([
        collectLastRun(paths.root, state, options.recentReports ?? DEFAULT_RECENT_REPORTS, warn),
        collectFindings(paths.root, options, warn),
        collectEngine(paths.root, warn),
        collectDrift(paths.root, config, state, options, warn),
    ]);

    return {
        statusVersion: STATUS_REPORT_VERSION,
        initialized: true,
        root: paths.root,
        collectedAt,
        project: config === null ? null : projectOf(config, configLoad?.migrated ?? []),
        state: state === null ? null : stateOf(state),
        daemon,
        lastRun,
        findings,
        engine,
        drift,
        warnings,
    };
}

/** "ok" when `.tyr/` is a directory holding a tyr.json file (valid or not). */
async function initializationOf(tyrDir: string, configFile: string): Promise<"ok" | "no-tyr-dir" | "no-config"> {
    const dir = await fs.stat(tyrDir).catch(() => null);
    if (dir === null || !dir.isDirectory()) return "no-tyr-dir";
    // Any entry counts, even an unreadable one: a corrupt tyr.json is an
    // initialized project with a problem, not a fresh one.
    const file = await fs.lstat(configFile).catch(() => null);
    return file === null ? "no-config" : "ok";
}

/** Run `fn`, mapping any throw to `fallback`. */
async function guard<T, F>(fn: () => Promise<T>, fallback: F): Promise<T | F> {
    try {
        return await fn();
    } catch {
        return fallback;
    }
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** LoadResult errors sometimes already name the file; avoid "tyr.json: tyr.json: ...". */
function stripPrefix(message: string, file: string): string {
    return message.startsWith(`${file}: `) ? message.slice(file.length + 2) : message;
}

/* -------------------------------------------------------------------------
 * Sections
 * ---------------------------------------------------------------------- */

function projectOf(config: TyrConfig, migrated: string[]): StatusProject {
    const commands = {} as Record<CommandKind, StatusCommand | null>;
    for (const kind of CHECK_KINDS) {
        const entry = config.commands[kind];
        commands[kind] =
            entry === null || entry === undefined
                ? null
                : { command: entry.command, tool: entry.tool, source: entry.source === "user" ? "user" : "detected" };
    }
    return {
        name: config.project.name,
        root: config.project.root,
        primaryLanguage: config.project.primaryLanguage,
        languages: config.project.languages.map((language) => ({
            name: language.name,
            fileCount: language.fileCount,
            percentage: language.percentage,
        })),
        frameworks: [...config.project.frameworks],
        packageManager: config.project.packageManager,
        workspace: config.project.workspace
            ? { tool: config.project.workspace.tool, packages: [...config.project.workspace.packages] }
            : null,
        commands,
        git: { isRepo: config.git.isRepo, branch: config.git.branch, remote: config.git.remote },
        docs: { readme: config.docs.readme, claudeMd: config.docs.claudeMd },
        tyrVersion: config.tyrVersion,
        configVersion: config.version,
        initializedAt: config.initializedAt,
        migrated: [...migrated],
    };
}

function stateOf(state: TyrState): StatusState {
    return {
        status: state.status,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
        runCount: state.runCount,
        lastRunAt: state.lastRunAt,
        pid: state.pid ?? null,
        startedAt: state.startedAt ?? null,
    };
}

function daemonOf(status: DaemonStatus | null, now: Date): StatusDaemon {
    if (status === null) return { running: false, pid: null, startedAt: null, uptimeMs: null, stale: false };
    const started = status.startedAt === null ? NaN : Date.parse(status.startedAt);
    const uptimeMs = status.running && !Number.isNaN(started) ? Math.max(0, now.getTime() - started) : null;
    return { running: status.running, pid: status.pid, startedAt: status.startedAt, uptimeMs, stale: status.stale };
}

type Warn = (source: StatusWarningSource, message: string) => void;

async function collectLastRun(root: string, state: TyrState | null, limit: number, warn: Warn): Promise<StatusLastRun> {
    let reports: ReportSummary[] = [];
    try {
        reports = await listReports(root);
    } catch (error) {
        warn("reports", `could not list reports: ${describe(error)}`);
    }
    return {
        lastRunAt: state?.lastRunAt ?? null,
        runCount: state?.runCount ?? 0,
        recentReports: reports.slice(0, Math.max(0, limit)).map((report) => ({
            id: report.id,
            kind: report.kind,
            title: report.title,
            createdAt: report.createdAt,
            summary: report.summary,
            findingCounts: { ...report.findingCounts },
            jsonFile: report.jsonFile,
        })),
        reportCount: reports.length,
    };
}

function emptyCounts(): Record<FindingSeverity, number> {
    return Object.fromEntries(FINDING_SEVERITIES.map((severity) => [severity, 0])) as Record<FindingSeverity, number>;
}

/** Copy only known fields, so stray keys in a hand-edited file never reach the JSON output. */
function toStatusFinding(finding: Finding & Partial<EngineFinding>): StatusFinding {
    const out: StatusFinding = { severity: finding.severity, title: finding.title };
    if (typeof finding.detail === "string") out.detail = finding.detail;
    if (typeof finding.file === "string") out.file = finding.file;
    if (typeof finding.line === "number") out.line = finding.line;
    if (typeof finding.rule === "string") out.rule = finding.rule;
    if (typeof finding.source === "string") out.source = finding.source;
    if (typeof finding.checkKind === "string") out.checkKind = finding.checkKind;
    if (finding.regression === true) out.regression = true;
    if (typeof finding.fingerprint === "string") out.fingerprint = finding.fingerprint;
    return out;
}

function isFinding(value: unknown): value is Finding {
    if (value === null || typeof value !== "object") return false;
    const { severity, title } = value as Record<string, unknown>;
    return FINDING_SEVERITIES.includes(severity as FindingSeverity) && typeof title === "string";
}

async function collectFindings(root: string, options: CollectStatusOptions, warn: Warn): Promise<StatusFindings> {
    const max = Math.max(0, options.maxFindings ?? DEFAULT_MAX_FINDINGS);
    const summarize = (
        source: StatusFindings["source"],
        updatedAt: string | null,
        reportId: string | null,
        threshold: Severity | null,
        findings: StatusFinding[],
    ): StatusFindings => {
        const sorted = [...findings].sort(compareFindings);
        const counts = emptyCounts();
        for (const finding of sorted) counts[finding.severity] += 1;
        return {
            source,
            updatedAt,
            reportId,
            threshold,
            total: sorted.length,
            counts,
            regressions: sorted.filter((finding) => finding.regression === true).length,
            items: sorted.slice(0, max),
            truncated: sorted.length > max,
        };
    };

    // Authoritative: the engine's last pass, before its threshold.
    const engineFindings = await guard(() => readFindingsState(root), null);
    if (engineFindings !== null) {
        const threshold = options.threshold ?? (await thresholdSetting(root, warn));
        const min = SEVERITY_RANK[threshold];
        const findings = engineFindings.findings
            .filter(isFinding)
            .filter((finding) => SEVERITY_RANK[finding.severity] >= min)
            .map(toStatusFinding);
        const updatedAt = typeof engineFindings.updatedAt === "string" ? engineFindings.updatedAt : null;
        const reportId = typeof engineFindings.reportId === "string" ? engineFindings.reportId : null;
        return summarize("engine", updatedAt, reportId, threshold, findings);
    }
    if (await exists(findingsStateFile(root))) {
        warn("findings", "findings.json is unreadable or from another version; showing the newest review report instead");
    }

    // Fallback: the newest review report. Already threshold-filtered when written.
    try {
        const [latest] = await listReports(root, { kind: "review", limit: 1 });
        if (latest !== undefined) {
            const report = await readReport(root, latest.id);
            if (report !== null) {
                return summarize("report", report.createdAt || null, report.id, null, report.findings.map(toStatusFinding));
            }
            warn("findings", `review report ${latest.id} could not be read`);
        }
    } catch (error) {
        warn("findings", `could not read review reports: ${describe(error)}`);
    }
    return summarize("none", null, null, null, []);
}

async function thresholdSetting(root: string, warn: Warn): Promise<Severity> {
    try {
        const resolved = await resolveSettings({ root });
        return resolved.settings.severity.threshold;
    } catch (error) {
        warn("settings", `could not resolve settings, showing every finding: ${describe(error)}`);
        return "info";
    }
}

async function exists(file: string): Promise<boolean> {
    return fs.access(file).then(
        () => true,
        () => false,
    );
}

async function collectEngine(root: string, warn: Warn): Promise<StatusEngine | null> {
    const file = engineStateFile(root);
    const raw = await guard(() => readJsonFile(file), null);
    if (raw === null || raw.kind === "missing") return null;
    if (raw.kind === "invalid") {
        warn("engine", `engine.json: ${raw.error}`);
        return null;
    }
    const engine = await guard(() => readEngineState(root), null);
    // readEngineState maps a file it cannot use to the empty state, whose
    // updatedAt is the epoch; a real file always carries a later stamp.
    if (engine === null || engine.updatedAt === new Date(0).toISOString()) {
        warn("engine", "engine.json is from another version or malformed; ignoring it");
        return null;
    }

    const checks: StatusCheck[] = [];
    for (const kind of CHECK_KINDS) {
        const entry = engine.checks[kind];
        const last = entry?.last;
        if (last === null || last === undefined) continue;
        checks.push({
            kind,
            command: last.command,
            outcome: last.outcome,
            exitCode: last.exitCode ?? null,
            startedAt: last.startedAt,
            finishedAt: last.finishedAt,
            durationMs: last.durationMs,
            trigger: last.trigger?.reason ?? null,
            headCommit: last.headCommit ?? null,
            lastPassedAt: entry?.lastGood?.finishedAt ?? null,
        });
    }

    const problems: StatusProblem[] = [...engine.problems]
        .sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt))
        .map((problem) => ({
            key: problem.key,
            kind: problem.kind,
            title: problem.title,
            detail: problem.detail,
            firstSeenAt: problem.firstSeenAt,
            lastSeenAt: problem.lastSeenAt,
            regression: problem.regression === true,
        }));

    const tree = engine.workingTree;
    return {
        updatedAt: engine.updatedAt,
        healthy: problems.length === 0,
        checks,
        problems,
        workingTree:
            tree === null
                ? null
                : {
                      headCommit: tree.headCommit ?? null,
                      branch: tree.branch ?? null,
                      filesChanged: tree.totals?.files ?? 0,
                      additions: tree.totals?.additions ?? 0,
                      deletions: tree.totals?.deletions ?? 0,
                      untracked: tree.untracked ?? 0,
                      takenAt: tree.takenAt,
                  },
    };
}

/* -------------------------------------------------------------------------
 * Drift
 * ---------------------------------------------------------------------- */

/** Sentinel withTimeout resolves to when time runs out. */
const TIMED_OUT = Symbol("timed out");

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
        // A slow scan must not keep the process alive after status returns.
        timer.unref?.();
    });
    try {
        return await Promise.race([work, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

const COMMIT_HASH = /^[0-9a-f]{4,64}$/i;

async function collectDrift(
    root: string,
    config: TyrConfig | null,
    state: TyrState | null,
    options: CollectStatusOptions,
    warn: Warn,
): Promise<StatusDrift> {
    const manifest = await guard(() => loadScanManifest(root), null);

    const indexedHead = state?.lastIndexedCommit ?? config?.git.headCommit ?? null;
    const indexedAt = manifest?.scannedAt || config?.initializedAt || null;
    const indexedFileCount = manifest?.fileCount ?? state?.lastScanFileCount ?? config?.project.fileCount ?? null;

    // Every git call goes through runGit: time-limited and total.
    const inside = await guard(() => runGit(root, ["rev-parse", "--is-inside-work-tree"]), null);
    const isRepo = inside !== null && inside.ok && inside.stdout.trim() === "true";
    if (inside?.timedOut) warn("drift", "git timed out; HEAD drift unknown");

    let currentHead: string | null = null;
    let currentBranch: string | null = null;
    let commitsSinceIndex: number | null = null;
    if (isRepo) {
        const [head, branch] = await Promise.all([
            guard(() => getHeadCommit(root), null),
            guard(() => getCurrentBranch(root), null),
        ]);
        currentHead = head?.hash ?? null;
        currentBranch = branch?.branch ?? null;
        // indexedHead comes from a hand-editable file: only pass it to git when
        // it looks like a commit hash, so it can never be read as an option.
        if (indexedHead !== null && currentHead !== null && COMMIT_HASH.test(indexedHead)) {
            if (indexedHead === currentHead) {
                commitsSinceIndex = 0;
            } else {
                const count = await guard(() => runGit(root, ["rev-list", "--count", `${indexedHead}..${currentHead}`]), null);
                const parsed = count !== null && count.ok ? Number.parseInt(count.stdout.trim(), 10) : NaN;
                commitsSinceIndex = Number.isNaN(parsed) ? null : parsed;
            }
        }
    }
    const headChanged = indexedHead !== null && currentHead !== null ? indexedHead !== currentHead : null;

    // File count: the same walk and ignore rules init uses, bounded in time.
    let currentFileCount: number | null = null;
    let filesAdded: number | null = null;
    let filesRemoved: number | null = null;
    if (options.scanFiles !== false) {
        const timeoutMs = options.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;
        const scan = (async () => {
            const ignore = await loadUserIgnorePatterns(root);
            return scanProject(root, { extraIgnore: ignore.patterns });
        })();
        // The race may abandon the scan; keep its eventual rejection handled.
        scan.catch(() => undefined);
        try {
            const result = await withTimeout(scan, timeoutMs);
            if (result === TIMED_OUT) {
                warn("drift", `file scan took longer than ${Math.round(timeoutMs / 1000)}s; current file count unknown`);
            } else {
                currentFileCount = result.files.length;
                if (manifest !== null) {
                    const absRoot = path.resolve(root);
                    const now = new Set(result.files.map((file) => toManifestPath(absRoot, file)));
                    const before = Object.keys(manifest.files);
                    const beforeSet = new Set(before);
                    filesAdded = [...now].filter((file) => !beforeSet.has(file)).length;
                    filesRemoved = before.filter((file) => !now.has(file)).length;
                }
            }
        } catch (error) {
            warn("drift", `file scan failed: ${describe(error)}`);
        }
    }

    return {
        isRepo,
        indexedHead,
        currentHead,
        currentBranch,
        headChanged,
        commitsSinceIndex,
        indexedAt,
        indexedFileCount,
        currentFileCount,
        fileCountDelta: currentFileCount !== null && indexedFileCount !== null ? currentFileCount - indexedFileCount : null,
        filesAdded,
        filesRemoved,
    };
}
