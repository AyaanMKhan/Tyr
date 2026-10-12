// Guarded git write operations for corrective agents.
//
// Tyr's corrective agents need to change a repository — branch off, park
// work in a stash, commit a fix, revert a bad commit — without ever making
// things worse. Every operation here checks its preconditions *before*
// mutating anything and refuses with a typed reason instead of letting git
// half-apply something. Like git.ts, every export is total: nothing throws,
// nothing prints, every outcome is a discriminated `{ ok }` result.
//
// Hard rules, enforced by construction rather than by option:
//   - no --force, no `reset --hard`, no push, no history rewriting;
//   - argv-only, user-supplied names that start with "-" are refused (option
//     injection), and pathspecs always follow "--";
//   - writes to one repository are serialized in-process, so two agents
//     cannot race on the index or on refs.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runGit, type GitResult } from "./git-exec.js";
import { getCurrentBranch, getStatusOutcome } from "./git.js";

// Hooks, large indexes and worktree checkouts are far slower than the reads
// in git.ts, so writes get a much longer default cap.
export const GIT_WRITE_TIMEOUT_MS = 60_000;

export const DEFAULT_PROTECTED_BRANCHES: readonly string[] = ["main", "master"];

// Trailer key stamped on every commit Tyr creates, so they can be found later
// with `git log --grep "^Tyr-Agent:"` or `git interpret-trailers`.
export const TYR_TRAILER_KEY = "Tyr-Agent";
export const DEFAULT_AGENT_NAME = "tyr";

/* -------------------------------------------------------------------------
 * Types
 * ---------------------------------------------------------------------- */

export type GitWriteFailureReason =
    | "not-a-repo"
    | "invalid-argument"
    | "invalid-branch-name"
    | "branch-exists"
    | "invalid-ref"
    | "operation-in-progress"
    | "conflicts"
    | "unborn-head"
    | "detached-head"
    | "protected-branch"
    | "nothing-to-commit"
    | "nothing-to-stash"
    | "dirty-worktree"
    | "merge-commit"
    | "path-exists"
    | "path-inside-repo"
    | "worktree-not-found"
    | "stash-not-found"
    | "timeout"
    | "git-failed";

export interface GitWriteFailure {
    ok: false;
    reason: GitWriteFailureReason;
    /** Human-readable explanation; never printed by this module. */
    message: string;
    /** git's stderr when a git command itself failed. */
    stderr?: string;
}

export type GitWriteResult<T> = ({ ok: true } & T) | GitWriteFailure;

interface WriteSuccessBase {
    /** True when nothing was mutated and `commands` is only the plan. */
    dryRun: boolean;
    /** The mutating git argv lists that ran (or would run, under dryRun). */
    commands: string[][];
}

export interface GitIdentity {
    name: string;
    email: string;
}

export interface WriteOptions {
    /** Check every guard and report the plan, but mutate nothing. */
    dryRun?: boolean;
    /** Time limit per mutating git call. Defaults to GIT_WRITE_TIMEOUT_MS. */
    timeoutMs?: number;
}

export interface CommitIdentityOptions {
    /** Name recorded in the `Tyr-Agent:` trailer. Defaults to "tyr". */
    agent?: string;
    /** Author identity. When given without `committer`, it is used for both. */
    author?: GitIdentity;
    committer?: GitIdentity;
}

export interface ProtectedBranchOptions {
    /** Branches commits must never land on. Defaults to main/master. */
    protectedBranches?: readonly string[];
    /** Explicitly allow committing onto a protected branch. */
    allowProtected?: boolean;
    /** Explicitly allow committing on a detached HEAD. */
    allowDetached?: boolean;
}

export interface CreateBranchOptions extends WriteOptions {
    /** Start point (branch, tag, hash). Defaults to HEAD. */
    from?: string;
    /** Switch to the branch after creating it. */
    checkout?: boolean;
    /** Treat an existing branch as success instead of refusing (it is not moved). */
    allowExisting?: boolean;
}

export type CreateBranchResult = GitWriteResult<
    WriteSuccessBase & { branch: string; commit: string; created: boolean; checkedOut: boolean }
>;

