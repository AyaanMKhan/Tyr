// Claude Code session observation through hooks (PLANNING.md 2.9).
//
// Claude Code runs a configured command for each hook event and passes it one
// JSON object on stdin. Tyr installs `tyr hook` for the events below; that
// command turns the payload into a journal event (`.tyr/state/events.jsonl`,
// see events.ts) with normalizeHookPayload(). The daemon and `tyr watch` read
// the journal; nothing here talks to them.
//
// Payload (https://code.claude.com/docs/en/hooks, checked 2026-11):
//
//   common      session_id, transcript_path, cwd, hook_event_name,
//               permission_mode, agent_id / agent_type (inside a subagent)
//   PreToolUse  tool_name, tool_input, tool_use_id
//   PostToolUse tool_name, tool_input, tool_response, tool_use_id, duration_ms
//   PostToolUseFailure  … plus error, is_interrupt (no tool_response)
//   UserPromptSubmit    prompt
//   Stop / SubagentStop stop_hook_active, last_assistant_message, agent_type
//   Notification        message, title, notification_type
//   SessionStart        source (startup|resume|clear|compact|fork), model
//   SessionEnd          reason
//   PreCompact          trigger (manual|auto), custom_instructions
//
// Event kinds are a fixed contract that other parts of Tyr render:
//
//   claude.session_start  SessionStart
//   claude.prompt         UserPromptSubmit
//   claude.tool_use       PreToolUse
//   claude.tool_result    PostToolUse and PostToolUseFailure (data.success)
//   claude.stop           Stop
//   claude.subagent_stop  SubagentStop
//   claude.notification   Notification
//   claude.session_end    SessionEnd
//   claude.compact        PreCompact
//   claude.hook           anything else (data.hookEvent says which)
//
// Every event's data has `sessionId`, `hookEvent` and `transcriptPath`; tool
// events add `tool`, `toolUseId` and `input`, a SHORT one-line summary of the
// call (the Bash command, a file path relative to the project, a Grep
// pattern), never file contents or tool output.
//
// Privacy: the journal is a local, gitignored file, but it is still a copy
// of what happened in the session, so it keeps as little as is useful.
// Prompts and Bash commands routinely contain secrets (a pasted API key, a
// `curl -H "Authorization: …"`), so a prompt is stored only as a short
// preview (PROMPT_PREVIEW_CHARS) plus its length, and every free-text field
// goes through redactSecrets() and truncation. Write/Edit contents, Read
// output and Bash output are never stored at all. PreCompact's
// custom_instructions (user text) is reduced to a boolean.
//
// The second half of this module edits Claude Code's settings files
// (`.claude/settings.json` / `.claude/settings.local.json`) to install or
// remove Tyr's hook entries. It merges into whatever is there, recognizes its
// own entries by TYR_HOOK_MARKER, and refuses to touch a file it cannot parse.
//
// Silent like the other core modules: the commands do the printing.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { EXIT_CODES, TyrError } from "./errors.js";
import type { TyrEventInput } from "./events.js";
import { writeFileAtomic } from "./scaffold.js";

/* -------------------------------------------------------------------------
 * Normalization
 * ---------------------------------------------------------------------- */

/** Longest free-text field stored in an event's data. */
export const MAX_FIELD_CHARS = 300;
/** Longest one-line `message`. */
export const MAX_MESSAGE_CHARS = 200;
/** How much of a user prompt is kept. Short on purpose: see the header. */
export const PROMPT_PREVIEW_CHARS = 80;

/** Hook name -> journal kind. Anything missing becomes "claude.hook". */
export const CLAUDE_HOOK_KINDS: Readonly<Record<string, string>> = {
    SessionStart: "claude.session_start",
    UserPromptSubmit: "claude.prompt",
    PreToolUse: "claude.tool_use",
    PostToolUse: "claude.tool_result",
    PostToolUseFailure: "claude.tool_result",
    Stop: "claude.stop",
    SubagentStop: "claude.subagent_stop",
    Notification: "claude.notification",
    SessionEnd: "claude.session_end",
    PreCompact: "claude.compact",
};

