// cli/agents/safety.ts — what an agent may do, and where (PLANNING 2.14).
//
// Four pieces, all used by whoever starts an agent run (tyr run, the daemon):
//
//   1. Permission gate (`createGate`): every tool call is checked against the
//      role's permission ceiling and a path policy, and every proposed change
//      goes through an approval step (ask a human, auto-approve, or refuse).
//      Every decision is recorded so the run record can show what happened.
//   2. Run defaults (`resolveRunSafety`): turns CLI flags into the safety
//      fields of AgentRunOptions. Dry-run unless the caller explicitly applies.
//   3. Worktree isolation (`createAgentWorktree` and friends): a fresh branch
//      `tyr/<role>-<timestamp>` checked out under `.tyr/worktrees/`, optionally
//      seeded with the user's uncommitted changes. The user's working tree and
//      current branch are never touched.
//   4. A terminal prompter (`createTerminalPrompter`) for approval "ask", which
//      refuses instead of blocking whenever nobody can answer (daemon, CI,
//      piped stdin).
//
// Conventions (see cli/engine/ENGINE.md): nothing here prints except the
// terminal prompter's question, nothing throws for normal conditions, and git,
// clocks and prompters are injectable.

import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runGit, type GitResult, type RunGitOptions } from "../core/git-exec.js";
import { withRepoLock } from "../core/git-write.js";
import { TYR_DIR_NAME } from "../core/scaffold.js";
import { canPrompt, confirm, type PromptIO } from "../ui/prompt.js";
import {
    PERMISSION_ORDER,
    type AgentRole,
    type AgentRoleId,
    type AgentRunOptions,
    type GateDecision,
    type PermissionGate,
    type PermissionLevel,
    type ProposedChange,
} from "./model.js";

/* -------------------------------------------------------------------------
 * Path policy
 * ---------------------------------------------------------------------- */

/**
 * Paths an agent may not touch at all, not even read: their contents are
 * secrets that must never reach a model. Matched case-insensitively against
 * the workspace-relative path; a pattern without "/" matches the file name at
 * any depth, a pattern with "/" matches from the workspace root. `*` matches
 * within one path segment.
 */
export const SECRET_PATHS: readonly string[] = [
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    "id_rsa*",
    "id_ed25519*",
    "id_ecdsa*",
    ".npmrc",
    ".pypirc",
    ".netrc",
];

/**
 * Paths an agent may read but never write by default: tool and editor
 * configuration that changes how other tools behave, and lockfiles (a fixer
 * that "fixes" a build by rewriting a lockfile is making a dependency change
 * nobody asked for). Same matching rules as SECRET_PATHS. A caller can lift
 * individual entries with `allowPaths` (e.g. a dependency-update task that
 * legitimately touches package-lock.json); SECRET_PATHS, `.git/`, `.tyr/` and
 * paths outside the workspace can never be lifted.
 */
export const DEFAULT_PROTECTED_PATHS: readonly string[] = [
    ".claude/settings.json",
    ".claude/settings.local.json",
    ".gitmodules",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lockb",
    "bun.lock",
    "Cargo.lock",
    "poetry.lock",
    "Pipfile.lock",
    "uv.lock",
    "Gemfile.lock",
    "composer.lock",
    "go.sum",
];

/** Directory names no agent may write into, at any depth. `.git` may not even be read. */
const GIT_DIR = ".git";

export interface GateOptions {
    /** The role's permission ceiling; anything above it is denied. */
    ceiling: PermissionLevel;
    /** The directory the agent works in (repo root or isolated worktree). */
    workspace: string;
    /** How proposed changes are approved. */
    approval: AgentRunOptions["approval"];
    /**
     * Dry-run: write tools describe changes instead of making them, so
     * `approve()` always allows (there is nothing to approve yet) after the
     * path policy has been checked. Nothing is ever prompted in dry-run.
     */
    dryRun: boolean;
    /**
     * Asks a human about one change. Defaults to `createTerminalPrompter()`,
     * which refuses without a terminal. A prompter that throws counts as "no".
     */
    prompter?: (change: ProposedChange) => Promise<boolean>;
    /** Extra write-protected patterns, added to DEFAULT_PROTECTED_PATHS. */
    protectedPaths?: readonly string[];
    /** Entries of the protected lists to lift (exact pattern or path match). */
    allowPaths?: readonly string[];
    /** Called with every decision as it is made (the run record subscribes). */
    onDecision?: (decision: SafetyDecision) => void;
    /** Clock for decision timestamps. */
    now?: () => Date;
}