export interface CreateWorktreeOptions extends WriteOptions {
    /** Branch to check out in the new worktree; created unless it exists. */
    branch: string;
    /** Start point for a new branch. Defaults to HEAD. */
    from?: string;
    /** Check out an existing branch instead of refusing. */
    allowExistingBranch?: boolean;
}

export type CreateWorktreeResult = GitWriteResult<
    WriteSuccessBase & { path: string; branch: string; commit: string; createdBranch: boolean }
>;

export type RemoveWorktreeResult = GitWriteResult<WriteSuccessBase & { path: string; branch: string | null }>;

export interface StashOptions extends WriteOptions {
    message: string;
    includeUntracked?: boolean;
}

export type StashResult = GitWriteResult<
    WriteSuccessBase & {
        /** Full hash of the stash commit; pass this to `stashPop`. Null under dryRun. */
        ref: string | null;
        message: string;
    }
>;

export type StashPopResult = GitWriteResult<WriteSuccessBase & { ref: string }>;

export interface CommitOptions extends WriteOptions, CommitIdentityOptions, ProtectedBranchOptions {
    message: string;
    /** Commit exactly these paths (new files included), ignoring anything else staged. */
    paths?: string[];
    /** Commit every tracked modification and deletion, like `git commit -a`. */
    all?: boolean;
}

export type CommitResult = GitWriteResult<WriteSuccessBase & { commit: string | null; branch: string | null }>;

export interface RevertOptions extends WriteOptions, CommitIdentityOptions, ProtectedBranchOptions {
    /** Apply the inverse to the index and worktree without committing. */
    noCommit?: boolean;
    /** Parent number to revert against; required for merge commits. */
    mainline?: number;
}

export type RevertResult = GitWriteResult<
    WriteSuccessBase & {
        /** Full hash of the commit that was reverted. */
        reverted: string;
        /** The new revert commit; null under noCommit or dryRun. */
        commit: string | null;
    }
>;

/* -------------------------------------------------------------------------
 * Per-repository write lock
 * ---------------------------------------------------------------------- */

const repoLocks = new Map<string, Promise<void>>();

/**
 * Run `task` once every earlier task holding the same key has finished. Keys
 * are the repository's common git dir, so linked worktrees of one repo (which
 * share refs and the stash) are serialized together.
 */
export async function withRepoLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = repoLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = previous.then(
        () =>
            new Promise<void>((resolve) => {
                release = resolve;
            }),
    );
    repoLocks.set(key, current);

    await previous;
    try {
        return await task();
    } finally {
        release();
        // Only the tail of the queue may clear the entry.
        if (repoLocks.get(key) === current) {
            repoLocks.delete(key);
        }
    }
}

/* -------------------------------------------------------------------------
 * Branches
 * ---------------------------------------------------------------------- */

export async function createBranch(
    root: string,
    name: string,
    options: CreateBranchOptions = {},
): Promise<CreateBranchResult> {
    return guarded(root, async () => {
        const nameError = await validateBranchName(root, name);
        if (nameError !== null) {
            return nameError;
        }
        const start = await resolveStartPoint(root, options.from);
        if (!start.ok) {
            return start;
        }
        if (options.checkout === true) {
            const blocked = await checkNoOperationOrConflicts(root);
            if (blocked !== null) {
                return blocked;
            }
        }

        const exists = await branchExists(root, name);
        if (exists && options.allowExisting !== true) {
            return fail("branch-exists", `Branch "${name}" already exists.`);
        }

        const commands: string[][] = [];
        if (exists) {
            if (options.checkout === true) {
                commands.push(["switch", name]);
            }
        } else if (options.checkout === true) {
            commands.push(["switch", "--no-track", "-c", name, start.commit]);
        } else {
            commands.push(["branch", "--no-track", name, start.commit]);
        }

        const commit = exists ? await revParseCommit(root, `refs/heads/${name}`) : start.commit;
        const success = {
            branch: name,
            commit: commit ?? start.commit,
            created: !exists,
            checkedOut: options.checkout === true,
            commands,
        };
        if (options.dryRun === true) {
            return { ok: true, dryRun: true, ...success };
        }

        const failure = await runAll(root, commands, options);
        return failure ?? { ok: true, dryRun: false, ...success };
    });
}

/* -------------------------------------------------------------------------
 * Worktrees
 * ---------------------------------------------------------------------- */

