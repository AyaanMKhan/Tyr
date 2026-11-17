// Shared contract for the engine (cli/engine/ENGINE.md).
//
// Pure types and constants only: no I/O. bus.ts, executor.ts, repo-state.ts,
// scheduler.ts and engine.ts all speak in these shapes, so each can be built
// and tested on its own.

import type { CommandKind } from "../core/types.js";
import type { TyrEvent } from "../core/events.js";
import type { DiffTotals } from "../core/git-diff.js";

/* -------------------------------------------------------------------------
 * Engine events — the bus's normalized view of the journal
 * ---------------------------------------------------------------------- */

/** A check is one of the detected command slots in tyr.json. */
export type CheckKind = CommandKind;

export const CHECK_KINDS: readonly CheckKind[] = ["build", "typecheck", "lint", "test", "format"];

/** Why a check run was started. */
export type CheckReason = "idle" | "commit" | "claude-stop" | "manual" | "startup";

export interface CheckTrigger {
    reason: CheckReason;
    /** Journal id of the event that caused it, when there was one. */
    eventId?: string;
}

/**
 * Every engine event carries the journal event it came from (`raw`), so
 * nothing the journal recorded is lost by normalization.
 */
interface EngineEventBase {
    /** Journal event id. */
    id: string;
    /** ISO-8601 timestamp from the journal. */
    ts: string;
    raw: TyrEvent;
}

/** Files changed on disk (fs.changed). `cause: "git"` when a git operation rewrote them. */
export interface FileChangedEvent extends EngineEventBase {
    type: "file.changed";
    added: string[];
    modified: string[];
    removed: string[];
    total: number;
    cause: "edit" | "git";
}

/** HEAD moved to a new commit (git.head with commitChanged). */
export interface CommitMadeEvent extends EngineEventBase {
    type: "commit.made";
    commit: string | null;
    previousCommit: string | null;
    branch: string | null;
    /** True when the branch changed too (checkout), not just a new commit. */
    branchChanged: boolean;
}

/** Claude Code called a tool (claude.tool_use) or got its result (claude.tool_result). */
export interface ClaudeToolEvent extends EngineEventBase {
    type: "claude.tool";
    phase: "use" | "result";
    sessionId: string | null;
    tool: string | null;
    /** Only for phase "result". */
    success?: boolean;
}

/** Claude Code finished responding (claude.stop) or a session ended (claude.session_end). */
export interface ClaudeStopEvent extends EngineEventBase {
    type: "claude.stop";
    sessionId: string | null;
    sessionEnded: boolean;
}

/** A check run finished (check.passed / check.failed). */
export interface CheckResultEvent extends EngineEventBase {
    type: "check.result";
    run: CheckRun;
}

/** Anything else from the journal, passed through untouched. */
export interface OtherEvent extends EngineEventBase {
    type: "other";
}

export type EngineEvent =
    | FileChangedEvent
    | CommitMadeEvent
    | ClaudeToolEvent
    | ClaudeStopEvent
    | CheckResultEvent
    | OtherEvent;

export type EngineEventType = EngineEvent["type"];

/* -------------------------------------------------------------------------
 * Check runs — the executor's output
 * ---------------------------------------------------------------------- */

/**
 * - passed: exit code 0
 * - failed: non-zero exit code
 * - timeout: killed after exceeding the time limit
 * - error: could not run at all (spawn failure, missing command)
 * - cancelled: aborted by the caller (e.g. superseded by a newer run)
 */
export type CheckOutcome = "passed" | "failed" | "timeout" | "error" | "cancelled";

export interface CheckRun {
    /** Unique id of this run. */
    id: string;
    kind: CheckKind;
    /** Exact shell command that ran, from tyr.json. */
    command: string;
    /** Absolute working directory. */
    cwd: string;
    trigger: CheckTrigger;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    outcome: CheckOutcome;
    /** Null when killed by a signal or never started. */
    exitCode: number | null;
    signal: string | null;
    /** Tail of stdout, capped (see DEFAULT_OUTPUT_TAIL_BYTES). */
    stdout: string;
    /** Tail of stderr, capped. */
    stderr: string;
    /** True when either stream was cut to fit the cap. */
    outputTruncated: boolean;
    /** Spawn-level error message for outcome "error". */
    error?: string;
    /** HEAD when the run started, null outside a repo. */
    headCommit: string | null;
}

export const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_OUTPUT_TAIL_BYTES = 64 * 1024;

/** Journal kinds for check events (source "check"). */
export const CHECK_STARTED_KIND = "check.started";
export const CHECK_PASSED_KIND = "check.passed";
export const CHECK_FAILED_KIND = "check.failed";

/* -------------------------------------------------------------------------
 * Repository state — persisted to .tyr/state/engine.json
 * ---------------------------------------------------------------------- */

/** Something wrong right now; opened by a failing check, closed when it passes again. */
export interface Problem {
    /** Stable key, e.g. "check:test". One open problem per key. */
    key: string;
    kind: CheckKind;
    title: string;
    /** Short excerpt of the failing output. */
    detail: string;
    /** Run that opened it and the latest run that confirmed it. */
    firstSeenRunId: string;
    lastSeenRunId: string;
    firstSeenAt: string;
    lastSeenAt: string;
    /** True when the check passed on an earlier run (a regression, not a pre-existing failure). */
    regression: boolean;
}

/** Compact record of a run kept in state (no output). */
export type CheckRunSummary = Omit<CheckRun, "stdout" | "stderr">;

export interface CheckState {
    last: CheckRunSummary | null;
    /** Most recent run with outcome "passed". */
    lastGood: CheckRunSummary | null;
}

export interface WorkingTreeSnapshot {
    headCommit: string | null;
    branch: string | null;
    /** Uncommitted changes vs HEAD (tracked files), plus untracked count. */
    totals: DiffTotals;
    untracked: number;
    /** Root-relative paths, capped. */
    files: string[];
    takenAt: string;
}

export const ENGINE_STATE_VERSION = 1;

export interface EngineState {
    version: typeof ENGINE_STATE_VERSION;
    updatedAt: string;
    workingTree: WorkingTreeSnapshot | null;
    checks: Partial<Record<CheckKind, CheckState>>;
    problems: Problem[];
}