/** One recorded gate decision. */
export interface SafetyDecision {
    /** ISO timestamp. */
    at: string;
    kind: "check" | "approve";
    tool: string;
    permission?: PermissionLevel;
    /** Workspace-relative path (forward slashes) when the call named one. */
    path?: string;
    /** The change summary, for approvals. */
    summary?: string;
    allowed: boolean;
    reason?: string;
    /** For approvals: how it was decided. */
    via?: "dry-run" | "auto" | "prompt" | "deny" | "policy";
}

/** A PermissionGate that also exposes its audit log. */
export interface SafetyGate extends PermissionGate {
    /** Every decision so far, oldest first. */
    readonly decisions: readonly SafetyDecision[];
}

export type PathVerdict =
    | { ok: true; relative: string; absolute: string }
    | { ok: false; reason: string; relative?: string };

/** Builds the gate for one agent run. */
export function createGate(options: GateOptions): SafetyGate {
    const workspace = realpathLoose(path.resolve(options.workspace));
    const writeProtected = [...DEFAULT_PROTECTED_PATHS, ...(options.protectedPaths ?? [])];
    const allow = new Set((options.allowPaths ?? []).map((entry) => toSlashes(entry).toLowerCase()));
    const prompter = options.prompter ?? createTerminalPrompter();
    const now = options.now ?? (() => new Date());
    const decisions: SafetyDecision[] = [];
    // One question at a time: two tool calls racing must not interleave prompts.
    let promptQueue: Promise<unknown> = Promise.resolve();

    const record = (decision: Omit<SafetyDecision, "at">): GateDecision => {
        const entry: SafetyDecision = { at: now().toISOString(), ...decision };
        decisions.push(entry);
        try {
            options.onDecision?.(entry);
        } catch {
            // An observer failing must never change a safety decision.
        }
        return entry.allowed ? { allowed: true } : { allowed: false, reason: entry.reason ?? "denied" };
    };

    const evaluate = (
        permission: PermissionLevel,
        target: string | undefined,
    ): { allowed: true; relative?: string } | { allowed: false; reason: string; relative?: string } => {
        const level = PERMISSION_ORDER.indexOf(permission);
        if (level === -1) return { allowed: false, reason: `unknown permission "${String(permission)}"` };
        if (level > PERMISSION_ORDER.indexOf(options.ceiling)) {
            return { allowed: false, reason: `${permission} exceeds this role's ceiling (${options.ceiling})` };
        }
        if (target === undefined) return { allowed: true };

        const verdict = resolveWorkspacePath(workspace, target);
        if (!verdict.ok) return { allowed: false, reason: verdict.reason, relative: verdict.relative };
        const relative = verdict.relative;
        const segments = relative.toLowerCase().split("/");

        if (segments.includes(GIT_DIR)) {
            return { allowed: false, reason: `${relative} is inside a .git directory`, relative };
        }
        if (matchesAny(relative, SECRET_PATHS)) {
            return { allowed: false, reason: `${relative} may contain secrets`, relative };
        }
        if (permission === "write") {
            if (segments.includes(TYR_DIR_NAME)) {
                return { allowed: false, reason: `${relative} is inside Tyr's own ${TYR_DIR_NAME}/ directory`, relative };
            }
            const hit = writeProtected.find((pattern) => matchesPattern(relative, pattern));
            if (hit !== undefined && !allow.has(hit.toLowerCase()) && !allow.has(relative.toLowerCase())) {
                return { allowed: false, reason: `${relative} is protected (${hit})`, relative };
            }
        }
        return { allowed: true, relative };
    };

    return {
        get decisions() {
            return decisions;
        },

        check(tool, permission, target) {
            const result = evaluate(permission, target);
            return record({
                kind: "check",
                tool,
                permission,
                path: result.relative ?? (target === undefined ? undefined : toSlashes(target)),
                allowed: result.allowed,
                reason: result.allowed ? undefined : result.reason,
                via: "policy",
            });
        },

        async approve(change) {
            // Defense in depth: a write tool that skipped check() still cannot
            // get a protected or out-of-workspace path approved.
            const base = { kind: "approve" as const, tool: change.tool, permission: "write" as const, summary: change.summary };
            const policy = evaluate("write", change.path);
            const pathField = policy.relative ?? toSlashes(change.path);
            if (!policy.allowed) {
                return record({ ...base, path: pathField, allowed: false, reason: policy.reason, via: "policy" });
            }
            if (options.dryRun) {
                return record({ ...base, path: pathField, allowed: true, reason: "dry-run: nothing is written", via: "dry-run" });
            }
            if (options.approval === "deny") {
                return record({ ...base, path: pathField, allowed: false, reason: "changes are not approved for this run", via: "deny" });
            }
            if (options.approval === "auto") {
                return record({ ...base, path: pathField, allowed: true, via: "auto" });
            }

            const asked = promptQueue.then(async () => {
                try {
                    return (await prompter(change)) === true;
                } catch {
                    return false;
                }
            });
            promptQueue = asked;
            const yes = await asked;
            return record({
                ...base,
                path: pathField,
                allowed: yes,
                reason: yes ? undefined : "change was not approved",
                via: "prompt",
            });
        },
    };
}

