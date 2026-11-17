// Repository state model (cli/engine/ENGINE.md): the current working-tree
// diff, the last and last good run of each check, and the open problems.
// Persisted to `.tyr/state/engine.json`.
//
// Split in three layers:
// - pure: emptyEngineState(), applyCheckRun(), openProblems(), isHealthy().
//   The reducer is where every rule about problems lives, so it is tested
//   without touching disk.
// - storage: readEngineState() never throws (missing, corrupt or a different
//   version all read as the empty state); writeEngineState() is atomic;
//   updateEngineState() is the read-modify-write under the `.tyr/` lock,
//   mirroring state-store.ts.
// - git: snapshotWorkingTree() summarizes uncommitted changes. It is total,
//   like git.ts and git-diff.ts: outside a repo it resolves to null.
//
// Nothing here prints. The only throws are the abnormal ones from the layers
// below (a lock held past its timeout, a failed disk write) in the
// write/update functions.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getDiffStat, type DiffStat, type DiffTotals } from "../core/git-diff.js";
import { getCurrentBranch, getHeadCommit, isGitRepository } from "../core/git.js";
import { withTyrLock, type TyrLockOptions } from "../core/lock.js";
import { readJsonFile, resolveTyrPaths, toJsonDocument, writeFileAtomic } from "../core/scaffold.js";
import {
    CHECK_KINDS,
    ENGINE_STATE_VERSION,
    type CheckKind,
    type CheckRun,
    type CheckRunSummary,
    type CheckState,
    type EngineState,
    type Problem,
    type WorkingTreeSnapshot,
} from "./model.js";

/** Cap on `WorkingTreeSnapshot.files`. */
export const MAX_SNAPSHOT_FILES = 200;

/** Cap on `Problem.detail`: the last this-many lines... */
export const PROBLEM_DETAIL_MAX_LINES = 20;
/** ...and at most this many characters. */
export const PROBLEM_DETAIL_MAX_CHARS = 2 * 1024;

const ENGINE_STATE_FILE_NAME = "engine.json";

/* -------------------------------------------------------------------------
 * Pure model
 * ---------------------------------------------------------------------- */

export function emptyEngineState(now: Date = new Date(0)): EngineState {
    return {
        version: ENGINE_STATE_VERSION,
        updatedAt: now.toISOString(),
        workingTree: null,
        checks: {},
        problems: [],
    };
}

/** Problem key for a check kind: one open problem per check. */
export function checkProblemKey(kind: CheckKind): string {
    return `check:${kind}`;
}

function summarize(run: CheckRun): CheckRunSummary {
    const { stdout: _stdout, stderr: _stderr, ...summary } = run;
    return summary;
}

/**
 * Fold one finished check run into the state. Pure: returns a new state.
 *
 * - every outcome records `checks[kind].last`;
 * - passed: also `lastGood`, and closes the `check:<kind>` problem;
 * - failed / timeout: opens the problem, or refreshes it (keeping when and
 *   by which run it was first seen, and whether it was a regression);
 * - error / cancelled: say nothing about the code, so problems are untouched.
 */
export function applyCheckRun(state: EngineState, run: CheckRun, now: Date = new Date()): EngineState {
    const summary = summarize(run);
    const previous: CheckState = state.checks[run.kind] ?? { last: null, lastGood: null };
    const passed = run.outcome === "passed";
    const checks = {
        ...state.checks,
        [run.kind]: { last: summary, lastGood: passed ? summary : previous.lastGood },
    };

    const key = checkProblemKey(run.kind);
    let problems = state.problems;
    if (passed) {
        problems = problems.filter((problem) => problem.key !== key);
    } else if (run.outcome === "failed" || run.outcome === "timeout") {
        const existing = problems.find((problem) => problem.key === key);
        const seenAt = run.finishedAt || now.toISOString();
        const refreshed: Problem = {
            key,
            kind: run.kind,
            title: problemTitle(run),
            detail: problemDetail(run),
            firstSeenRunId: existing?.firstSeenRunId ?? run.id,
            lastSeenRunId: run.id,
            firstSeenAt: existing?.firstSeenAt ?? seenAt,
            lastSeenAt: seenAt,
            regression: existing?.regression ?? previous.lastGood !== null,
        };
        problems = existing
            ? problems.map((problem) => (problem.key === key ? refreshed : problem))
            : [...problems, refreshed];
    }

    return { ...state, version: ENGINE_STATE_VERSION, updatedAt: now.toISOString(), checks, problems };
}

