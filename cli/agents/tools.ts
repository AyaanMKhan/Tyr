// cli/agents/tools.ts — the tools an agent can call (PLANNING 2.14).
//
//   read_file    read     a file, optionally a line range; size-capped
//   list_files   read     files under a directory, optionally glob-filtered;
//                         honours .gitignore (via git) and Tyr's ignore list
//   search       read     regex over file contents; bounded matches
//   git_diff     read     working tree vs HEAD, optionally one path
//   run_check    execute  a check command from tyr.json (build, test, ...);
//                         never an arbitrary shell command
//   edit_file    write    replace one exact, unique occurrence of a string
//   write_file   write    create or overwrite a file
//
// Every tool:
//   - confines paths to env.workspace: absolute paths outside it, `..`
//     escapes, symlinks that lead out, and anything under .git/ or .tyr/ are
//     refused;
//   - asks env.gate.check(tool, permission, path) before acting;
//   - bounds what it returns to the model;
//   - never throws: failures come back as { content, isError: true }.
//
// Write tools build a ProposedChange with a unified diff. Under env.dryRun
// they record it and answer "would change ..." without touching the disk;
// otherwise they ask env.gate.approve(change) and write only when approved.
// createToolset() gives the caller the list of recorded changes.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { IGNORED_DIRS } from "../core/discovery.js";
import { getDiff } from "../core/git-diff.js";
import { runGit } from "../core/git-exec.js";
import { compileIgnore, loadUserIgnorePatterns, type IgnoreMatcher } from "../core/ignore.js";
import { loadCheckCommands, runCheck, type RunCheckOptions } from "../engine/executor.js";
import { CHECK_KINDS, type CheckKind, type CheckRun } from "../engine/model.js";
import type { AgentTool, PermissionLevel, ProposedChange, ToolEnv, ToolResult } from "./model.js";

/* -------------------------------------------------------------------------
 * Limits
 * ---------------------------------------------------------------------- */

/** Largest file read_file / edit_file will load. */
export const MAX_READ_FILE_BYTES = 2 * 1024 * 1024;
/** Cap on read_file output, in characters (about 15k tokens). */
export const MAX_READ_OUTPUT_CHARS = 60_000;
/** Largest content write_file accepts. */
export const MAX_WRITE_BYTES = 1024 * 1024;
export const DEFAULT_LIST_RESULTS = 500;
export const MAX_LIST_RESULTS = 2_000;
export const DEFAULT_SEARCH_RESULTS = 100;
export const MAX_SEARCH_RESULTS = 500;
/** search skips files larger than this. */
export const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
export const MAX_DIFF_CHARS = 60_000;
/** Bytes of each output stream run_check sends back. */
export const MAX_CHECK_OUTPUT_CHARS = 12_000;
/** Cap on the patch kept in a ProposedChange. */
export const MAX_PATCH_CHARS = 60_000;

