// The one place Tyr spawns git. Every git module (detection, diffs, history,
// watching, write operations) goes through `runGit`, so the safety rules live
// here once: argv-only (no shell, so branch names and paths cannot be
// injected), time-limited, output-bounded, and total — every failure comes
// back as `ok: false` instead of a throw.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// A hung git (credential prompt, lock contention, unreachable remote) must
// never wedge Tyr, so every invocation is capped.
export const GIT_TIMEOUT_MS = 5000;

// Status and diff output on a huge working tree can be sizeable; bounded but
// generous.
export const GIT_MAX_BUFFER = 16 * 1024 * 1024;

// Unit separator + record separator. A *multi-char* delimiter built from two
// ASCII control codes cannot realistically occur inside a commit subject, so
// pretty-format records stay parseable no matter what people type.
export const FIELD_DELIM = "\u001f\u001e";
export const COMMIT_FORMAT = ["%H", "%h", "%s", "%an", "%aI"].join("%x1f%x1e");

export interface GitResult {
    ok: boolean;
    stdout: string;
    /** git's stderr, for callers that need to explain a failure. */
    stderr: string;
    /** True when git was killed for exceeding its time limit. */
    timedOut: boolean;
    /** True when output exceeded `maxBuffer` and was cut off. */
    truncated: boolean;
}

export interface RunGitOptions {
    /** Override the default time limit, in milliseconds. */
    timeoutMs?: number;
    /** Override the default output cap, in bytes. */
    maxBuffer?: number;
    /** Extra environment variables layered over `process.env`. */
    env?: Record<string, string>;
}

/**
 * Run git with an argv array and normalize every failure into `ok: false`.
 * Also sets `GIT_TERMINAL_PROMPT=0` so a credential prompt fails fast instead
 * of burning the whole timeout.
 */
export async function runGit(
    root: string,
    args: string[],
    options: RunGitOptions = {},
): Promise<GitResult> {
    try {
        const { stdout, stderr } = await execFileAsync("git", args, {
            cwd: root,
            timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
            maxBuffer: options.maxBuffer ?? GIT_MAX_BUFFER,
            encoding: "utf8",
            windowsHide: true,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.env },
        });
        return { ok: true, stdout: stdout.toString(), stderr: stderr.toString(), timedOut: false, truncated: false };
    } catch (error) {
        // git exits non-zero for plenty of perfectly normal situations (not a
        // repo, no commits yet, no upstream), and ENOENT means git isn't even
        // installed. None of those are errors for us.
        const failure = error as {
            stdout?: string | Buffer;
            stderr?: string | Buffer;
            killed?: boolean;
            signal?: string | null;
            code?: string | number;
        } | null;
        return {
            ok: false,
            stdout: failure?.stdout === undefined ? "" : failure.stdout.toString(),
            stderr: failure?.stderr === undefined ? "" : failure.stderr.toString(),
            // execFile kills the child with SIGTERM when the timeout fires.
            timedOut: failure?.killed === true && failure.signal === "SIGTERM",
            truncated: failure?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        };
    }
}