function problemTitle(run: CheckRun): string {
    if (run.outcome === "timeout") return `${run.kind} timed out`;
    return run.exitCode === null ? `${run.kind} failed` : `${run.kind} failed (exit ${run.exitCode})`;
}

/** Last lines of stderr (or stdout when stderr is empty), bounded. */
export function problemDetail(run: Pick<CheckRun, "stdout" | "stderr" | "error" | "outcome" | "durationMs">): string {
    const source = run.stderr.trim().length > 0 ? run.stderr : run.stdout;
    let excerpt = source.replace(/\s+$/, "").split(/\r?\n/).slice(-PROBLEM_DETAIL_MAX_LINES).join("\n");
    if (excerpt.length > PROBLEM_DETAIL_MAX_CHARS) {
        excerpt = excerpt.slice(excerpt.length - PROBLEM_DETAIL_MAX_CHARS);
        // Start at a whole line when one begins inside the window.
        const newline = excerpt.indexOf("\n");
        if (newline !== -1 && newline < excerpt.length - 1) excerpt = excerpt.slice(newline + 1);
    }
    if (excerpt.trim().length > 0) return excerpt;
    if (run.error) return run.error;
    return run.outcome === "timeout" ? `Timed out after ${run.durationMs}ms with no output.` : "No output.";
}

/** Open problems, oldest first. */
export function openProblems(state: EngineState): Problem[] {
    return [...state.problems].sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt));
}

/** True when nothing is currently failing. */
export function isHealthy(state: EngineState): boolean {
    return state.problems.length === 0;
}

/* -------------------------------------------------------------------------
 * Storage
 * ---------------------------------------------------------------------- */

export function engineStateFile(root: string): string {
    return path.join(resolveTyrPaths(root).stateDir, ENGINE_STATE_FILE_NAME);
}

/**
 * The persisted state, or the empty state when the file is missing,
 * unreadable, malformed, or written by a different version. Never throws.
 */
export async function readEngineState(root: string): Promise<EngineState> {
    const read = await readJsonFile(engineStateFile(root));
    if (read.kind !== "ok") return emptyEngineState();
    return parseEngineState(read.value) ?? emptyEngineState();
}

/**
 * Shape check for engine.json. Only the top-level structure is enforced;
 * individual entries that are clearly not records are dropped rather than
 * failing the whole file.
 */
function parseEngineState(value: Record<string, unknown>): EngineState | null {
    if (value.version !== ENGINE_STATE_VERSION) return null;
    const { updatedAt, workingTree, checks, problems } = value;
    if (typeof updatedAt !== "string") return null;
    if (workingTree !== null && !isObject(workingTree)) return null;
    if (!isObject(checks) || !Array.isArray(problems)) return null;

    const knownKinds = new Set<string>(CHECK_KINDS);
    const cleanChecks: EngineState["checks"] = {};
    for (const [kind, entry] of Object.entries(checks)) {
        if (!knownKinds.has(kind) || !isObject(entry)) continue;
        cleanChecks[kind as CheckKind] = {
            last: isObject(entry.last) ? (entry.last as unknown as CheckRunSummary) : null,
            lastGood: isObject(entry.lastGood) ? (entry.lastGood as unknown as CheckRunSummary) : null,
        };
    }

    const cleanProblems = problems.filter(
        (problem): problem is Problem =>
            isObject(problem) &&
            typeof problem.key === "string" &&
            typeof problem.firstSeenAt === "string" &&
            typeof problem.lastSeenAt === "string",
    );

    return {
        version: ENGINE_STATE_VERSION,
        updatedAt,
        workingTree: (workingTree as WorkingTreeSnapshot | null) ?? null,
        checks: cleanChecks,
        problems: cleanProblems,
    };
}

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Write engine.json atomically, creating `.tyr/state/` if needed. */
export async function writeEngineState(root: string, state: EngineState): Promise<void> {
    const file = engineStateFile(root);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, toJsonDocument(state));
}