export const TOOL_NAMES = [
    "read_file",
    "list_files",
    "search",
    "git_diff",
    "run_check",
    "edit_file",
    "write_file",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/* -------------------------------------------------------------------------
 * Toolset
 * ---------------------------------------------------------------------- */

export interface ToolsetOptions {
    /**
     * Check commands by kind. Default: loadCheckCommands(env.workspace), i.e.
     * tyr.json's commands whose checks.<kind> setting is on.
     */
    loadCommands?: (workspace: string) => Promise<Partial<Record<CheckKind, string>>>;
    /** Runs a check. Default executor.runCheck. */
    runCheck?: (root: string, kind: CheckKind, command: string, opts: RunCheckOptions) => Promise<CheckRun>;
    /** Time limit for run_check. Default the executor's (10 minutes). */
    checkTimeoutMs?: number;
}

export interface Toolset {
    /** Every tool, in TOOL_NAMES order. */
    tools: AgentTool[];
    /** Changes applied (or, in dry-run, proposed) by the write tools, in order. */
    changes: ProposedChange[];
    /** The named tools, in the order given; unknown names are skipped. */
    toolsFor(names: readonly string[]): AgentTool[];
}

/** A fresh set of tools sharing one change list. Use one per agent run. */
export function createToolset(opts: ToolsetOptions = {}): Toolset {
    const changes: ProposedChange[] = [];
    const record = (change: ProposedChange): void => {
        changes.push(change);
    };
    const tools: AgentTool[] = [
        readFileTool(),
        listFilesTool(),
        searchTool(),
        gitDiffTool(),
        runCheckTool(opts),
        editFileTool(record),
        writeFileTool(record),
    ];
    return { tools, changes, toolsFor: (names) => pick(tools, names) };
}

const DEFAULT_TOOLSET = createToolset();

/**
 * Every tool, sharing a module-level toolset whose recorded changes nobody
 * reads. Callers that need the changes use createToolset().
 */
export const ALL_TOOLS: readonly AgentTool[] = DEFAULT_TOOLSET.tools;

/** The named tools from ALL_TOOLS (or `tools`), in the order given; unknown names are skipped. */
export function toolsFor(names: readonly string[], tools: readonly AgentTool[] = ALL_TOOLS): AgentTool[] {
    return pick(tools, names);
}

function pick(tools: readonly AgentTool[], names: readonly string[]): AgentTool[] {
    const out: AgentTool[] = [];
    for (const name of names) {
        const tool = tools.find((t) => t.name === name);
        if (tool !== undefined && !out.includes(tool)) out.push(tool);
    }
    return out;
}

/* -------------------------------------------------------------------------
 * Shared plumbing
 * ---------------------------------------------------------------------- */

type Input = Record<string, unknown>;

function ok(content: string): ToolResult {
    return { content };
}

function fail(content: string): ToolResult {
    return { content, isError: true };
}

/** Wraps a tool body so nothing escapes as an exception. */
function defineTool(
    name: ToolName,
    permission: PermissionLevel,
    description: string,
    inputSchema: Record<string, unknown>,
    body: (input: Input, env: ToolEnv) => Promise<ToolResult>,
): AgentTool {
    return {
        name,
        description,
        inputSchema,
        permission,
        async run(input: unknown, env: ToolEnv): Promise<ToolResult> {
            try {
                if (env.signal?.aborted) return fail("cancelled");
                if (input === null || typeof input !== "object" || Array.isArray(input)) {
                    return fail("input must be a JSON object");
                }
                return await body(input as Input, env);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return fail(`${name} failed: ${message.slice(0, 300)}`);
            }
        },
    };
}

function gateCheck(env: ToolEnv, tool: string, permission: PermissionLevel, rel?: string): ToolResult | null {
    const decision = env.gate.check(tool, permission, rel);
    return decision.allowed ? null : fail(`denied: ${decision.reason}`);
}

function str(input: Input, key: string): string | undefined {
    const value = input[key];
    return typeof value === "string" ? value : undefined;
}

function int(input: Input, key: string): number | undefined {
    const value = input[key];
    return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined;
}

function bool(input: Input, key: string): boolean {
    return input[key] === true;
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value ?? fallback));
}

function cut(text: string, max: number, what = "characters"): string {
    if (text.length <= max) return text;
    return `${text.slice(0, max)}\n[... ${text.length - max} more ${what} cut]`;
}

function looksBinary(buf: Buffer): boolean {
    return buf.subarray(0, 8000).includes(0);
}

async function exists(p: string): Promise<boolean> {
    try {
        await fs.lstat(p);
        return true;
    } catch {
        return false;
    }
}

/* -------------------------------------------------------------------------
 * Path confinement
 * ---------------------------------------------------------------------- */

export interface ConfinedPath {
    /** Absolute path inside the workspace. */
    abs: string;
    /** Workspace-relative, `/` separators; "." for the workspace itself. */
    rel: string;
}

const FORBIDDEN_SEGMENTS = new Set([".git", ".tyr"]);