/**
 * Resolves `target` (relative to the workspace, or absolute; either slash
 * style) and refuses anything that lands outside the workspace, including via
 * `..`, another drive, a UNC path, or a symlink pointing out. Exported for
 * tools that need the absolute path after the gate said yes.
 */
export function resolveWorkspacePath(workspace: string, target: string): PathVerdict {
    if (typeof target !== "string" || target.trim() === "") return { ok: false, reason: "empty path" };
    if (target.includes("\0")) return { ok: false, reason: "path contains a NUL byte" };

    const root = realpathLoose(path.resolve(workspace));
    // Backslashes are separators everywhere: on POSIX `..\\x` must not slip
    // through as an odd file name that some later tool reinterprets.
    const slashed = toSlashes(target);
    const windowsAbsolute = /^[a-zA-Z]:/.test(slashed) || slashed.startsWith("//");
    if (windowsAbsolute && process.platform !== "win32") {
        return { ok: false, reason: `${slashed} is outside the workspace` };
    }
    // `C:foo` (drive-relative) resolves against that drive's cwd: never inside.
    if (/^[a-zA-Z]:(?!\/)/.test(slashed)) return { ok: false, reason: `${slashed} is a drive-relative path` };

    const absolute = path.resolve(root, slashed);
    const real = realpathLoose(absolute);
    const relative = path.relative(root, real);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        return { ok: false, reason: `${slashed} is outside the workspace` };
    }
    if (relative === "") return { ok: false, reason: "path is the workspace itself", relative: "." };
    return { ok: true, relative: toSlashes(relative), absolute: real };
}