export const CLAUDE_GENERIC_KIND = "claude.hook";

export interface NormalizeOptions {
    /**
     * Project root, used to show file paths relative to it. Paths outside it
     * stay absolute. Default: the payload's `cwd`.
     */
    root?: string;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
    return typeof value === "string" && value !== "" ? value : undefined;
}

/** Collapse whitespace (newlines included) so every field is one line. */
function oneLine(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

/** Cut `text` to `max` characters, marking the cut with an ellipsis. */
export function truncate(text: string, max: number = MAX_FIELD_CHARS): string {
    if (text.length <= max) return text;
    return `${text.slice(0, Math.max(0, max - 1))}…`;
}

// Credential shapes common enough to be worth masking before anything is
// stored. Deliberately conservative: a false positive costs a few characters
// of a preview, a false negative leaks a key into a log file.
const SECRET_PATTERNS: readonly RegExp[] = [
    /\bsk-[A-Za-z0-9_-]{8,}/g, // Anthropic / OpenAI style keys
    /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{8,}/g, // GitHub tokens
    /\bxox[abprs]-[A-Za-z0-9-]{8,}/g, // Slack tokens
    /\bAKIA[0-9A-Z]{12,}/g, // AWS access key ids
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWTs
];
// `password=hunter2`, `TOKEN: abc`, `Authorization: Bearer abc`: keep the
// name, mask the value.
const SECRET_ASSIGNMENT =
    /\b((?:[A-Za-z0-9_]*(?:password|passwd|secret|token|api[_-]?key|authorization))["']?\s*[:=]\s*["']?(?:bearer\s+|basic\s+)?)[^\s"'&]+/gi;

/** Mask likely credentials in free text. Exported for tests. */
export function redactSecrets(text: string): string {
    let out = text;
    for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
    return out.replace(SECRET_ASSIGNMENT, "$1[redacted]");
}

/** One-line, redacted, truncated: the treatment for any free text we keep. */
function clean(text: string, max: number = MAX_FIELD_CHARS): string {
    return truncate(redactSecrets(oneLine(text)), max);
}

/** `file` relative to `root` when inside it; otherwise as given. Always "/"-separated. */
export function displayPath(file: string, root: string | undefined): string {
    if (root === undefined || !path.isAbsolute(file)) return file.split(path.sep).join("/");
    const relative = path.relative(root, file);
    if (relative === "" ) return ".";
    if (relative.startsWith("..") || path.isAbsolute(relative)) return file;
    return relative.split(path.sep).join("/");
}

/** Tool names whose input is a file path. */
const FILE_TOOLS: Readonly<Record<string, string>> = {
    Read: "file_path",
    Write: "file_path",
    Edit: "file_path",
    MultiEdit: "file_path",
    NotebookEdit: "notebook_path",
    NotebookRead: "notebook_path",
};

export interface ToolSummary {
    /** One-line description of the call, e.g. "npm test" or "src/a.ts". */
    input?: string;
    /** The file the call targets, relative to the project when inside it. */
    file?: string;
}

/**
 * A short, content-free description of a tool call. Only names arguments
 * that say *what* was touched (paths, patterns, commands, URLs); bodies such
 * as Write's `content` or Edit's `old_string` are never read.
 */
export function summarizeToolInput(tool: string, input: unknown, root?: string): ToolSummary {
    if (!isObject(input)) return {};
    const fileKey = FILE_TOOLS[tool];
    if (fileKey !== undefined) {
        const file = str(input[fileKey]);
        if (file === undefined) return {};
        const shown = clean(displayPath(file, root));
        return { input: shown, file: shown };
    }
    switch (tool) {
        case "Bash": {
            const command = str(input.command);
            return command === undefined ? {} : { input: clean(command) };
        }
        case "Glob":
        case "Grep": {
            const pattern = str(input.pattern);
            if (pattern === undefined) return {};
            const where = str(input.path);
            const glob = str(input.glob);
            const parts = [pattern];
            if (glob !== undefined) parts.push(`(${glob})`);
            if (where !== undefined) parts.push(`in ${displayPath(where, root)}`);
            return { input: clean(parts.join(" ")) };
        }
        case "WebFetch": {
            const url = str(input.url);
            return url === undefined ? {} : { input: clean(url) };
        }
        case "WebSearch": {
            const query = str(input.query);
            return query === undefined ? {} : { input: clean(query) };
        }
        case "Task":
        case "Agent": {
            const type = str(input.subagent_type);
            const description = str(input.description);
            const text = [type, description].filter((part) => part !== undefined).join(": ");
            return text === "" ? {} : { input: clean(text) };
        }
        case "TodoWrite": {
            const todos = Array.isArray(input.todos) ? input.todos.length : undefined;
            return todos === undefined ? {} : { input: `${todos} todo${todos === 1 ? "" : "s"}` };
        }
        default: {
            // MCP and future tools: the argument *names* only. Values could be
            // anything, including whole documents.
            const keys = Object.keys(input);
            return keys.length === 0 ? {} : { input: clean(`{${keys.join(", ")}}`) };
        }
    }
}

/** How a tool call reads in a message: "Edit src/a.ts", "Bash: npm test". */
function toolLabel(tool: string, summary: ToolSummary): string {
    if (summary.input === undefined) return tool;
    // Commands and patterns read better after a colon; paths do not need one.
    return summary.file !== undefined ? `${tool} ${summary.input}` : `${tool}: ${summary.input}`;
}

/**
 * Whether a PostToolUse response looks like a failure. Claude Code reports
 * real failures through PostToolUseFailure, but older versions sent them as
 * PostToolUse, and some tools put an error flag in their structured result.
 */
function responseFailed(response: unknown): boolean {
    if (!isObject(response)) return false;
    if (response.success === false || response.is_error === true || response.isError === true) return true;
    return response.interrupted === true;
}

/**
 * Turn one hook payload into a journal event (source "claude"). Returns null
 * for something that is not a JSON object at all; any object becomes an
 * event, with missing fields simply left out.
 */
export function normalizeHookPayload(payload: unknown, options: NormalizeOptions = {}): TyrEventInput | null {
    if (!isObject(payload)) return null;

    const hookEvent = str(payload.hook_event_name) ?? "unknown";
    const kind = CLAUDE_HOOK_KINDS[hookEvent] ?? CLAUDE_GENERIC_KIND;
    const root = options.root ?? str(payload.cwd);

    const data: Json = {
        sessionId: str(payload.session_id) ?? null,
        hookEvent,
        transcriptPath: str(payload.transcript_path) ?? null,
    };
    const cwd = str(payload.cwd);
    if (cwd !== undefined) data.cwd = cwd;
    const agentId = str(payload.agent_id);
    const agentType = str(payload.agent_type);
    if (agentId !== undefined) data.agentId = agentId;
    if (agentType !== undefined) data.agentType = agentType;

    let message: string;

    switch (kind) {
        case "claude.tool_use":
        case "claude.tool_result": {
            const tool = str(payload.tool_name) ?? "unknown";
            const summary = summarizeToolInput(tool, payload.tool_input, root);
            data.tool = tool;
            const toolUseId = str(payload.tool_use_id);
            if (toolUseId !== undefined) data.toolUseId = toolUseId;
            if (summary.input !== undefined) data.input = summary.input;
            if (summary.file !== undefined) data.file = summary.file;
            const label = toolLabel(tool, summary);

            if (kind === "claude.tool_use") {
                message = label;
                break;
            }
            const failed = hookEvent === "PostToolUseFailure" || responseFailed(payload.tool_response);
            data.success = !failed;
            if (typeof payload.duration_ms === "number") data.durationMs = payload.duration_ms;
            if (payload.is_interrupt === true) data.interrupted = true;
            const error = str(payload.error);
            // Only the first line of an error: the rest is tool output.
            if (failed && error !== undefined) data.error = clean(error.split("\n").slice(0, 2).join(" "));
            message = `${label} (${failed ? "failed" : "ok"})`;
            break;
        }
        case "claude.prompt": {
            const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
            const preview = clean(prompt, PROMPT_PREVIEW_CHARS);
            data.prompt = preview;
            data.promptLength = prompt.length;
            message = `Prompt: "${truncate(preview, 60)}"`;
            break;
        }
        case "claude.session_start": {
            const source = str(payload.source);
            const model = str(payload.model);
            if (source !== undefined) data.source = source;
            if (model !== undefined) data.model = model;
            message = `Session started${source !== undefined ? ` (${source})` : ""}`;
            break;
        }
        case "claude.session_end": {
            const reason = str(payload.reason);
            if (reason !== undefined) data.reason = reason;
            message = `Session ended${reason !== undefined ? ` (${reason})` : ""}`;
            break;
        }
        case "claude.stop":
        case "claude.subagent_stop": {
            if (typeof payload.stop_hook_active === "boolean") data.stopHookActive = payload.stop_hook_active;
            const last = str(payload.last_assistant_message);
            if (last !== undefined) data.lastMessage = clean(last);
            message =
                kind === "claude.stop"
                    ? "Claude finished responding"
                    : `Subagent finished${agentType !== undefined ? ` (${agentType})` : ""}`;
            break;
        }
        case "claude.notification": {
            const text = str(payload.message);
            const type = str(payload.notification_type);
            const title = str(payload.title);
            if (text !== undefined) data.message = clean(text);
            if (type !== undefined) data.notificationType = type;
            if (title !== undefined) data.title = clean(title);
            message = `Notification: ${text !== undefined ? oneLine(text) : (type ?? "(empty)")}`;
            break;
        }
        case "claude.compact": {
            const trigger = str(payload.trigger);
            if (trigger !== undefined) data.trigger = trigger;
            data.customInstructions = str(payload.custom_instructions) !== undefined;
            message = `Compacting context${trigger !== undefined ? ` (${trigger})` : ""}`;
            break;
        }
        default:
            message = `${hookEvent} hook`;
    }

    return { source: "claude", kind, message: clean(message, MAX_MESSAGE_CHARS), data };
}

/* -------------------------------------------------------------------------
 * Settings files
 * ---------------------------------------------------------------------- */

/**
 * Appended to every command Tyr installs, so its entries can be found again
 * whatever the command itself looks like (an absolute node path, `npx tyr`,
 * a user's --command). A shell comment: sh, bash, zsh and PowerShell all
 * ignore it, and Claude Code runs hook commands through a shell.
 */
export const TYR_HOOK_MARKER = "# tyr:claude-hook";

/** The events Tyr listens to. Order is the order they are written. */
export const TYR_HOOK_EVENTS = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
    "SubagentStop",
    "Notification",
    "PreCompact",
    "SessionEnd",
] as const;

/** Events whose matcher filters by tool name; Tyr wants every tool. */
const TOOL_EVENTS: ReadonlySet<string> = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure"]);

/**
 * Seconds Claude Code waits for the hook. `tyr hook` gives up on its own
 * well before this (see commands/hooks.ts); the limit only matters if node
 * itself hangs, and the default (600 s) would stall the session.
 */
export const TYR_HOOK_TIMEOUT_SECONDS = 10;

/** The full command string written to settings: `<command> # tyr:claude-hook`. */
export function markedCommand(command: string): string {
    const base = command.trim();
    return base.includes(TYR_HOOK_MARKER) ? base : `${base} ${TYR_HOOK_MARKER}`;
}

export function isTyrHandler(handler: unknown): boolean {
    return isObject(handler) && typeof handler.command === "string" && handler.command.includes(TYR_HOOK_MARKER);
}

/** The matcher group Tyr writes for one event. */
export function tyrHookGroup(event: string, command: string): Json {
    const handler = { type: "command", command: markedCommand(command), timeout: TYR_HOOK_TIMEOUT_SECONDS };
    return TOOL_EVENTS.has(event) ? { matcher: "*", hooks: [handler] } : { hooks: [handler] };
}

/** Quote one argument for the POSIX-style shell Claude Code runs hooks in. */
export function shellQuote(arg: string): string {
    if (/^[A-Za-z0-9_\/.:@%+=,-]+$/.test(arg)) return arg;
    return `"${arg.replace(/(["\\$`])/g, "\\$1")}"`;
}