export async function createWorktree(
    root: string,
    worktreePath: string,
    options: CreateWorktreeOptions,
): Promise<CreateWorktreeResult> {
    return guarded(root, async (repo) => {
        if (typeof worktreePath !== "string" || worktreePath.length === 0) {
            return fail("invalid-argument", "A worktree path is required.");
        }
        const target = path.resolve(root, worktreePath);

        const nameError = await validateBranchName(root, options.branch);
        if (nameError !== null) {
            return nameError;
        }

        // A worktree nested inside the main checkout would show up as
        // untracked files there (and could be committed by accident).
        const realTarget = await realpathOfNearestAncestor(target);
        if (isWithin(realTarget, repo.toplevel) || isWithin(realTarget, repo.commonDir)) {
            return fail("path-inside-repo", `Worktree path ${target} is inside the repository.`);
        }
        const occupied = await pathOccupied(target);
        if (occupied !== null) {
            return fail("path-exists", occupied);
        }

        const exists = await branchExists(root, options.branch);
        if (exists && options.allowExistingBranch !== true) {
            return fail("branch-exists", `Branch "${options.branch}" already exists.`);
        }

        let commit: string;
        let command: string[];
        if (exists) {
            commit = (await revParseCommit(root, `refs/heads/${options.branch}`)) ?? "";
            command = ["worktree", "add", "--", target, options.branch];
        } else {
            const start = await resolveStartPoint(root, options.from);
            if (!start.ok) {
                return start;
            }
            commit = start.commit;
            command = ["worktree", "add", "--no-track", "-b", options.branch, "--", target, start.commit];
        }

        const success = { path: target, branch: options.branch, commit, createdBranch: !exists, commands: [command] };
        if (options.dryRun === true) {
            return { ok: true, dryRun: true, ...success };
        }
        const failure = await runAll(root, [command], options);
        return failure ?? { ok: true, dryRun: false, ...success };
    });
}

/**
 * Remove a linked worktree. Never forced: git itself refuses when the
 * worktree has uncommitted or untracked changes, which surfaces as
 * `dirty-worktree`. The branch it had checked out is kept.
 */
export async function removeWorktree(
    root: string,
    worktreePath: string,
    options: WriteOptions = {},
): Promise<RemoveWorktreeResult> {
    return guarded(root, async () => {
        if (typeof worktreePath !== "string" || worktreePath.length === 0) {
            return fail("invalid-argument", "A worktree path is required.");
        }
        const target = path.resolve(root, worktreePath);
        const realTarget = await realpathOfNearestAncestor(target);

        const worktrees = await listWorktrees(root);
        if (worktrees === null) {
            return fail("git-failed", "Could not list worktrees.");
        }
        const index = worktrees.findIndex((entry) => entry.path === realTarget || entry.path === target);
        if (index === -1) {
            return fail("worktree-not-found", `${target} is not a worktree of this repository.`);
        }
        // `git worktree list` always prints the main worktree first.
        if (index === 0) {
            return fail("invalid-argument", "Refusing to remove the main worktree.");
        }

        const command = ["worktree", "remove", "--", worktrees[index].path];
        const success = { path: worktrees[index].path, branch: worktrees[index].branch, commands: [command] };
        if (options.dryRun === true) {
            return { ok: true, dryRun: true, ...success };
        }

        const result = await runGit(root, command, { timeoutMs: options.timeoutMs ?? GIT_WRITE_TIMEOUT_MS });
        if (!result.ok && !result.timedOut && /modified or untracked|locked/.test(result.stderr)) {
            return fail("dirty-worktree", "Worktree has changes or is locked; it was left in place.", result.stderr);
        }
        if (!result.ok) {
            return gitFailure(result, "git worktree remove");
        }
        return { ok: true, dryRun: false, ...success };
    });
}

/* -------------------------------------------------------------------------
 * Stash
 * ---------------------------------------------------------------------- */