function isInside(base: string, target: string): boolean {
    const rel = path.relative(base, target);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function sameCase(p: string): string {
    return process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p;
}

/**
 * Resolves a model-supplied path inside `workspace`, or explains why not.
 * Refuses: empty or NUL-containing paths, anything resolving outside the
 * workspace (absolute or via `..`), anything whose nearest existing ancestor
 * resolves (through symlinks) outside it, and any path with a `.git` or
 * `.tyr` segment.
 */
export async function confinePath(workspace: string, input: string): Promise<ConfinedPath | { error: string }> {
    if (typeof input !== "string" || input.trim() === "") return { error: "path is required" };
    if (input.includes("\0")) return { error: "path contains a NUL byte" };
    const base = path.resolve(workspace);
    const abs = path.resolve(base, input);
    if (!isInside(sameCase(base), sameCase(abs))) return { error: `${input} is outside the workspace` };

    const rel = path.relative(base, abs).split(path.sep).join("/") || ".";
    if (rel.split("/").some((segment) => FORBIDDEN_SEGMENTS.has(sameCase(segment)))) {
        return { error: `${rel} is under .git/ or .tyr/, which agents may not touch` };
    }

    // Symlinks: the nearest existing ancestor (or the path itself) must
    // really live inside the real workspace.
    const realBase = await fs.realpath(base).catch(() => base);
    let probe = abs;
    for (;;) {
        try {
            const real = await fs.realpath(probe);
            if (!isInside(sameCase(realBase), sameCase(real))) {
                return { error: `${rel} leads outside the workspace through a symlink` };
            }
            break;
        } catch {
            const parent = path.dirname(probe);
            if (parent === probe) break;
            probe = parent;
        }
    }
    // A dangling symlink at the target itself would let a write land outside.
    try {
        const st = await fs.lstat(abs);
        if (st.isSymbolicLink()) {
            const real = await fs.realpath(abs).catch(() => null);
            if (real === null || !isInside(sameCase(realBase), sameCase(real))) {
                return { error: `${rel} is a symlink that leads outside the workspace` };
            }
        }
    } catch {
        // Does not exist yet: fine.
    }
    return { abs, rel };
}

async function confineOrFail(env: ToolEnv, raw: string | undefined, fallback?: string): Promise<ConfinedPath | ToolResult> {
    const value = raw ?? fallback;
    if (value === undefined) return fail("path is required");
    const confined = await confinePath(env.workspace, value);
    return "error" in confined ? fail(confined.error) : confined;
}

function isResult(value: ConfinedPath | ToolResult): value is ToolResult {
    return "content" in value;
}

/* -------------------------------------------------------------------------
 * File listing (shared by list_files and search)
 * ---------------------------------------------------------------------- */

interface Listing {
    files: string[];
    /** True when the walk stopped early at the hard cap. */
    capped: boolean;
}

/** Hard cap on files considered by one list/search call. */
const MAX_WALK_FILES = 50_000;

/**
 * Workspace-relative files (posix), sorted. In a git work tree: tracked and
 * untracked-but-not-ignored files (so .gitignore applies), minus deleted
 * ones. Elsewhere: a directory walk skipping the scanner's ignored dirs. Both
 * then drop .git/.tyr and the user's Tyr ignore patterns.
 */
async function listWorkspaceFiles(workspace: string, under: string): Promise<Listing> {
    const ignore = compileIgnore((await loadUserIgnorePatterns(workspace)).patterns);
    const scope = under === "." ? [] : [under];
    let files: string[] | null = null;

    const listed = await runGit(workspace, ["-c", "core.quotePath=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...scope], {
        timeoutMs: 15_000,
    });
    if (listed.ok) {
        const deleted = await runGit(workspace, ["-c", "core.quotePath=false", "ls-files", "-z", "--deleted", "--", ...scope], { timeoutMs: 15_000 });
        const gone = new Set(deleted.ok ? deleted.stdout.split("\0").filter(Boolean) : []);
        files = [...new Set(listed.stdout.split("\0").filter((f) => f !== "" && !gone.has(f)))];
    }
    let capped = false;
    if (files === null) {
        const walked = await walk(workspace, under);
        files = walked.files;
        capped = walked.capped;
    }

    const out = files.filter((f) => keep(f, ignore)).sort();
    if (out.length > MAX_WALK_FILES) {
        out.length = MAX_WALK_FILES;
        capped = true;
    }
    return { files: out, capped };
}

function keep(rel: string, ignore: IgnoreMatcher): boolean {
    const parts = rel.split("/");
    if (parts.some((p) => FORBIDDEN_SEGMENTS.has(sameCase(p)))) return false;
    if (ignore.size === 0) return true;
    for (let i = 1; i < parts.length; i++) {
        if (ignore.ignores(parts.slice(0, i).join("/"), true)) return false;
    }
    return !ignore.ignores(rel, false);
}

async function walk(workspace: string, under: string): Promise<Listing> {
    const files: string[] = [];
    const stack = [under === "." ? "" : under];
    while (stack.length > 0) {
        const dir = stack.pop()!;
        let entries: import("node:fs").Dirent[];
        try {
            entries = await fs.readdir(path.join(workspace, dir), { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
            if (entry.isDirectory()) {
                if (!IGNORED_DIRS.has(entry.name) && !FORBIDDEN_SEGMENTS.has(entry.name)) stack.push(rel);
            } else if (entry.isFile()) {
                files.push(rel);
                if (files.length >= MAX_WALK_FILES) return { files, capped: true };
            }
        }
    }
    return { files, capped: false };
}

/** Glob filter relative to `under`, reusing the ignore matcher's gitignore-style globs. */
function globFilter(pattern: string | undefined, under: string): (rel: string) => boolean {
    if (pattern === undefined || pattern.trim() === "") return () => true;
    const matcher = compileIgnore([pattern.trim()]);
    const prefix = under === "." ? "" : `${under}/`;
    return (rel) => matcher.ignores(rel.startsWith(prefix) ? rel.slice(prefix.length) : rel, false);
}

/* -------------------------------------------------------------------------
 * read_file
 * ---------------------------------------------------------------------- */

function readFileTool(): AgentTool {
    return defineTool(
        "read_file",
        "read",
        "Read a text file in the workspace. Lines are returned prefixed with their line number and a tab (the prefix is not part of the file). Use start_line/end_line (1-based, inclusive) to read part of a large file.",
        {
            type: "object",
            properties: {
                path: { type: "string", description: "File path relative to the workspace root." },
                start_line: { type: "integer", minimum: 1, description: "First line to return (1-based)." },
                end_line: { type: "integer", minimum: 1, description: "Last line to return (inclusive)." },
            },
            required: ["path"],
            additionalProperties: false,
        },
        async (input, env) => {
            const target = await confineOrFail(env, str(input, "path"));
            if (isResult(target)) return target;
            const denied = gateCheck(env, "read_file", "read", target.rel);
            if (denied) return denied;

            const st = await fs.stat(target.abs).catch(() => null);
            if (st === null) return fail(`${target.rel} does not exist`);
            if (!st.isFile()) return fail(`${target.rel} is not a file`);
            if (st.size > MAX_READ_FILE_BYTES) {
                return fail(`${target.rel} is ${st.size} bytes, over the ${MAX_READ_FILE_BYTES}-byte limit; use search to find the part you need`);
            }
            const buf = await fs.readFile(target.abs);
            if (looksBinary(buf)) return fail(`${target.rel} looks binary`);

            const lines = buf.toString("utf8").split(/\r?\n/);
            if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
            const total = lines.length;
            const start = clamp(int(input, "start_line"), 1, 1, Math.max(1, total));
            const end = clamp(int(input, "end_line"), total, start, Math.max(start, total));
            if (total === 0 || (total === 1 && lines[0] === "")) return ok(`${target.rel} is empty`);

            const out: string[] = [];
            let size = 0;
            let last = start - 1;
            for (let i = start; i <= end; i++) {
                const line = `${i}\t${lines[i - 1]}`;
                if (size + line.length + 1 > MAX_READ_OUTPUT_CHARS) break;
                out.push(line);
                size += line.length + 1;
                last = i;
            }
            const header = `${target.rel} (lines ${start}-${last} of ${total})`;
            const more = last < end ? `\n[output cut at line ${last}; read from start_line=${last + 1} for more]` : "";
            return ok(`${header}\n${out.join("\n")}${more}`);
        },
    );
}

/* -------------------------------------------------------------------------
 * list_files
 * ---------------------------------------------------------------------- */

function listFilesTool(): AgentTool {
    return defineTool(
        "list_files",
        "read",
        "List files in the workspace, recursively, skipping git-ignored and Tyr-ignored files. Optionally limit to a directory and filter with a gitignore-style glob such as \"*.ts\" or \"src/**/*.test.ts\" (relative to the directory).",
        {
            type: "object",
            properties: {
                path: { type: "string", description: "Directory relative to the workspace root. Default: the root." },
                pattern: { type: "string", description: "Glob filter, e.g. \"*.py\" or \"tests/**\"." },
                max_results: { type: "integer", minimum: 1, maximum: MAX_LIST_RESULTS },
            },
            additionalProperties: false,
        },
        async (input, env) => {
            const dir = await confineOrFail(env, str(input, "path"), ".");
            if (isResult(dir)) return dir;
            const denied = gateCheck(env, "list_files", "read", dir.rel);
            if (denied) return denied;
            const st = await fs.stat(dir.abs).catch(() => null);
            if (st === null || !st.isDirectory()) return fail(`${dir.rel} is not a directory`);

            const max = clamp(int(input, "max_results"), DEFAULT_LIST_RESULTS, 1, MAX_LIST_RESULTS);
            const listing = await listWorkspaceFiles(env.workspace, dir.rel);
            const matches = listing.files.filter(globFilter(str(input, "pattern"), dir.rel));
            if (matches.length === 0) return ok("no files found");
            const shown = matches.slice(0, max);
            const notes: string[] = [];
            if (matches.length > shown.length) notes.push(`[${matches.length - shown.length} more files not shown; narrow path or pattern]`);
            if (listing.capped) notes.push("[the listing stopped early: too many files]");
            return ok([...shown, ...notes].join("\n"));
        },
    );
}

/* -------------------------------------------------------------------------
 * search
 * ---------------------------------------------------------------------- */

function searchTool(): AgentTool {
    return defineTool(
        "search",
        "read",
        "Search file contents with a JavaScript regular expression. Returns matching lines as path:line: text. Skips git-ignored, Tyr-ignored, binary and very large files.",
        {
            type: "object",
            properties: {
                pattern: { type: "string", description: "Regular expression (JavaScript syntax)." },
                path: { type: "string", description: "Directory or file to search. Default: the workspace root." },
                glob: { type: "string", description: "Only files matching this glob, e.g. \"*.ts\"." },
                case_insensitive: { type: "boolean" },
                max_results: { type: "integer", minimum: 1, maximum: MAX_SEARCH_RESULTS },
            },
            required: ["pattern"],
            additionalProperties: false,
        },
        async (input, env) => {
            const source = str(input, "pattern");
            if (source === undefined || source === "") return fail("pattern is required");
            let regex: RegExp;
            try {
                regex = new RegExp(source, bool(input, "case_insensitive") ? "i" : "");
            } catch (error) {
                return fail(`invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
            }
            const scope = await confineOrFail(env, str(input, "path"), ".");
            if (isResult(scope)) return scope;
            const denied = gateCheck(env, "search", "read", scope.rel);
            if (denied) return denied;

            const st = await fs.stat(scope.abs).catch(() => null);
            if (st === null) return fail(`${scope.rel} does not exist`);
            let candidates: string[];
            let capped = false;
            if (st.isFile()) {
                candidates = [scope.rel];
            } else {
                const listing = await listWorkspaceFiles(env.workspace, scope.rel);
                candidates = listing.files.filter(globFilter(str(input, "glob"), scope.rel));
                capped = listing.capped;
            }

            const max = clamp(int(input, "max_results"), DEFAULT_SEARCH_RESULTS, 1, MAX_SEARCH_RESULTS);
            const hits: string[] = [];
            let more = false;
            outer: for (const rel of candidates) {
                if (env.signal?.aborted) return fail("cancelled");
                const abs = path.join(env.workspace, rel);
                const fst = await fs.stat(abs).catch(() => null);
                if (fst === null || !fst.isFile() || fst.size > MAX_SEARCH_FILE_BYTES) continue;
                const buf = await fs.readFile(abs).catch(() => null);
                if (buf === null || looksBinary(buf)) continue;
                const lines = buf.toString("utf8").split(/\r?\n/);
                for (let i = 0; i < lines.length; i++) {
                    if (!regex.test(lines[i])) continue;
                    if (hits.length >= max) {
                        more = true;
                        break outer;
                    }
                    const text = lines[i].length > 300 ? `${lines[i].slice(0, 300)}...` : lines[i];
                    hits.push(`${rel}:${i + 1}: ${text}`);
                }
            }
            if (hits.length === 0) return ok("no matches");
            if (more) hits.push(`[stopped at ${max} matches; narrow the pattern, path or glob]`);
            if (capped) hits.push("[the file listing stopped early: too many files]");
            return ok(hits.join("\n"));
        },
    );
}

/* -------------------------------------------------------------------------
 * git_diff
 * ---------------------------------------------------------------------- */

function gitDiffTool(): AgentTool {
    return defineTool(
        "git_diff",
        "read",
        "Show uncommitted changes: the working tree compared with HEAD (staged and unstaged together), plus untracked files. Optionally limit to one file or directory.",
        {
            type: "object",
            properties: {
                path: { type: "string", description: "File or directory relative to the workspace root." },
            },
            additionalProperties: false,
        },
        async (input, env) => {
            const raw = str(input, "path");
            let pathspec: string[] = [];
            let rel: string | undefined;
            if (raw !== undefined && raw.trim() !== "") {
                const target = await confineOrFail(env, raw);
                if (isResult(target)) return target;
                rel = target.rel;
                pathspec = [target.rel];
            }
            const denied = gateCheck(env, "git_diff", "read", rel);
            if (denied) return denied;

            const diff = await getDiff(env.workspace, { kind: "since", ref: "HEAD" }, {
                pathspec,
                maxPatchBytes: MAX_DIFF_CHARS,
                includeUntracked: true,
            });
            if (diff === null) return fail("no diff available (not a git repository, or no commits yet)");
            const parts: string[] = [];
            if (diff.files.length === 0) parts.push("no changes to tracked files");
            else parts.push(cut(diff.patch, MAX_DIFF_CHARS));
            if (diff.truncated) parts.push("[the diff was cut; pass a path to see one file]");
            const untracked = (diff.untracked ?? []).filter((f) => !f.split("/").some((s) => FORBIDDEN_SEGMENTS.has(s)));
            if (untracked.length > 0) {
                const shown = untracked.slice(0, 200);
                parts.push(`untracked files:\n${shown.join("\n")}${untracked.length > shown.length ? `\n[${untracked.length - shown.length} more]` : ""}`);
            }
            return ok(parts.join("\n\n"));
        },
    );
}

/* -------------------------------------------------------------------------
 * run_check
 * ---------------------------------------------------------------------- */

function runCheckTool(opts: ToolsetOptions): AgentTool {
    const load = opts.loadCommands ?? ((ws: string) => loadCheckCommands(ws));
    const run = opts.runCheck ?? runCheck;
    return defineTool(
        "run_check",
        "execute",
        `Run one of the project's configured checks (${CHECK_KINDS.join(", ")}) exactly as tyr.json defines it, and return the outcome with the tail of its output. Only configured checks can run; there is no arbitrary shell.`,
        {
            type: "object",
            properties: {
                kind: { type: "string", enum: [...CHECK_KINDS], description: "Which check to run." },
            },
            required: ["kind"],
            additionalProperties: false,
        },
        async (input, env) => {
            const kind = str(input, "kind");
            if (kind === undefined || !(CHECK_KINDS as readonly string[]).includes(kind)) {
                return fail(`kind must be one of: ${CHECK_KINDS.join(", ")}`);
            }
            const denied = gateCheck(env, "run_check", "execute");
            if (denied) return denied;
            const commands = await load(env.workspace);
            const command = commands[kind as CheckKind];
            const configured = Object.keys(commands);
            if (command === undefined) {
                return fail(`no ${kind} check is configured${configured.length > 0 ? ` (configured: ${configured.join(", ")})` : " in tyr.json"}`);
            }
            const result = await run(env.workspace, kind as CheckKind, command, {
                signal: env.signal,
                ...(opts.checkTimeoutMs !== undefined ? { timeoutMs: opts.checkTimeoutMs } : {}),
            });
            const lines = [
                `${kind}: ${result.outcome}${result.exitCode !== null ? ` (exit ${result.exitCode})` : ""} in ${Math.round(result.durationMs)}ms`,
                `command: ${result.command}`,
            ];
            if (result.error) lines.push(`error: ${result.error}`);
            const tail = (text: string): string =>
                text.length > MAX_CHECK_OUTPUT_CHARS ? `[... earlier output cut]\n${text.slice(-MAX_CHECK_OUTPUT_CHARS)}` : text;
            if (result.stdout.trim() !== "") lines.push(`stdout:\n${tail(result.stdout)}`);
            if (result.stderr.trim() !== "") lines.push(`stderr:\n${tail(result.stderr)}`);
            const text = lines.join("\n");
            return result.outcome === "passed" ? ok(text) : { content: text, isError: result.outcome === "error" || result.outcome === "timeout" || result.outcome === "cancelled" };
        },
    );
}

/* -------------------------------------------------------------------------
 * Write tools
 * ---------------------------------------------------------------------- */

type Recorder = (change: ProposedChange) => void;

/** Shared tail of edit_file and write_file: dry-run, approval, write, record. */
async function commitChange(
    env: ToolEnv,
    record: Recorder,
    change: ProposedChange,
    abs: string,
    content: string,
): Promise<ToolResult> {
    const shown = change.patch ? `\n${change.patch}` : "";
    if (env.dryRun) {
        record(change);
        return ok(`dry run: would change ${change.path}: ${change.summary}${shown}`);
    }
    const decision = await env.gate.approve(change);
    if (!decision.allowed) return fail(`change to ${change.path} not approved: ${decision.reason}`);
    if (env.signal?.aborted) return fail("cancelled");
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.tyr-${process.pid}-${Date.now()}.tmp`;
    try {
        await fs.writeFile(tmp, content, "utf8");
        await fs.rename(tmp, abs);
    } catch (error) {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        throw error;
    }
    record(change);
    return ok(`changed ${change.path}: ${change.summary}`);
}

function editFileTool(record: Recorder): AgentTool {
    return defineTool(
        "edit_file",
        "write",
        "Edit a file by replacing one exact occurrence of old_string with new_string. old_string must match the file exactly (whitespace included, without read_file's line-number prefixes) and must occur exactly once; include surrounding lines to make it unique.",
        {
            type: "object",
            properties: {
                path: { type: "string", description: "File path relative to the workspace root." },
                old_string: { type: "string", description: "Exact text to replace; must occur exactly once." },
                new_string: { type: "string", description: "Replacement text." },
            },
            required: ["path", "old_string", "new_string"],
            additionalProperties: false,
        },
        async (input, env) => {
            const target = await confineOrFail(env, str(input, "path"));
            if (isResult(target)) return target;
            let oldString = str(input, "old_string");
            let newString = str(input, "new_string");
            if (oldString === undefined || newString === undefined) return fail("old_string and new_string are required strings");
            if (oldString === "") return fail("old_string is empty; use write_file to create a file");
            if (oldString === newString) return fail("old_string and new_string are the same");
            const denied = gateCheck(env, "edit_file", "write", target.rel);
            if (denied) return denied;

            const st = await fs.stat(target.abs).catch(() => null);
            if (st === null || !st.isFile()) return fail(`${target.rel} does not exist; use write_file to create it`);
            if (st.size > MAX_READ_FILE_BYTES) return fail(`${target.rel} is too large to edit`);
            const buf = await fs.readFile(target.abs);
            if (looksBinary(buf)) return fail(`${target.rel} looks binary`);
            const before = buf.toString("utf8");

            // Files with CRLF endings: accept LF-only strings from the model.
            if (before.includes("\r\n") && !oldString.includes("\r")) {
                oldString = oldString.replace(/\n/g, "\r\n");
                newString = newString.replace(/\r?\n/g, "\r\n");
            }
            const count = countOccurrences(before, oldString);
            if (count === 0) return fail(`old_string was not found in ${target.rel}; read the file and copy the text exactly`);
            if (count > 1) return fail(`old_string occurs ${count} times in ${target.rel}; include more surrounding text so it matches once`);

            const index = before.indexOf(oldString);
            const after = before.slice(0, index) + newString + before.slice(index + oldString.length);
            const removed = lineCount(oldString);
            const added = lineCount(newString);
            const change: ProposedChange = {
                tool: "edit_file",
                path: target.rel,
                summary: `replace ${removed} line${removed === 1 ? "" : "s"} with ${added} in ${target.rel}`,
                patch: cut(unifiedDiff(target.rel, before, after), MAX_PATCH_CHARS),
            };
            return commitChange(env, record, change, target.abs, after);
        },
    );
}

function writeFileTool(record: Recorder): AgentTool {
    return defineTool(
        "write_file",
        "write",
        "Create a file, or overwrite an existing one with new full content. Prefer edit_file for small changes to existing files.",
        {
            type: "object",
            properties: {
                path: { type: "string", description: "File path relative to the workspace root." },
                content: { type: "string", description: "The complete new file content." },
            },
            required: ["path", "content"],
            additionalProperties: false,
        },
        async (input, env) => {
            const target = await confineOrFail(env, str(input, "path"));
            if (isResult(target)) return target;
            const content = str(input, "content");
            if (content === undefined) return fail("content is required");
            if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) return fail(`content is over the ${MAX_WRITE_BYTES}-byte limit`);
            const denied = gateCheck(env, "write_file", "write", target.rel);
            if (denied) return denied;

            let before: string | null = null;
            if (await exists(target.abs)) {
                const st = await fs.stat(target.abs).catch(() => null);
                if (st === null || !st.isFile()) return fail(`${target.rel} exists and is not a file`);
                if (st.size > MAX_READ_FILE_BYTES) return fail(`${target.rel} is too large to overwrite`);
                const buf = await fs.readFile(target.abs);
                if (looksBinary(buf)) return fail(`${target.rel} is binary; agents may not overwrite it`);
                before = buf.toString("utf8");
                if (before === content) return ok(`${target.rel} already has this content; nothing to do`);
            }
            const lines = lineCount(content);
            const change: ProposedChange = {
                tool: "write_file",
                path: target.rel,
                summary:
                    before === null
                        ? `create ${target.rel} (${lines} line${lines === 1 ? "" : "s"})`
                        : `overwrite ${target.rel} (${lineCount(before)} -> ${lines} lines)`,
                patch: cut(unifiedDiff(target.rel, before, content), MAX_PATCH_CHARS),
            };
            return commitChange(env, record, change, target.abs, content);
        },
    );
}

function countOccurrences(haystack: string, needle: string): number {
    let count = 0;
    let from = 0;
    for (;;) {
        const at = haystack.indexOf(needle, from);
        if (at === -1) return count;
        count += 1;
        from = at + 1;
    }
}

function lineCount(text: string): number {
    if (text === "") return 0;
    const n = text.split("\n").length;
    return text.endsWith("\n") ? n - 1 : n;
}

/* -------------------------------------------------------------------------
 * Unified diff
 * ---------------------------------------------------------------------- */

type Op = { kind: " " | "-" | "+"; text: string };

/** Above this many cells the middle of the diff is shown as a block replace. */
const MAX_LCS_CELLS = 4_000_000;
const CONTEXT = 3;

function splitLines(text: string): string[] {
    if (text === "") return [];
    const lines = text.split(/\r?\n/);
    if (lines[lines.length - 1] === "") lines.pop();
    return lines;
}

/**
 * A unified diff (git-style headers, 3 lines of context) between two file
 * contents; `before` null means a new file. Exported for tests.
 */
export function unifiedDiff(file: string, before: string | null, after: string): string {
    const a = before === null ? [] : splitLines(before);
    const b = splitLines(after);
    const ops = diffLines(a, b);
    if (!ops.some((op) => op.kind !== " ")) return "";

    const header = [`--- ${before === null ? "/dev/null" : `a/${file}`}`, `+++ b/${file}`];
    const hunks: string[] = [];
    // Changes grouped into hunks; nearby changes share their context lines.
    let i = 0;
    while (i < ops.length) {
        if (ops[i].kind === " ") {
            i++;
            continue;
        }
        const start = Math.max(0, i - CONTEXT);
        // Walk forward until a run of more than 2*CONTEXT unchanged lines.
        let end = i;
        let j = i;
        while (j < ops.length) {
            if (ops[j].kind !== " ") {
                end = j;
                j++;
                continue;
            }
            let run = 0;
            while (j + run < ops.length && ops[j + run].kind === " ") run++;
            if (j + run >= ops.length || run > CONTEXT * 2) break;
            j += run;
        }
        const stop = Math.min(ops.length, end + 1 + CONTEXT);
        // Line numbers at `start`.
        let aLine = 1;
        let bLine = 1;
        for (let k = 0; k < start; k++) {
            if (ops[k].kind !== "+") aLine++;
            if (ops[k].kind !== "-") bLine++;
        }
        const body = ops.slice(start, stop);
        const aCount = body.filter((op) => op.kind !== "+").length;
        const bCount = body.filter((op) => op.kind !== "-").length;
        hunks.push(
            `@@ -${aCount === 0 ? aLine - 1 : aLine},${aCount} +${bCount === 0 ? bLine - 1 : bLine},${bCount} @@`,
            ...body.map((op) => `${op.kind}${op.text}`),
        );
        i = stop;
    }
    return [...header, ...hunks].join("\n") + "\n";
}

function diffLines(a: string[], b: string[]): Op[] {
    let prefix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
    let suffix = 0;
    while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;

    const ops: Op[] = a.slice(0, prefix).map((text) => ({ kind: " ", text }));
    const midA = a.slice(prefix, a.length - suffix);
    const midB = b.slice(prefix, b.length - suffix);
    if ((midA.length + 1) * (midB.length + 1) > MAX_LCS_CELLS) {
        for (const text of midA) ops.push({ kind: "-", text });
        for (const text of midB) ops.push({ kind: "+", text });
    } else {
        ops.push(...lcsOps(midA, midB));
    }
    for (const text of a.slice(a.length - suffix)) ops.push({ kind: " ", text });
    return ops;
}

function lcsOps(a: string[], b: string[]): Op[] {
    const n = a.length;
    const m = b.length;
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            table[i * width + j] =
                a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
        }
    }
    const ops: Op[] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            ops.push({ kind: " ", text: a[i] });
            i++;
            j++;
        } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
            ops.push({ kind: "-", text: a[i++] });
        } else {
            ops.push({ kind: "+", text: b[j++] });
        }
    }
    while (i < n) ops.push({ kind: "-", text: a[i++] });
    while (j < m) ops.push({ kind: "+", text: b[j++] });
    return ops;
}