/**
 * The default hook command: `node "<abs path to cli/index.js>" hook`.
 * An absolute script path works in dev checkouts and when `tyr` is not on
 * the PATH Claude Code sees, at the price of being machine-specific.
 */
export function defaultHookCommand(cliScript: string): string {
    return `node ${shellQuote(cliScript)} hook`;
}

async function readSettings(file: string): Promise<Json | null> {
    let raw: string;
    try {
        raw = await fs.readFile(file, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw new TyrError(`Cannot read ${file}: ${(error as Error).message}`, { exitCode: EXIT_CODES.CONFIG, cause: error });
    }
    // Claude Code creates empty files now and then; treat one as `{}`.
    if (raw.trim() === "") return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new TyrError(`${file} is not valid JSON (${(error as Error).message}); not changing it`, {
            exitCode: EXIT_CODES.CONFIG,
            hint: "Fix the file by hand (Claude Code would not read it either), then run the command again.",
            cause: error,
        });
    }
    if (!isObject(parsed)) {
        throw new TyrError(`${file} must contain a JSON object; not changing it`, { exitCode: EXIT_CODES.CONFIG });
    }
    return parsed;
}

/** The `hooks` object of a settings document, validated enough to edit safely. */
function hooksOf(settings: Json, file: string): Json | undefined {
    const hooks = settings.hooks;
    if (hooks === undefined) return undefined;
    if (!isObject(hooks)) {
        throw new TyrError(`"hooks" in ${file} is not an object; not changing it`, { exitCode: EXIT_CODES.CONFIG });
    }
    for (const [event, groups] of Object.entries(hooks)) {
        if (!Array.isArray(groups)) {
            throw new TyrError(`"hooks.${event}" in ${file} is not an array; not changing it`, {
                exitCode: EXIT_CODES.CONFIG,
            });
        }
    }
    return hooks;
}