export async function stash(root: string, options: StashOptions): Promise<StashResult> {
    return guarded(root, async () => {
        if (typeof options.message !== "string" || options.message.trim().length === 0) {
            return fail("invalid-argument", "A stash message is required.");
        }
        if ((await revParseCommit(root, "HEAD")) === null) {
            return fail("unborn-head", "Cannot stash before the first commit.");
        }
        const blocked = await checkNoOperationOrConflicts(root);
        if (blocked !== null) {
            return blocked;
        }

        const outcome = await getStatusOutcome(root);
        if (outcome.status === null) {
            return outcome.timedOut
                ? fail("timeout", "git status timed out.")
                : fail("git-failed", "Could not read the working-tree status.");
        }
        const status = outcome.status;
        const hasTracked = status.staged.length > 0 || status.modified.length > 0;
        const hasUntracked = options.includeUntracked === true && status.untracked.length > 0;
        if (!hasTracked && !hasUntracked) {
            return fail("nothing-to-stash", "There are no local changes to stash.");
        }

        const command = ["stash", "push"];
        if (options.includeUntracked === true) {
            command.push("--include-untracked");
        }
        command.push("-m", options.message);

        if (options.dryRun === true) {
            return { ok: true, dryRun: true, ref: null, message: options.message, commands: [command] };
        }

        const before = await revParseCommit(root, "refs/stash");
        const failure = await runAll(root, [command], options);
        if (failure !== null) {
            return failure;
        }
        // `stash push` exits 0 even when it decides there was nothing to save,
        // so confirm a new stash commit really appeared.
        const after = await revParseCommit(root, "refs/stash");
        if (after === null || after === before) {
            return fail("nothing-to-stash", "git did not create a stash.");
        }
        return { ok: true, dryRun: false, ref: after, message: options.message, commands: [command] };
    });
}

/**
 * Pop the stash identified by the commit hash `stash()` returned. The entry
 * is looked up by hash, so stashes pushed by anyone else in the meantime
 * never get applied by mistake.
 */
export async function stashPop(root: string, ref: string, options: WriteOptions = {}): Promise<StashPopResult> {
    return guarded(root, async () => {
        if (typeof ref !== "string" || !/^[0-9a-f]{7,64}$/i.test(ref)) {
            return fail("invalid-argument", "Expected the stash commit hash returned by stash().");
        }
        const blocked = await checkNoOperationOrConflicts(root);
        if (blocked !== null) {
            return blocked;
        }

        const list = await runGit(root, ["stash", "list", "--format=%H"]);
        if (!list.ok) {
            return gitFailure(list, "git stash list");
        }
        const hashes = list.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
        const needle = ref.toLowerCase();
        const matches = hashes
            .map((hash, index) => ({ hash, index }))
            .filter((entry) => entry.hash.startsWith(needle));
        if (matches.length === 0) {
            return fail("stash-not-found", `No stash entry matches ${ref}.`);
        }
        if (matches.length > 1) {
            return fail("invalid-argument", `${ref} matches more than one stash entry; use the full hash.`);
        }

        const command = ["stash", "pop", `stash@{${matches[0].index}}`];
        const success = { ref: matches[0].hash, commands: [command] };
        if (options.dryRun === true) {
            return { ok: true, dryRun: true, ...success };
        }

        const result = await runGit(root, command, { timeoutMs: options.timeoutMs ?? GIT_WRITE_TIMEOUT_MS });
        if (!result.ok && !result.timedOut && (await hasConflicts(root))) {
            // git keeps the stash entry when the pop conflicts, so nothing is
            // lost; the caller decides how to resolve.
            return fail("conflicts", "Popping the stash produced conflicts; the stash entry was kept.", result.stderr);
        }
        if (!result.ok) {
            return gitFailure(result, "git stash pop");
        }
        return { ok: true, dryRun: false, ...success };
    });
}

/* -------------------------------------------------------------------------
 * Commit
 * ---------------------------------------------------------------------- */

