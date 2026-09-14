// Git detection for `tyr init`.
//
// Everything here shells out to the real `git` binary, so Tyr picks up no new
// npm dependency. Every export is *total*: a missing git binary, a plain
// directory, or a freshly `git init`ed repo with zero commits are all normal
// inputs that resolve to the documented empty/null value. Nothing in this
// module throws and nothing prints — the caller owns all user-facing output.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { GitCommit, GitInfo, GitRemote, GitStatus } from "./types.js";

const execFileAsync = promisify(execFile);

// A hung git (credential prompt, lock contention, unreachable remote) must
// never wedge `tyr init`, so every invocation is capped.
const GIT_TIMEOUT_MS = 5000;

// Status output on a huge working tree can be sizeable; bounded but generous.
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

// Unit separator + record separator. A *multi-char* delimiter built from two
// ASCII control codes cannot realistically occur inside a commit subject, so
// pretty-format records stay parseable no matter what people type.
const FIELD_DELIM = "\u001f\u001e";
const COMMIT_FORMAT = ["%H", "%h", "%s", "%an", "%aI"].join("%x1f%x1e");

// Porcelain v1 two-letter codes that mean "unmerged path".
const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

// C-style escapes porcelain v1 emits inside a quoted path, mapped to bytes.
const SIMPLE_ESCAPES: Record<string, number> = {
    "\\": 0x5c,
    "\"": 0x22,
    a: 0x07,
    b: 0x08,
    f: 0x0c,
    n: 0x0a,
    r: 0x0d,
    t: 0x09,
    v: 0x0b,
};

interface GitResult {
    ok: boolean;
    stdout: string;
}

/**
 * Run git with an argv array (never a shell string, so branch names and paths
 * cannot be shell-injected) and normalize every failure into `ok: false`.
 */
async function runGit(root: string, args: string[]): Promise<GitResult> {
    try {
        const { stdout } = await execFileAsync("git", args, {
            cwd: root,
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: GIT_MAX_BUFFER,
            encoding: "utf8",
            windowsHide: true,
        });
        return { ok: true, stdout: stdout.toString() };
    } catch (error) {
        // git exits non-zero for plenty of perfectly normal situations (not a
        // repo, no commits yet, no upstream), and ENOENT means git isn't even
        // installed. None of those are errors for us.
        const stdout = (error as { stdout?: string | Buffer } | null)?.stdout;
        return { ok: false, stdout: stdout === undefined ? "" : stdout.toString() };
    }
}

/* -------------------------------------------------------------------------
 * Repository / branch
 * ---------------------------------------------------------------------- */

export async function isGitRepository(root: string): Promise<boolean> {
    const result = await runGit(root, ["rev-parse", "--is-inside-work-tree"]);
    // Check the printed answer too: inside a bare repo the command succeeds
    // but answers "false".
    return result.ok && result.stdout.trim() === "true";
}

export async function getCurrentBranch(
    root: string,
): Promise<{ branch: string | null; detached: boolean }> {
    // `--show-current` is the only form that still names an *unborn* branch on
    // a fresh `git init`, and it prints nothing when HEAD is detached.
    const current = await runGit(root, ["branch", "--show-current"]);
    const currentName = current.stdout.trim();
    if (current.ok && currentName.length > 0) {
        return { branch: currentName, detached: false };
    }

    const abbrev = await runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const abbrevName = abbrev.stdout.trim();
    if (!abbrev.ok || abbrevName.length === 0) {
        return { branch: null, detached: false };
    }
    if (abbrevName !== "HEAD") {
        // git < 2.22 has no `--show-current`; this is the attached-branch case.
        return { branch: abbrevName, detached: false };
    }

    // A literal "HEAD" means detached. A tag name or short hash is far more
    // useful to display than nothing, so resolve a label when we can.
    return { branch: await describeDetachedHead(root), detached: true };
}