/**
 * Remove Tyr's handlers from one event's matcher groups. A group left with
 * no handlers is dropped, but only if Tyr emptied it; anything the user
 * wrote, even an odd empty group, stays.
 */
function stripTyr(groups: unknown[]): { groups: unknown[]; removed: number } {
    let removed = 0;
    const kept: unknown[] = [];
    for (const group of groups) {
        if (!isObject(group) || !Array.isArray(group.hooks)) {
            kept.push(group);
            continue;
        }
        const handlers = group.hooks.filter((handler) => !isTyrHandler(handler));
        const dropped = group.hooks.length - handlers.length;
        removed += dropped;
        if (dropped === 0) kept.push(group);
        else if (handlers.length > 0) kept.push({ ...group, hooks: handlers });
    }
    return { groups: kept, removed };
}

/** True when `groups` hold Tyr's entry for `event` exactly as it would be installed. */
function hasExactly(groups: unknown[], expected: Json): boolean {
    const ours = groups.filter((group) => isObject(group) && Array.isArray(group.hooks) && group.hooks.some(isTyrHandler));
    return ours.length === 1 && JSON.stringify(ours[0]) === JSON.stringify(expected);
}

export interface HooksEdit {
    file: string;
    /** False when the file already said exactly this; nothing was written. */
    changed: boolean;
    /** Events whose Tyr entry was added or rewritten (install) or removed (uninstall). */
    events: string[];
    /** The command now installed (install only). */
    command?: string;
}