export async function commit(root: string, options: CommitOptions): Promise<CommitResult> {
    return guarded(root, async () => {
        if (typeof options.message !== "string" || options.message.trim().length === 0) {
            return fail("invalid-argument", "A commit message is required.");
        }
        if (options.paths !== undefined && options.all === true) {
            return fail("invalid-argument", "Pass either paths or all, not both.");
        }
        if (options.paths !== undefined) {
            if (options.paths.length === 0 || options.paths.some((p) => typeof p !== "string" || p.length === 0)) {
                return fail("invalid-argument", "paths must be a non-empty list of non-empty paths.");
            }
        }
        const identity = commitIdentity(options);
        if (!identity.ok) {
            return identity;
        }

        const blocked = await checkNoOperationOrConflicts(root);
        if (blocked !== null) {
            return blocked;
        }
        const target = await checkCommitTarget(root, options);
        if (!target.ok) {
            return target;
        }

        // Decide whether there is anything to commit *before* touching the
        // index, so a refused commit leaves no staging side effects.
        const pending = await hasPendingChanges(root, options);
        if (!pending.ok) {
            return pending;
        }
        if (!pending.value) {
            return fail("nothing-to-commit", "There is nothing to commit.");
        }

        const commands: string[][] = [];
        const commitCommand = ["commit", "-m", options.message, "--trailer", identity.trailer];
        if (options.paths !== undefined) {
            // `add -A` with a pathspec stages new files and deletions under
            // those paths; `commit -- paths` then commits only them.
            commands.push(["add", "-A", "--", ...options.paths]);
            commitCommand.push("--", ...options.paths);
        } else if (options.all === true) {
            commitCommand.splice(1, 0, "-a");
        }
        commands.push(commitCommand);

        if (options.dryRun === true) {
            return { ok: true, dryRun: true, commit: null, branch: target.branch, commands };
        }

        const failure = await runAll(root, commands, options, identity.env);
        if (failure !== null) {
            return failure;
        }
        return { ok: true, dryRun: false, commit: await revParseCommit(root, "HEAD"), branch: target.branch, commands };
    });
}

/* -------------------------------------------------------------------------
 * Revert
 * ---------------------------------------------------------------------- */

export async function revert(root: string, target: string, options: RevertOptions = {}): Promise<RevertResult> {
    return guarded(root, async () => {
        const identity = commitIdentity(options);
        if (!identity.ok) {
            return identity;
        }
        if ((await revParseCommit(root, "HEAD")) === null) {
            return fail("unborn-head", "Cannot revert before the first commit.");
        }
        const resolved = await resolveStartPoint(root, target);
        if (!resolved.ok) {
            return resolved;
        }
        const blocked = await checkNoOperationOrConflicts(root);
        if (blocked !== null) {
            return blocked;
        }
        if (options.noCommit !== true) {
            const branchCheck = await checkCommitTarget(root, options);
            if (!branchCheck.ok) {
                return branchCheck;
            }
        }

        // A revert on top of local edits would mix the inverse patch with
        // unrelated work; require a clean tracked state.
        const outcome = await getStatusOutcome(root);
        if (outcome.status === null) {
            return outcome.timedOut
                ? fail("timeout", "git status timed out.")
                : fail("git-failed", "Could not read the working-tree status.");
        }
        if (outcome.status.staged.length > 0 || outcome.status.modified.length > 0) {
            return fail("dirty-worktree", "Commit or stash local changes before reverting.");
        }

        const parents = await runGit(root, ["rev-list", "--parents", "-n", "1", resolved.commit]);
        if (!parents.ok) {
            return gitFailure(parents, "git rev-list");
        }
        const parentCount = parents.stdout.trim().split(/\s+/).length - 1;
        const revertCommand = ["revert", "--no-edit", "--no-commit"];
        if (parentCount > 1) {
            if (options.mainline === undefined) {
                return fail("merge-commit", `${resolved.commit} is a merge commit; pass mainline to choose a parent.`);
            }
            if (!Number.isInteger(options.mainline) || options.mainline < 1 || options.mainline > parentCount) {
                return fail("invalid-argument", `mainline must be between 1 and ${parentCount}.`);
            }
            revertCommand.push("-m", String(options.mainline));
        } else if (options.mainline !== undefined) {
            return fail("invalid-argument", "mainline only applies to merge commits.");
        }
        revertCommand.push(resolved.commit);

        // Always revert with --no-commit, then either commit ourselves (so
        // the Tyr trailer lands on git's prepared "Revert ..." message) or
        // quit the sequencer so the result is plain staged changes.
        const finish = options.noCommit === true
            ? ["revert", "--quit"]
            : ["commit", "--no-edit", "--trailer", identity.trailer];
        const commands = [revertCommand, finish];
        if (options.dryRun === true) {
            return { ok: true, dryRun: true, reverted: resolved.commit, commit: null, commands };
        }

        const timeoutMs = options.timeoutMs ?? GIT_WRITE_TIMEOUT_MS;
        const applied = await runGit(root, revertCommand, { timeoutMs, env: identity.env });
        if (!applied.ok) {
            if (!applied.timedOut && (await hasConflicts(root))) {
                // The tree was clean before we started, so aborting restores
                // exactly what was there.
                await runGit(root, ["revert", "--abort"], { timeoutMs });
                return fail("conflicts", "The revert conflicted and was aborted.", applied.stderr);
            }
            return gitFailure(applied, "git revert");
        }
        if (options.noCommit !== true) {
            // Reverting a change that is already undone stages nothing; a
            // commit would fail and leave the revert half-open.
            const staged = await runGit(root, ["diff", "--cached", "--quiet"], { timeoutMs });
            if (staged.ok) {
                await runGit(root, ["revert", "--abort"], { timeoutMs });
                return fail("nothing-to-commit", `Reverting ${resolved.commit} changes nothing.`);
            }
        }
        const finished = await runGit(root, finish, { timeoutMs, env: identity.env });
        if (!finished.ok) {
            if (options.noCommit !== true) {
                // e.g. a commit-msg hook rejected it: restore the clean tree.
                await runGit(root, ["revert", "--abort"], { timeoutMs });
            }
            return gitFailure(finished, finish.join(" "));
        }
        return {
            ok: true,
            dryRun: false,
            reverted: resolved.commit,
            commit: options.noCommit === true ? null : await revParseCommit(root, "HEAD"),
            commands,
        };
    });
}