/** True when `relative` (workspace-relative, forward slashes) matches a protected pattern. */
export function matchesPattern(relative: string, pattern: string): boolean {
    const subject = toSlashes(relative).replace(/^\.\//, "").toLowerCase();
    const normalized = toSlashes(pattern).replace(/^\.?\//, "").toLowerCase();
    const regex = globToRegExp(normalized);
    if (normalized.includes("/")) return regex.test(subject);
    const base = subject.slice(subject.lastIndexOf("/") + 1);
    return regex.test(base);
}

function matchesAny(relative: string, patterns: readonly string[]): boolean {
    return patterns.some((pattern) => matchesPattern(relative, pattern));
}

function globToRegExp(glob: string): RegExp {
    const body = glob
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*");
    return new RegExp(`^${body}$`);
}

function toSlashes(value: string): string {
    return value.replace(/\\/g, "/");
}

/**
 * realpath of the nearest existing ancestor, with the missing tail re-joined,
 * so a file that does not exist yet is still judged by where its directory
 * really is (a symlinked directory pointing outside is caught).
 */
function realpathLoose(target: string): string {
    let current = target;
    const rest: string[] = [];
    for (;;) {
        try {
            return path.join(fsSync.realpathSync.native(current), ...rest);
        } catch {
            const parent = path.dirname(current);
            if (parent === current) return target;
            rest.unshift(path.basename(current));
            current = parent;
        }
    }
}

/* -------------------------------------------------------------------------
 * Terminal prompter
 * ---------------------------------------------------------------------- */

/** Lines of a patch shown in the approval question before it is cut off. */
export const PROMPT_PATCH_LINES = 40;

export interface TerminalPrompterOptions extends PromptIO {
    /** Whether someone can answer. Defaults to `canPrompt()` (TTY on both ends, not CI). */
    isInteractive?: () => boolean;
}

/**
 * The default approval prompter: shows the change (summary plus the start of
 * the patch) and asks y/N. Without a terminal it answers "no" immediately, so
 * the daemon, CI or a piped run can never block on a question.
 */
export function createTerminalPrompter(options: TerminalPrompterOptions = {}): (change: ProposedChange) => Promise<boolean> {
    const interactive = options.isInteractive ?? (() => canPrompt());
    return async (change) => {
        if (!interactive()) return false;
        return confirm(formatApprovalQuestion(change), false, { input: options.input, output: options.output });
    };
}

/** The question text for one change. Pure, so its wording is testable. */
export function formatApprovalQuestion(change: ProposedChange): string {
    const lines = [`${change.tool} wants to change ${change.path}: ${change.summary}`];
    if (change.patch !== undefined && change.patch.trim() !== "") {
        const patchLines = change.patch.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
        lines.push(...patchLines.slice(0, PROMPT_PATCH_LINES));
        if (patchLines.length > PROMPT_PATCH_LINES) {
            lines.push(`... (${patchLines.length - PROMPT_PATCH_LINES} more lines)`);
        }
    }
    lines.push("Apply this change?");
    return lines.join("\n");
}

/* -------------------------------------------------------------------------
 * Run defaults
 * ---------------------------------------------------------------------- */

export interface RunSafetyInput {
    /** The role, or just its id and permission ceiling. */
    role: Pick<AgentRole, "id" | "permission">;
    /** `--apply`: actually make changes. Without it every run is a dry-run. */
    apply?: boolean;
    /** `--yes`: approve changes without asking. */
    yes?: boolean;
    /** `--isolate`: work in a fresh worktree on a new branch. */
    isolate?: boolean;
    /** Whether a human can answer prompts (see `canPrompt`). */
    interactive: boolean;
}

export type RunSafety = Pick<AgentRunOptions, "dryRun" | "isolate" | "approval"> & {
    /** One line explaining the outcome, for the run record and --verbose. */
    explanation: string;
};

/**
 * The safety policy for one run. First matching row wins:
 *
 *   role ceiling   --apply  --isolate  --yes  interactive | dryRun  isolate  approval
 *   ------------   -------  ---------  -----  ----------- | ------  -------  --------
 *   read/execute   any      any        any    any         | true    false    deny
 *   write          no       any        any    any         | true    as given deny
 *   write          yes      yes        any    any         | false   true     auto
 *   write          yes      no         yes    any         | false   false    auto
 *   write          yes      no         no     yes         | false   false    ask
 *   write          yes      no         no     no          | false   false    deny
 *
 * Notes:
 *   - Roles that cannot write have nothing to apply or approve; isolation buys
 *     them nothing either, so they always run in place as a "dry-run".
 *   - A dry-run never writes, so approval is irrelevant; "deny" keeps it that
 *     way if a tool ever ignored dryRun (the gate allows in dry-run only
 *     because tools only describe changes then).
 *   - Isolated runs auto-approve: changes land on a throwaway `tyr/...` branch
 *     in `.tyr/worktrees/`, and the human approval step is reviewing that
 *     branch before merging it. The user's working tree is untouched.
 *   - In place, a human approves each change unless --yes; with nobody to ask
 *     and no --yes the run is refused rather than left waiting.
 */
export function resolveRunSafety(input: RunSafetyInput): RunSafety {
    const canWrite = input.role.permission === "write";
    if (!canWrite) {
        return {
            dryRun: true,
            isolate: false,
            approval: "deny",
            explanation: `${input.role.id} cannot change files; it runs in place without writing`,
        };
    }
    if (input.apply !== true) {
        return {
            dryRun: true,
            isolate: input.isolate === true,
            approval: "deny",
            explanation: "dry-run: changes are described, not made (pass --apply to make them)",
        };
    }
    if (input.isolate === true) {
        return {
            dryRun: false,
            isolate: true,
            approval: "auto",
            explanation: "changes are made on a new tyr/ branch in .tyr/worktrees/ for you to review",
        };
    }
    if (input.yes === true) {
        return { dryRun: false, isolate: false, approval: "auto", explanation: "changes are applied in place without asking (--yes)" };
    }
    if (input.interactive) {
        return { dryRun: false, isolate: false, approval: "ask", explanation: "each change is shown for approval before it is applied" };
    }
    return {
        dryRun: false,
        isolate: false,
        approval: "deny",
        explanation: "no terminal to approve changes: pass --yes or --isolate to apply them",
    };
}

/* -------------------------------------------------------------------------
 * Worktree isolation
 * ---------------------------------------------------------------------- */

/** Where agent worktrees live, relative to the project root. */
export const AGENT_WORKTREES_DIR = `${TYR_DIR_NAME}/worktrees`;

/** Prefix of every agent branch. */
export const AGENT_BRANCH_PREFIX = "tyr/";

// Checking out a large tree is far slower than git's default read cap.
const WORKTREE_TIMEOUT_MS = 120_000;

export type GitRunner = (root: string, args: string[], options?: RunGitOptions) => Promise<GitResult>;

export interface CreateAgentWorktreeOptions {
    role: AgentRoleId;
    /** Clock for the branch timestamp. */
    now?: () => Date;
    git?: GitRunner;
    /**
     * Copy the user's uncommitted state into the worktree (modified, added,
     * deleted and untracked-but-not-ignored files), so the agent sees what the
     * user sees. The user's own working tree is only read.
     */
    carryChanges?: boolean;
}

export interface CarriedChanges {
    /** Repo-relative paths copied in (modified, added, untracked). */
    copied: string[];
    /** Repo-relative paths deleted in the worktree to match. */
    deleted: string[];
    /** Paths that could not be carried over (submodules, unreadable files). */
    skipped: string[];
}

export interface AgentWorktree {
    /** Absolute path of the worktree's top level. */
    path: string;
    branch: string;
    /** The commit the branch starts from (the user's HEAD). */
    base: string;
    /** The project root's counterpart inside the worktree (differs in monorepos). */
    workspace: string;
    carried?: CarriedChanges;
}

export interface AgentWorktreeEntry {
    path: string;
    branch: string;
    head: string;
}

/**
 * Creates `tyr/<role>-<YYYYMMDD-HHMMSS>` from HEAD, checked out at
 * `<root>/.tyr/worktrees/<role>-<timestamp>`. Only adds a branch and a
 * worktree: never switches the user's branch or touches their files.
 *
 * `.tyr/worktrees/` is kept out of git status by a `.gitignore` containing
 * `*` written inside it (unless something already ignores it), because the
 * generated `.tyr/.gitignore` only covers state/, logs/ and reports/ and the
 * root `.gitignore` may not mention `.tyr/` at all (see root-gitignore.ts).
 */
export async function createAgentWorktree(
    root: string,
    options: CreateAgentWorktreeOptions,
): Promise<AgentWorktree | { error: string }> {
    const git = options.git ?? runGit;
    const now = options.now ?? (() => new Date());
    const projectRoot = realpathLoose(path.resolve(root));

    const repo = await inspect(git, projectRoot);
    if ("error" in repo) return repo;

    return withRepoLock(repo.commonDir, async () => {
        try {
            const head = await git(projectRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
            const base = head.stdout.trim();
            if (!head.ok || base === "") return { error: "The repository has no commits yet; nothing to branch from." };

            const container = path.join(projectRoot, ...AGENT_WORKTREES_DIR.split("/"));
            const ignoreError = await ensureWorktreesIgnored(git, projectRoot, container);
            if (ignoreError !== null) return { error: ignoreError };

            const stamp = formatStamp(now());
            let name = `${options.role}-${stamp}`;
            for (let attempt = 2; ; attempt++) {
                const taken =
                    (await git(projectRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${AGENT_BRANCH_PREFIX}${name}`])).ok ||
                    (await exists(path.join(container, name)));
                if (!taken) break;
                if (attempt > 50) return { error: "Could not find a free branch name for the worktree." };
                name = `${options.role}-${stamp}-${attempt}`;
            }
            const branch = `${AGENT_BRANCH_PREFIX}${name}`;
            const target = path.join(container, name);

            const added = await git(projectRoot, ["worktree", "add", "--no-track", "-b", branch, "--", target, base], {
                timeoutMs: WORKTREE_TIMEOUT_MS,
            });
            if (!added.ok) return { error: `git worktree add failed: ${firstLine(added.stderr) || "unknown error"}` };

            const worktreePath = realpathLoose(target);
            const relativeProject = path.relative(repo.toplevel, projectRoot);
            const result: AgentWorktree = {
                path: worktreePath,
                branch,
                base,
                workspace: relativeProject === "" ? worktreePath : path.join(worktreePath, relativeProject),
            };
            if (options.carryChanges === true) {
                const carried = await carryChanges(git, repo.toplevel, worktreePath);
                if ("error" in carried) {
                    // Leave nothing half-made behind.
                    await git(projectRoot, ["worktree", "remove", "--force", "--", worktreePath], { timeoutMs: WORKTREE_TIMEOUT_MS });
                    await git(projectRoot, ["branch", "-D", branch]);
                    return carried;
                }
                result.carried = carried;
            }
            return result;
        } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) };
        }
    });
}

export interface RemoveAgentWorktreeOptions {
    /** Keep the `tyr/...` branch (and the agent's commits on it). Default true. */
    keepBranch?: boolean;
    /** Remove even when the worktree has uncommitted changes (they are lost). Default false. */
    force?: boolean;
    git?: GitRunner;
}

/**
 * Removes an agent worktree created by `createAgentWorktree`. Refuses any
 * other worktree (including the main one). Without `force`, git refuses a
 * worktree with uncommitted changes and so does this.
 */
export async function removeAgentWorktree(
    root: string,
    worktreePath: string,
    options: RemoveAgentWorktreeOptions = {},
): Promise<{ removed: true; path: string; branch: string; branchDeleted: boolean } | { error: string }> {
    const git = options.git ?? runGit;
    const projectRoot = realpathLoose(path.resolve(root));
    const repo = await inspect(git, projectRoot);
    if ("error" in repo) return repo;

    return withRepoLock(repo.commonDir, async () => {
        const entries = await listAgentWorktrees(projectRoot, { git });
        if ("error" in entries) return entries;
        const wanted = realpathLoose(path.resolve(projectRoot, worktreePath));
        const entry = entries.find((candidate) => samePath(candidate.path, wanted));
        if (entry === undefined) return { error: `${worktreePath} is not a Tyr agent worktree.` };

        const args = ["worktree", "remove", ...(options.force === true ? ["--force"] : []), "--", entry.path];
        const removed = await git(projectRoot, args, { timeoutMs: WORKTREE_TIMEOUT_MS });
        if (!removed.ok) {
            const detail = firstLine(removed.stderr);
            return /modified or untracked|locked/.test(removed.stderr)
                ? { error: "The worktree has uncommitted changes or is locked; it was left in place." }
                : { error: `git worktree remove failed: ${detail || "unknown error"}` };
        }
        let branchDeleted = false;
        if (options.keepBranch === false) {
            // The prefix check above means the name cannot start with "-".
            branchDeleted = (await git(projectRoot, ["branch", "-D", entry.branch])).ok;
        }
        return { removed: true as const, path: entry.path, branch: entry.branch, branchDeleted };
    });
}

/** Agent worktrees of the repository: under `.tyr/worktrees/` and on a `tyr/` branch. */
export async function listAgentWorktrees(
    root: string,
    options: { git?: GitRunner } = {},
): Promise<AgentWorktreeEntry[] | { error: string }> {
    const git = options.git ?? runGit;
    const projectRoot = realpathLoose(path.resolve(root));
    const result = await git(projectRoot, ["worktree", "list", "--porcelain"]);
    if (!result.ok) return { error: `Could not list worktrees: ${firstLine(result.stderr) || "not a git repository"}` };

    const container = path.join(projectRoot, ...AGENT_WORKTREES_DIR.split("/"));
    const entries: AgentWorktreeEntry[] = [];
    let current: { path: string; branch: string; head: string } | null = null;
    const flush = () => {
        if (current !== null && current.branch.startsWith(AGENT_BRANCH_PREFIX) && isWithin(current.path, container)) {
            entries.push(current);
        }
        current = null;
    };
    for (const line of result.stdout.split(/\r?\n/)) {
        if (line.startsWith("worktree ")) {
            flush();
            current = { path: realpathLoose(path.resolve(line.slice("worktree ".length))), branch: "", head: "" };
        } else if (current !== null && line.startsWith("HEAD ")) {
            current.head = line.slice("HEAD ".length);
        } else if (current !== null && line.startsWith("branch ")) {
            current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
        }
    }
    flush();
    return entries;
}

/* -------------------------------------------------------------------------
 * Worktree helpers
 * ---------------------------------------------------------------------- */

async function inspect(
    git: GitRunner,
    root: string,
): Promise<{ toplevel: string; commonDir: string } | { error: string }> {
    const result = await git(root, ["rev-parse", "--show-toplevel", "--git-common-dir"]);
    const [toplevel, commonDir] = result.stdout.split(/\r?\n/).map((line) => line.trim());
    if (!result.ok || !toplevel || !commonDir) return { error: `${root} is not inside a git work tree.` };
    return {
        toplevel: realpathLoose(path.resolve(toplevel)),
        commonDir: realpathLoose(path.resolve(root, commonDir)),
    };
}

async function ensureWorktreesIgnored(git: GitRunner, root: string, container: string): Promise<string | null> {
    try {
        await fs.mkdir(container, { recursive: true });
        // A probe path inside the container: ignored means `git status` stays clean.
        const probe = path.relative(root, path.join(container, "probe")).replace(/\\/g, "/");
        const ignored = await git(root, ["check-ignore", "-q", "--", probe]);
        if (ignored.ok) return null;
        await fs.writeFile(path.join(container, ".gitignore"), "# Tyr agent worktrees — never committed.\n*\n", "utf8");
        return null;
    } catch (error) {
        return `Could not prepare ${AGENT_WORKTREES_DIR}: ${error instanceof Error ? error.message : String(error)}`;
    }
}

/**
 * Copies the user's uncommitted state from `source` into `target` file by
 * file. Byte copies rather than `git diff | git apply`: binary files, line
 * endings under core.autocrlf and files the index does not know about all
 * come across exactly as the user has them.
 */
async function carryChanges(git: GitRunner, source: string, target: string): Promise<CarriedChanges | { error: string }> {
    const diff = await git(source, ["diff", "HEAD", "--name-status", "--no-renames", "-z"]);
    if (!diff.ok) return { error: `Could not read uncommitted changes: ${firstLine(diff.stderr) || "git diff failed"}` };
    const untracked = await git(source, ["ls-files", "--others", "--exclude-standard", "-z", "--full-name"]);
    if (!untracked.ok) return { error: `Could not list untracked files: ${firstLine(untracked.stderr) || "git ls-files failed"}` };

    const carried: CarriedChanges = { copied: [], deleted: [], skipped: [] };
    const toCopy: string[] = [];
    const fields = diff.stdout.split("\0").filter((field) => field !== "");
    for (let i = 0; i + 1 < fields.length; i += 2) {
        const status = fields[i];
        const file = fields[i + 1];
        if (status.startsWith("D")) {
            try {
                await fs.rm(path.join(target, file), { force: true });
                carried.deleted.push(file);
            } catch {
                carried.skipped.push(file);
            }
        } else {
            toCopy.push(file);
        }
    }
    const container = `${AGENT_WORKTREES_DIR}/`;
    for (const file of untracked.stdout.split("\0")) {
        if (file === "" || file.startsWith(container) || file.includes(`/${container}`)) continue;
        toCopy.push(file);
    }
    for (const file of toCopy) {
        try {
            const from = path.join(source, file);
            const stat = await fs.lstat(from);
            if (!stat.isFile() && !stat.isSymbolicLink()) {
                carried.skipped.push(file);
                continue;
            }
            const to = path.join(target, file);
            await fs.mkdir(path.dirname(to), { recursive: true });
            await fs.copyFile(from, to);
            carried.copied.push(file);
        } catch {
            carried.skipped.push(file);
        }
    }
    return carried;
}

function formatStamp(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, "0");
    return (
        `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
        `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
    );
}

async function exists(target: string): Promise<boolean> {
    try {
        await fs.lstat(target);
        return true;
    } catch {
        return false;
    }
}

function isWithin(child: string, parent: string): boolean {
    const relative = path.relative(parent, child);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function samePath(a: string, b: string): boolean {
    return path.relative(a, b) === "";
}

function firstLine(text: string): string {
    return text.trim().split(/\r?\n/)[0] ?? "";
}