async function writeSettings(file: string, settings: Json): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, `${JSON.stringify(settings, null, 2)}\n`);
}

/**
 * Add Tyr's hook for every TYR_HOOK_EVENTS entry to `settingsFile`, creating
 * it if needed. Other settings and other hooks are left exactly as they are;
 * an existing Tyr entry with a different command is replaced in place of
 * being duplicated. Throws a CONFIG TyrError for a file it cannot parse.
 */
export async function installHooks(settingsFile: string, command: string): Promise<HooksEdit> {
    const settings = (await readSettings(settingsFile)) ?? {};
    const hooks = hooksOf(settings, settingsFile) ?? {};
    const changedEvents: string[] = [];

    for (const event of TYR_HOOK_EVENTS) {
        const expected = tyrHookGroup(event, command);
        const groups = (hooks[event] as unknown[] | undefined) ?? [];
        if (hasExactly(groups, expected)) continue;
        hooks[event] = [...stripTyr(groups).groups, expected];
        changedEvents.push(event);
    }

    const result: HooksEdit = {
        file: settingsFile,
        changed: changedEvents.length > 0,
        events: changedEvents,
        command: markedCommand(command),
    };
    if (result.changed) {
        settings.hooks = hooks;
        await writeSettings(settingsFile, settings);
    }
    return result;
}