/* -------------------------------------------------------------------------
 * Guards
 * ---------------------------------------------------------------------- */

interface RepoInfo {
    toplevel: string;
    commonDir: string;
}

/**
 * Resolve the repository, take its write lock, and run `task`. Anything
 * unexpected inside a task becomes a `git-failed` result rather than a throw.
 */
async function guarded<T extends { ok: boolean }>(
    root: string,
    task: (repo: RepoInfo) => Promise<T | GitWriteFailure>,
): Promise<T | GitWriteFailure> {
    const repo = await inspectRepo(root);
    if (repo === null) {
        return fail("not-a-repo", `${root} is not inside a git work tree.`);
    }
    return withRepoLock(repo.commonDir, async () => {
        try {
            return await task(repo);
        } catch (error) {
            return fail("git-failed", error instanceof Error ? error.message : String(error));
        }
    });
}

async function inspectRepo(root: string): Promise<RepoInfo | null> {
    const result = await runGit(root, ["rev-parse", "--is-inside-work-tree", "--show-toplevel", "--git-common-dir"]);
    if (!result.ok) {
        return null;
    }
    const [inside, toplevel, commonDir] = result.stdout.split("\n").map((line) => line.trim());
    if (inside !== "true" || !toplevel || !commonDir) {
        return null;
    }
    return {
        toplevel: await realpathOfNearestAncestor(toplevel),
        commonDir: await realpathOfNearestAncestor(path.resolve(root, commonDir)),
    };
}

// Marker files git leaves while a multi-step operation is unfinished.
const IN_PROGRESS_MARKERS: Array<[string, string]> = [
    ["MERGE_HEAD", "merge"],
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase or am"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
];

/** Name of the unfinished operation, or null when the repo is idle. */
export async function getOperationInProgress(root: string): Promise<string | null> {
    // `--git-path` resolves per-worktree state correctly for linked worktrees.
    const args = ["rev-parse", ...IN_PROGRESS_MARKERS.flatMap(([marker]) => ["--git-path", marker])];
    const result = await runGit(root, args);
    if (!result.ok) {
        return null;
    }
    const paths = result.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    for (let i = 0; i < IN_PROGRESS_MARKERS.length && i < paths.length; i++) {
        if (await pathExists(path.resolve(root, paths[i]))) {
            return IN_PROGRESS_MARKERS[i][1];
        }
    }
    return null;
}

async function checkNoOperationOrConflicts(root: string): Promise<GitWriteFailure | null> {
    const operation = await getOperationInProgress(root);
    if (operation !== null) {
        return fail("operation-in-progress", `A ${operation} is in progress; finish or abort it first.`);
    }
    if (await hasConflicts(root)) {
        return fail("conflicts", "The index has unresolved conflicts.");
    }
    return null;
}