async function describeDetachedHead(root: string): Promise<string | null> {
    const exact = await runGit(root, ["describe", "--all", "--exact-match", "HEAD"]);
    const label = exact.stdout.trim();
    if (exact.ok && label.length > 0) {
        // `--all` prefixes the ref namespace ("tags/v1.0"); drop it for display.
        return label.replace(/^(?:tags|heads|remotes)\//, "");
    }

    const short = await runGit(root, ["rev-parse", "--short", "HEAD"]);
    const hash = short.stdout.trim();
    return short.ok && hash.length > 0 ? hash : null;
}

/* -------------------------------------------------------------------------
 * HEAD commit
 * ---------------------------------------------------------------------- */

export async function getHeadCommit(root: string): Promise<GitCommit | null> {
    // One call, one record. %aI is already ISO-8601, so no date parsing here.
    const result = await runGit(root, ["log", "-1", `--pretty=format:${COMMIT_FORMAT}`]);
    if (!result.ok) {
        // Expected on a repo with no commits — `git log` has nothing to show.
        return null;
    }

    const parts = result.stdout.trim().split(FIELD_DELIM);
    if (parts.length < 5) {
        return null;
    }

    // Fields are read from both ends so that a subject somehow containing the
    // delimiter rejoins instead of shifting author/date out of position.
    const hash = parts[0].trim();
    const shortHash = parts[1].trim();
    const subject = parts.slice(2, parts.length - 2).join(FIELD_DELIM);
    const author = parts[parts.length - 2];
    const date = parts[parts.length - 1].trim();
    if (hash.length === 0) {
        return null;
    }

    return { hash, shortHash, subject, author, date };
}

/* -------------------------------------------------------------------------
 * Working-tree status
 * ---------------------------------------------------------------------- */

export async function getStatus(root: string): Promise<GitStatus | null> {
    const result = await runGit(root, [
        "status",
        "--porcelain=v1",
        "--branch",
        "--untracked-files=all",
    ]);
    if (!result.ok) {
        return null;
    }

    const staged: string[] = [];
    const modified: string[] = [];
    const untracked: string[] = [];
    const conflicted: string[] = [];
    let ahead: number | null = null;
    let behind: number | null = null;

    for (const line of result.stdout.split("\n")) {
        if (line.length === 0) {
            continue;
        }
        if (line.startsWith("##")) {
            const tracking = parseBranchLine(line);
            ahead = tracking.ahead;
            behind = tracking.behind;
            continue;
        }
        if (line.length < 4) {
            continue;
        }

        // Layout is exactly `XY<space><path>`: X is the index (staged) state,
        // Y the worktree state.
        const code = line.slice(0, 2);
        const filePath = extractPath(line.slice(3));
        if (filePath.length === 0) {
            continue;
        }

        if (code === "??") {
            untracked.push(filePath);
            continue;
        }
        if (code === "!!") {
            continue; // Ignored files; only ever present with --ignored.
        }
        if (CONFLICT_CODES.has(code)) {
            // Unmerged paths are reported on their own, never double-counted
            // as staged or modified.
            conflicted.push(filePath);
            continue;
        }

        // A file can legitimately be both (e.g. "MM": a staged edit plus a
        // newer unstaged one), so these are independent checks, not a chain.
        if (code[0] !== " " && code[0] !== "?") {
            staged.push(filePath);
        }
        if (code[1] !== " " && code[1] !== "?") {
            modified.push(filePath);
        }
    }

    return {
        clean:
            staged.length === 0 &&
            modified.length === 0 &&
            untracked.length === 0 &&
            conflicted.length === 0,
        staged,
        modified,
        untracked,
        conflicted,
        ahead,
        behind,
    };
}

function parseBranchLine(line: string): { ahead: number | null; behind: number | null } {
    // `## main...origin/main [ahead 2, behind 1]`. Without the `...` segment
    // there is no upstream, and ahead/behind are undefined rather than zero.
    // (Ref names may not contain "..", so the separator is unambiguous.)
    if (!line.includes("...")) {
        return { ahead: null, behind: null };
    }

    let ahead = 0;
    let behind = 0;
    const bracket = line.lastIndexOf("[");
    if (bracket !== -1) {
        const divergence = line.slice(bracket);
        const aheadMatch = /ahead (\d+)/.exec(divergence);
        const behindMatch = /behind (\d+)/.exec(divergence);
        if (aheadMatch !== null) {
            ahead = Number(aheadMatch[1]);
        }
        if (behindMatch !== null) {
            behind = Number(behindMatch[1]);
        }
    }
    return { ahead, behind };
}

function extractPath(field: string): string {
    // Renames and copies read `old -> new`; we record the destination. Using
    // the last arrow keeps us correct if the source path contains one.
    const arrow = field.lastIndexOf(" -> ");
    return unquotePath(arrow === -1 ? field : field.slice(arrow + 4));
}

/**
 * Porcelain v1 C-quotes any path with spaces, quotes, or non-ASCII bytes.
 * Strip the wrapping quotes and undo the escaping; octal escapes are raw UTF-8
 * bytes, so they are collected and decoded together rather than one at a time.
 */
function unquotePath(raw: string): string {
    const value = raw.trim();
    if (value.length < 2 || !value.startsWith("\"") || !value.endsWith("\"")) {
        return value;
    }

    const body = value.slice(1, -1);
    const bytes: number[] = [];
    for (let i = 0; i < body.length; i++) {
        if (body[i] !== "\\") {
            bytes.push(...Buffer.from(body[i], "utf8"));
            continue;
        }

        const next = body[i + 1];
        if (next !== undefined && next in SIMPLE_ESCAPES) {
            bytes.push(SIMPLE_ESCAPES[next]);
            i += 1;
            continue;
        }

        const octal = body.slice(i + 1, i + 4);
        if (/^[0-7]{3}$/.test(octal)) {
            bytes.push(parseInt(octal, 8));
            i += 3;
        } else {
            bytes.push(0x5c); // Lone backslash; keep it verbatim.
        }
    }

    return Buffer.from(bytes).toString("utf8");
}

/* -------------------------------------------------------------------------
 * Remotes
 * ---------------------------------------------------------------------- */

export async function getRemotes(root: string): Promise<GitRemote[]> {
    const result = await runGit(root, ["remote", "-v"]);
    if (!result.ok) {
        return [];
    }

    // `git remote -v` prints one line per direction, so collapse the (fetch)
    // and (push) lines of a remote into a single entry, keeping git's order.
    const remotes = new Map<string, GitRemote>();
    for (const line of result.stdout.split("\n")) {
        const match = /^(\S+)\s+(.*)\s+\((fetch|push)\)$/.exec(line.trim());
        if (match === null) {
            continue;
        }

        const name = match[1];
        const url = match[2].trim();
        const entry = remotes.get(name) ?? { name, fetchUrl: null, pushUrl: null };
        if (match[3] === "fetch") {
            entry.fetchUrl = url;
        } else {
            entry.pushUrl = url;
        }
        remotes.set(name, entry);
    }

    return [...remotes.values()];
}

/* -------------------------------------------------------------------------
 * Orchestration
 * ---------------------------------------------------------------------- */

export async function collectGitInfo(root: string): Promise<GitInfo> {
    if (!(await isGitRepository(root))) {
        return {
            isRepo: false,
            branch: null,
            detached: false,
            headCommit: null,
            status: null,
            remotes: [],
            defaultRemote: null,
        };
    }

    // None of these lookups feed each other, so run them together instead of
    // paying for five serial subprocess round trips.
    const [branchInfo, headCommit, status, remotes, upstreamRemote] = await Promise.all([
        getCurrentBranch(root),
        getHeadCommit(root),
        getStatus(root),
        getRemotes(root),
        getUpstreamRemoteName(root),
    ]);

    return {
        isRepo: true,
        branch: branchInfo.branch,
        detached: branchInfo.detached,
        headCommit,
        status,
        remotes,
        defaultRemote: resolveDefaultRemote(remotes, upstreamRemote),
    };
}

async function getUpstreamRemoteName(root: string): Promise<string | null> {
    // Yields e.g. "origin/main"; fails (normally) when the current branch has
    // no upstream configured.
    const result = await runGit(root, ["rev-parse", "--abbrev-ref", "@{upstream}"]);
    const value = result.stdout.trim();
    if (!result.ok || value.length === 0) {
        return null;
    }

    const slash = value.indexOf("/");
    return slash === -1 ? null : value.slice(0, slash);
}

function resolveDefaultRemote(remotes: GitRemote[], upstreamRemote: string | null): string | null {
    // Prefer the remote the current branch actually tracks, but only when it
    // is one we know about — a branch can track a raw URL or a stale name.
    if (upstreamRemote !== null && remotes.some((remote) => remote.name === upstreamRemote)) {
        return upstreamRemote;
    }
    if (remotes.some((remote) => remote.name === "origin")) {
        return "origin";
    }
    return remotes.length > 0 ? remotes[0].name : null;
}