/**
 * Remove every Tyr hook entry from `settingsFile`, leaving everything else.
 * A missing file, or one with no Tyr entries, is not touched.
 */
export async function uninstallHooks(settingsFile: string): Promise<HooksEdit> {
    const settings = await readSettings(settingsFile);
    const result: HooksEdit = { file: settingsFile, changed: false, events: [] };
    if (settings === null) return result;
    const hooks = hooksOf(settings, settingsFile);
    if (hooks === undefined) return result;

    for (const [event, groups] of Object.entries(hooks)) {
        const stripped = stripTyr(groups as unknown[]);
        if (stripped.removed === 0) continue;
        result.events.push(event);
        // Only an event Tyr emptied disappears.
        if (stripped.groups.length === 0) delete hooks[event];
        else hooks[event] = stripped.groups;
    }
    if (result.events.length === 0) return result;

    if (Object.keys(hooks).length === 0) delete settings.hooks;
    result.changed = true;
    if (Object.keys(settings).length === 0) {
        // Nothing but Tyr's hooks was ever in it (typically a settings.json
        // that install created): leave no empty file behind to commit.
        await fs.rm(settingsFile, { force: true });
    } else {
        await writeSettings(settingsFile, settings);
    }
    return result;
}

export interface HooksStatus {
    file: string;
    exists: boolean;
    /** Events that have a Tyr entry. */
    installed: string[];
    /** TYR_HOOK_EVENTS without one. */
    missing: string[];
    /** Distinct Tyr commands found (normally one). */
    commands: string[];
    /** Set when the file could not be read or parsed; the lists are then empty. */
    error?: string;
}

/** What Tyr has installed in `settingsFile`. Never throws. */
export async function hooksStatus(settingsFile: string): Promise<HooksStatus> {
    const status: HooksStatus = {
        file: settingsFile,
        exists: false,
        installed: [],
        missing: [...TYR_HOOK_EVENTS],
        commands: [],
    };
    let settings: Json | null;
    try {
        settings = await readSettings(settingsFile);
        if (settings === null) return status;
        status.exists = true;
        const hooks = hooksOf(settings, settingsFile) ?? {};
        const commands = new Set<string>();
        for (const [event, groups] of Object.entries(hooks)) {
            let found = false;
            for (const group of groups as unknown[]) {
                if (!isObject(group) || !Array.isArray(group.hooks)) continue;
                for (const handler of group.hooks) {
                    if (!isTyrHandler(handler)) continue;
                    found = true;
                    commands.add((handler as Json).command as string);
                }
            }
            if (found) status.installed.push(event);
        }
        status.missing = TYR_HOOK_EVENTS.filter((event) => !status.installed.includes(event));
        status.commands = [...commands];
    } catch (error) {
        status.exists = true;
        status.error = error instanceof Error ? error.message : String(error);
    }
    return status;
}

/** `.claude/settings.json` (shared) or `.claude/settings.local.json` (personal). */
export function claudeSettingsFile(root: string, scope: "shared" | "local"): string {
    return path.join(root, ".claude", scope === "shared" ? "settings.json" : "settings.local.json");
}