async function hasConflicts(root: string): Promise<boolean> {
    const result = await runGit(root, ["ls-files", "--unmerged"]);
    return result.ok && result.stdout.trim().length > 0;
}

/**
 * Validate a branch name: no leading dash (it would parse as an option), no
 * `@{-N}` shorthand, and whatever `git check-ref-format --branch` accepts.
 */
async function validateBranchName(root: string, name: string): Promise<GitWriteFailure | null> {
    if (typeof name !== "string" || name.length === 0) {
        return fail("invalid-branch-name", "A branch name is required.");
    }
    if (name.startsWith("-")) {
        return fail("invalid-branch-name", `Branch name "${name}" may not start with "-".`);
    }
    if (name === "HEAD" || name.includes("@{")) {
        return fail("invalid-branch-name", `"${name}" is not a valid branch name.`);
    }
    const result = await runGit(root, ["check-ref-format", "--branch", name]);
    if (!result.ok || result.stdout.trim() !== name) {
        return fail("invalid-branch-name", `"${name}" is not a valid branch name.`);
    }
    return null;
}

async function branchExists(root: string, name: string): Promise<boolean> {
    const result = await runGit(root, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
    return result.ok;
}

async function revParseCommit(root: string, ref: string): Promise<string | null> {
    const result = await runGit(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    const hash = result.stdout.trim();
    return result.ok && hash.length > 0 ? hash : null;
}

/** Resolve a start point (default HEAD) to a full commit hash. */
async function resolveStartPoint(
    root: string,
    ref: string | undefined,
): Promise<{ ok: true; commit: string } | GitWriteFailure> {
    if (ref === undefined) {
        const head = await revParseCommit(root, "HEAD");
        return head === null
            ? fail("unborn-head", "HEAD has no commits yet; pass an explicit start point.")
            : { ok: true, commit: head };
    }
    if (typeof ref !== "string" || ref.length === 0 || ref.startsWith("-")) {
        return fail("invalid-ref", `"${String(ref)}" is not a valid revision.`);
    }
    const resolved = await revParseCommit(root, ref);
    return resolved === null
        ? fail("invalid-ref", `"${ref}" does not name a commit.`)
        : { ok: true, commit: resolved };
}

/** Refuse commits on protected branches and (by default) on a detached HEAD. */
async function checkCommitTarget(
    root: string,
    options: ProtectedBranchOptions,
): Promise<{ ok: true; branch: string | null } | GitWriteFailure> {
    const { branch, detached } = await getCurrentBranch(root);
    if (detached) {
        return options.allowDetached === true
            ? { ok: true, branch: null }
            : fail("detached-head", "HEAD is detached; the commit would not be on any branch.");
    }
    if (branch === null) {
        return fail("git-failed", "Could not determine the current branch.");
    }
    const protectedBranches = options.protectedBranches ?? DEFAULT_PROTECTED_BRANCHES;
    if (protectedBranches.includes(branch) && options.allowProtected !== true) {
        return fail("protected-branch", `Refusing to commit to protected branch "${branch}".`);
    }
    return { ok: true, branch };
}

async function hasPendingChanges(
    root: string,
    options: CommitOptions,
): Promise<{ ok: true; value: boolean } | GitWriteFailure> {
    // Porcelain with a pathspec: any line at all (staged, unstaged or
    // untracked) under the paths means `add` + `commit -- paths` has work.
    const args = ["status", "--porcelain=v1", "--untracked-files=all"];
    if (options.paths !== undefined) {
        args.push("--", ...options.paths);
    }
    const result = await runGit(root, args, { timeoutMs: options.timeoutMs ?? GIT_WRITE_TIMEOUT_MS });
    if (!result.ok) {
        return gitFailure(result, "git status");
    }
    const lines = result.stdout.split("\n").filter((line) => line.length >= 3);
    if (options.paths !== undefined) {
        return { ok: true, value: lines.length > 0 };
    }
    // Column 1 is the index; column 2 the worktree (counted only for -a).
    const staged = lines.some((line) => line[0] !== " " && line[0] !== "?" && line[0] !== "!");
    const tracked = lines.some((line) => line[1] !== " " && line[1] !== "?" && line[1] !== "!");
    return { ok: true, value: staged || (options.all === true && tracked) };
}

function commitIdentity(
    options: CommitIdentityOptions,
): { ok: true; trailer: string; env: Record<string, string> } | GitWriteFailure {
    const agent = options.agent ?? DEFAULT_AGENT_NAME;
    if (typeof agent !== "string" || agent.trim().length === 0 || /[\r\n]/.test(agent)) {
        return fail("invalid-argument", "agent must be a non-empty single-line name.");
    }

    const env: Record<string, string> = {};
    const author = options.author;
    const committer = options.committer ?? options.author;
    for (const [role, identity] of [["AUTHOR", author], ["COMMITTER", committer]] as const) {
        if (identity === undefined) {
            continue;
        }
        if (!isValidIdentity(identity)) {
            return fail("invalid-argument", `Invalid ${role.toLowerCase()} identity.`);
        }
        env[`GIT_${role}_NAME`] = identity.name;
        env[`GIT_${role}_EMAIL`] = identity.email;
    }
    return { ok: true, trailer: `${TYR_TRAILER_KEY}: ${agent.trim()}`, env };
}

function isValidIdentity(identity: GitIdentity): boolean {
    const bad = /[\r\n<>]/;
    return (
        typeof identity.name === "string" &&
        typeof identity.email === "string" &&
        identity.name.trim().length > 0 &&
        identity.email.trim().length > 0 &&
        !bad.test(identity.name) &&
        !bad.test(identity.email)
    );
}

/* -------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------- */

function fail(reason: GitWriteFailureReason, message: string, stderr?: string): GitWriteFailure {
    const failure: GitWriteFailure = { ok: false, reason, message };
    if (stderr !== undefined && stderr.trim().length > 0) {
        failure.stderr = stderr.trim();
    }
    return failure;
}

function gitFailure(result: GitResult, what: string): GitWriteFailure {
    return result.timedOut
        ? fail("timeout", `${what} timed out.`, result.stderr)
        : fail("git-failed", `${what} failed.`, result.stderr);
}

async function runAll(
    root: string,
    commands: string[][],
    options: WriteOptions,
    env?: Record<string, string>,
): Promise<GitWriteFailure | null> {
    for (const command of commands) {
        const result = await runGit(root, command, { timeoutMs: options.timeoutMs ?? GIT_WRITE_TIMEOUT_MS, env });
        if (!result.ok) {
            return gitFailure(result, `git ${command[0]}`);
        }
    }
    return null;
}

async function listWorktrees(root: string): Promise<Array<{ path: string; branch: string | null }> | null> {
    const result = await runGit(root, ["worktree", "list", "--porcelain"]);
    if (!result.ok) {
        return null;
    }
    const entries: Array<{ path: string; branch: string | null }> = [];
    for (const line of result.stdout.split("\n")) {
        if (line.startsWith("worktree ")) {
            entries.push({ path: await realpathOfNearestAncestor(line.slice("worktree ".length)), branch: null });
        } else if (line.startsWith("branch ") && entries.length > 0) {
            entries[entries.length - 1].branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
        }
    }
    return entries;
}

async function pathExists(target: string): Promise<boolean> {
    try {
        await fs.lstat(target);
        return true;
    } catch {
        return false;
    }
}

/** A refusal message when `target` exists and is not an empty directory. */
async function pathOccupied(target: string): Promise<string | null> {
    try {
        const stat = await fs.lstat(target);
        if (!stat.isDirectory()) {
            return `${target} already exists and is not a directory.`;
        }
        const entries = await fs.readdir(target);
        return entries.length > 0 ? `${target} already exists and is not empty.` : null;
    } catch {
        return null;
    }
}

/**
 * Canonicalize a path that may not exist yet: realpath the deepest existing
 * ancestor (resolving symlinks such as macOS's /tmp -> /private/tmp) and
 * re-append the rest.
 */
async function realpathOfNearestAncestor(target: string): Promise<string> {
    let current = path.resolve(target);
    const rest: string[] = [];
    for (;;) {
        try {
            return path.join(await fs.realpath(current), ...rest);
        } catch {
            const parent = path.dirname(current);
            if (parent === current) {
                return path.resolve(target);
            }
            rest.unshift(path.basename(current));
            current = parent;
        }
    }
}

function isWithin(child: string, parent: string): boolean {
    const relative = path.relative(parent, child);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