/**
 * Read engine.json, pass it to `mutate`, stamp `updatedAt` and write the
 * result, all under the `.tyr/` lock. `mutate` returns null to leave the file
 * untouched. Resolves to the state as stored after the call.
 *
 * Throws only what withTyrLock / the write throw (lock timeout, disk failure).
 */
export async function updateEngineState(
    root: string,
    mutate: (state: EngineState) => EngineState | null,
    now: Date = new Date(),
    lockOptions?: TyrLockOptions,
): Promise<EngineState> {
    return withTyrLock(
        root,
        "engine state update",
        async () => {
            const current = await readEngineState(root);
            const next = mutate(current);
            if (next === null) return current;
            const stamped: EngineState = { ...next, version: ENGINE_STATE_VERSION, updatedAt: now.toISOString() };
            await writeEngineState(root, stamped);
            return stamped;
        },
        lockOptions,
    );
}

/** Persist one finished check run (applyCheckRun under the lock). */
export function recordCheckRun(root: string, run: CheckRun, now: Date = new Date()): Promise<EngineState> {
    return updateEngineState(root, (state) => applyCheckRun(state, run, now), now);
}

/**
 * Take a fresh working-tree snapshot and store it. The git calls run before
 * the lock is taken, so the critical section stays a single file write.
 */
export async function refreshWorkingTree(root: string, now: Date = new Date()): Promise<EngineState> {
    const snapshot = await snapshotWorkingTree(root, now);
    return updateEngineState(root, (state) => ({ ...state, workingTree: snapshot }), now);
}

/* -------------------------------------------------------------------------
 * Working tree
 * ---------------------------------------------------------------------- */

/**
 * Uncommitted changes relative to HEAD: tracked-file totals, untracked count,
 * and up to MAX_SNAPSHOT_FILES paths (tracked changes first, then untracked).
 *
 * On a repo with no commits there is no HEAD to diff against, so the index
 * (vs the empty tree) and the working tree (vs the index) are combined:
 * totals then add up both diffs. Null outside a repo or when git fails.
 */
export async function snapshotWorkingTree(root: string, now: Date = new Date()): Promise<WorkingTreeSnapshot | null> {
    if (!(await isGitRepository(root))) return null;

    const [head, branch] = await Promise.all([getHeadCommit(root), getCurrentBranch(root)]);

    let tracked: { paths: string[]; totals: DiffTotals };
    let untracked: string[];
    if (head !== null) {
        const stat = await getDiffStat(root, { kind: "since", ref: "HEAD" }, { includeUntracked: true });
        if (stat === null) return null;
        tracked = { paths: stat.files.map((file) => file.path), totals: stat.totals };
        untracked = stat.untracked ?? [];
    } else {
        const [staged, unstaged] = await Promise.all([
            getDiffStat(root, { kind: "staged" }),
            getDiffStat(root, { kind: "unstaged" }, { includeUntracked: true }),
        ]);
        if (staged === null || unstaged === null) return null;
        tracked = combineUnborn(staged, unstaged);
        untracked = unstaged.untracked ?? [];
    }

    return {
        headCommit: head?.hash ?? null,
        branch: branch.branch,
        totals: tracked.totals,
        untracked: untracked.length,
        files: [...tracked.paths, ...untracked].slice(0, MAX_SNAPSHOT_FILES),
        takenAt: now.toISOString(),
    };
}

function combineUnborn(staged: DiffStat, unstaged: DiffStat): { paths: string[]; totals: DiffTotals } {
    const paths = [...new Set([...staged.files, ...unstaged.files].map((file) => file.path))];
    return {
        paths,
        totals: {
            files: paths.length,
            additions: staged.totals.additions + unstaged.totals.additions,
            deletions: staged.totals.deletions + unstaged.totals.deletions,
        },
    };
}
