// One-line rendering of journal events for `tyr watch`.
//
// Pure: no I/O and no capability detection. The caller decides colour,
// Unicode and width (cli/commands/watch.ts asks the reporter's probes), so
// every branch here is testable with fixed inputs. Colours and glyphs come
// from ui/reporter.ts so `tyr watch` looks like the rest of the CLI and obeys
// the same NO_COLOR / TERM=dumb / legacy-console rules.
//
// A line reads:
//
//   14:22:33 ◆ claude  Bash: npm test  ✗ Exit code 1
//   └ time   └ source  └ summary       └ outcome (tool results only)
//
// The time is local and gets a date prefix (`11-09 14:22:33`) when the event
// is not from `now`'s day, so replayed history is never mistaken for today.
//
// Summaries are written per kind for the contracts the producers document
// (events.ts, claude-hooks.ts, daemon.ts). Anything else, including kinds
// that do not exist yet, falls back to the event's own `message`, so a new
// producer is visible in `tyr watch` before anyone teaches this file about it.
//
// Noise control: routine kinds (read-only tool calls, staged-index changes,
// fs batches caused by git, pongs) are dimmed rather than dropped. Hiding is
// the command's job (filters), not the formatter's.

import { ASCII_GLYPHS, paint, SGR, UNICODE_GLYPHS } from "./reporter.js";
import type { TyrEvent } from "../core/events.js";

export interface EventViewOptions {
    color: boolean;
    unicode: boolean;
    /** Add an indented detail line or two (kind, session, paths, errors). */
    verbose: boolean;
    /** Reference "now" for the date prefix. Default: the current time. */
    now?: Date;
    /** Terminal columns; the summary is truncated so the first line fits. */
    width?: number;
    /**
     * For a claude.tool_result: when its matching claude.tool_use happened,
     * used for the duration if the hook payload carried none.
     */
    startedAt?: string;
}

/* -------------------------------------------------------------------------
 * Vocabulary
 * ---------------------------------------------------------------------- */

interface SourceStyle {
    unicode: string;
    ascii: string;
    color: string;
}

const SOURCE_STYLES: Readonly<Record<string, SourceStyle>> = {
    tyr: { unicode: "●", ascii: "*", color: SGR.green },
    git: { unicode: "⎇", ascii: "^", color: SGR.cyan },
    fs: { unicode: "✎", ascii: "+", color: SGR.blue },
    claude: { unicode: "◆", ascii: "@", color: SGR.magenta },
    check: { unicode: "▣", ascii: "#", color: SGR.yellow },
    user: { unicode: "▸", ascii: ">", color: SGR.bold },
};
const UNKNOWN_SOURCE: SourceStyle = { unicode: "·", ascii: ".", color: SGR.dim };

/** Width of the source column: "claude" is the longest source name. */
const SOURCE_COLUMN = 6;

/** Claude tools that only look at things; their calls are dimmed. */
const READ_ONLY_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead", "TodoWrite", "WebSearch", "WebFetch"]);

/** How prominent a line is. */
type Tone = "normal" | "dim" | "good" | "warn" | "bad" | "strong";

const TONE_CODES: Readonly<Record<Tone, string | null>> = {
    normal: null,
    dim: SGR.dim,
    good: SGR.green,
    warn: SGR.yellow,
    bad: SGR.red,
    strong: SGR.bold,
};

/** What a kind renders to before layout: the summary text plus optional extras. */
interface Rendered {
    summary: string;
    tone: Tone;
    /** Appended after two spaces, coloured on its own (a tool's ✓ / ✗). */
    outcome?: { text: string; tone: Tone };
    /** Extra --verbose lines, before indentation. */
    details?: string[];
}

/* -------------------------------------------------------------------------
 * Small helpers
 * ---------------------------------------------------------------------- */

function str(value: unknown): string | undefined {
    return typeof value === "string" && value !== "" ? value : undefined;
}

function num(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function list(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function plural(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function shortHash(value: unknown): string {
    const hash = str(value);
    return hash === undefined ? "(none)" : hash.slice(0, 7);
}

/** First 8 characters: enough to tell sessions apart, short enough to read. */
export function shortSession(value: unknown): string | undefined {
    const id = str(value);
    return id === undefined ? undefined : id.slice(0, 8);
}

/** First line only; event messages are meant to be one line but a crash stack is not. */
function firstLine(text: string): string {
    const newline = text.indexOf("\n");
    return newline === -1 ? text : text.slice(0, newline);
}

/** "850ms", "1.2s", "2m 05s". */
export function formatDuration(ms: number): string {
    if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.floor((ms % 60_000) / 1000);
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** "45s", "12m", "2h 13m", "3d 4h": coarse, for an uptime. */
export function formatUptime(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ${minutes % 60}m`;
    return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

const two = (n: number): string => String(n).padStart(2, "0");

/** Local "HH:MM:SS", prefixed with "MM-DD " when not on `now`'s local day. */
export function formatClock(ts: string, now: Date): string {
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) return "--:--:--";
    const time = `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
    const sameDay =
        date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
    return sameDay ? time : `${two(date.getMonth() + 1)}-${two(date.getDate())} ${time}`;
}

/**
 * Parse `--since`: a relative age ("30s", "10m", "2h", "1d", "1w", also
 * "1h30m") counted back from `now`, or anything Date.parse accepts (ISO
 * dates and times). Null when it is neither, so the caller can report a
 * usage error rather than silently showing everything.
 */
export function parseSince(value: string, now: Date = new Date()): Date | null {
    const text = value.trim();
    const units: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
    if (/^(\d+(\.\d+)?[smhdw])+$/i.test(text)) {
        let ms = 0;
        for (const [, amount, unit] of text.toLowerCase().matchAll(/(\d+(?:\.\d+)?)([smhdw])/g)) {
            ms += Number(amount) * (units[unit] ?? 0);
        }
        return new Date(now.getTime() - ms);
    }
    // Bare numbers are ambiguous (seconds? a year?), so they are rejected.
    if (/^\d+$/.test(text)) return null;
    const ms = Date.parse(text);
    return Number.isNaN(ms) ? null : new Date(ms);
}

/** "refs/heads/feat" -> "feat", "refs/tags/v1" -> "tag v1", "refs/remotes/o/m" -> "o/m". */
function shortRef(ref: string): string {
    if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
    if (ref.startsWith("refs/tags/")) return `tag ${ref.slice("refs/tags/".length)}`;
    if (ref.startsWith("refs/remotes/")) return ref.slice("refs/remotes/".length);
    return ref;
}

/**
 * What a git-caused fs batch reads as: "by checkout", "by merge/rebase".
 * `gitKind` comes from the producer (cli/core/observe.ts), which records the
 * full event kind ("git.head"); the bare form ("head") is accepted too.
 * Values this file does not know are shown as they are. Only stash updates
 * attribute through `git.refs` (see observe.ts), hence "stash".
 */
function causeText(data: Record<string, unknown>): string | undefined {
    if (str(data.cause) === undefined) return undefined;
    const cause = str(data.cause)!;
    if (cause !== "git") return `by ${cause}`;
    const rawKind = str(data.gitKind);
    if (rawKind === undefined) return "by git";
    const gitKind = rawKind.startsWith("git.") ? rawKind.slice(4) : rawKind;
    const names: Record<string, string> = { head: "checkout", "merge-state": "merge/rebase", index: "git index", refs: "stash" };
    return `by ${names[gitKind] ?? gitKind}`;
}

/* -------------------------------------------------------------------------
 * Per-kind summaries
 * ---------------------------------------------------------------------- */

function renderDaemon(event: TyrEvent, data: Record<string, unknown>, arrow: string): Rendered {
    const pid = num(data.pid);
    const pidText = pid !== undefined ? `pid ${pid}` : undefined;
    switch (event.kind) {
        case "daemon.started": {
            const parts = [pidText];
            const git = str(data.gitWatch);
            const fs = str(data.fsWatch);
            if (git !== undefined) parts.push(`git: ${git}`);
            else if ("gitWatch" in data) parts.push("no git");
            if (fs !== undefined) parts.push(`files: ${fs}`);
            const shown = parts.filter((part) => part !== undefined);
            return { summary: `daemon started${shown.length > 0 ? ` (${shown.join(", ")})` : ""}`, tone: "good" };
        }
        case "daemon.stopped": {
            // daemon.ts writes "Background process stopped (SIGTERM)"; keep the reason.
            const reason = /\(([^)]*)\)\s*$/.exec(event.message ?? "")?.[1];
            const shown = [pidText, reason].filter((part) => part !== undefined);
            return { summary: `daemon stopped${shown.length > 0 ? ` (${shown.join(", ")})` : ""}`, tone: "strong" };
        }
        case "daemon.crashed": {
            const detail = firstLine(event.message ?? "").replace(/^Background process crashed:\s*/i, "");
            return {
                summary: `daemon crashed${pidText !== undefined ? ` (${pidText})` : ""}${detail !== "" ? `: ${detail}` : ""}`,
                tone: "bad",
            };
        }
        case "daemon.pong":
            return { summary: `daemon answered a ping${pidText !== undefined ? ` (${pidText})` : ""}`, tone: "dim" };
        case "daemon.warning":
            return { summary: `daemon warning: ${firstLine(event.message ?? "(no message)")}`, tone: "warn" };
        default:
            return { summary: `daemon ${arrow} ${firstLine(event.message ?? event.kind)}`, tone: "normal" };
    }
}

function renderGit(event: TyrEvent, data: Record<string, unknown>, arrow: string): Rendered {
    switch (event.kind) {
        case "git.head": {
            const previous = record(data.previous) ?? {};
            const current = record(data.current) ?? {};
            const branch = str(current.branch) ?? "(detached)";
            if (data.branchChanged === true) {
                return { summary: `switched to ${branch} at ${shortHash(current.commit)}`, tone: "strong" };
            }
            if (data.commitChanged === true) {
                return {
                    summary: `${branch} moved ${shortHash(previous.commit)} ${arrow} ${shortHash(current.commit)}`,
                    tone: "normal",
                };
            }
            return { summary: firstLine(event.message ?? `HEAD changed on ${branch}`), tone: "normal" };
        }
        case "git.index": {
            const staged = list(data.staged);
            if (!Array.isArray(data.staged)) return { summary: firstLine(event.message ?? "index changed"), tone: "dim" };
            const summary =
                staged.length === 0 ? "index cleared: nothing staged" : `${plural(staged.length, "path")} staged: ${staged.slice(0, 3).join(", ")}${staged.length > 3 ? ", …" : ""}`;
            return { summary, tone: "dim", details: staged.length > 3 ? [`staged: ${staged.join(", ")}`] : undefined };
        }
        case "git.refs": {
            const changes = (Array.isArray(data.changes) ? data.changes : []).map(record).filter((c) => c !== undefined);
            if (changes.length === 0) return { summary: firstLine(event.message ?? "refs changed"), tone: "normal" };
            const describe = (change: Record<string, unknown>): string => {
                const ref = shortRef(str(change.ref) ?? "?");
                if (change.previous === null || change.previous === undefined) return `${ref} created at ${shortHash(change.current)}`;
                if (change.current === null || change.current === undefined) return `${ref} deleted`;
                return `${ref} ${shortHash(change.previous)} ${arrow} ${shortHash(change.current)}`;
            };
            const shown = changes.slice(0, 3).map(describe);
            const more = changes.length > 3 ? ` (+${changes.length - 3} more)` : "";
            return { summary: `${shown.join(", ")}${more}`, tone: "normal" };
        }
        case "git.merge-state": {
            const started = list(data.started);
            const finished = list(data.finished);
            const parts: string[] = [];
            if (started.length > 0) parts.push(`${started.join(", ")} in progress`);
            if (finished.length > 0) parts.push(`${finished.join(", ")} finished`);
            if (parts.length === 0) return { summary: firstLine(event.message ?? "git operation state changed"), tone: "normal" };
            return { summary: parts.join("; "), tone: started.length > 0 ? "warn" : "normal" };
        }
        default:
            return { summary: firstLine(event.message ?? event.kind), tone: "normal" };
    }
}

function renderFs(event: TyrEvent, data: Record<string, unknown>): Rendered {
    if (event.kind !== "fs.changed") return { summary: firstLine(event.message ?? event.kind), tone: "normal" };
    const added = list(data.added);
    const modified = list(data.modified);
    const removed = list(data.removed);
    const listed = added.length + modified.length + removed.length;
    const total = Math.max(num(data.total) ?? 0, listed);
    if (total === 0 && event.message !== undefined) return { summary: firstLine(event.message), tone: "normal" };

    const noun = total === 1 ? "file" : "files";
    const cause = causeText(data);
    let summary: string;
    if (cause !== undefined) {
        // A checkout touching 400 files is one fact, not 400 paths.
        summary = `${total} ${noun} changed ${cause}`;
    } else {
        const shown = [...added, ...modified, ...removed].slice(0, 3);
        const more = total > shown.length ? `, … (+${total - shown.length} more)` : "";
        summary = shown.length > 0 ? `${total} ${noun} changed: ${shown.join(", ")}${more}` : `${total} ${noun} changed`;
    }

    const details: string[] = [];
    const counts = [
        added.length > 0 ? `${added.length} added` : undefined,
        modified.length > 0 ? `${modified.length} modified` : undefined,
        removed.length > 0 ? `${removed.length} removed` : undefined,
    ].filter((part) => part !== undefined);
    if (counts.length > 0) details.push(counts.join(", ") + (data.truncated === true ? " (list truncated)" : ""));
    for (const [mark, paths] of [["+", added], ["~", modified], ["-", removed]] as const) {
        for (const file of paths.slice(0, 10)) details.push(`${mark} ${file}`);
        if (paths.length > 10) details.push(`${mark} … ${paths.length - 10} more`);
    }
    return { summary, tone: cause !== undefined ? "dim" : "normal", details };
}

/** "Edit src/a.ts", "Bash: npm test", "Grep: TODO": the same shape claude-hooks.ts uses. */
function toolLabel(data: Record<string, unknown>): string {
    const tool = str(data.tool) ?? "tool";
    const input = str(data.input);
    if (input === undefined) return tool;
    return str(data.file) !== undefined ? `${tool} ${input}` : `${tool}: ${input}`;
}

function renderClaude(event: TyrEvent, data: Record<string, unknown>, options: EventViewOptions, glyphs: typeof UNICODE_GLYPHS): Rendered {
    const session = shortSession(data.sessionId);
    const details: string[] = [];
    if (session !== undefined) details.push(`session ${str(data.sessionId)}`);
    const agent = str(data.agentType);
    // A subagent's tool calls are worth telling apart from the main agent's.
    const who = agent !== undefined ? `[${agent}] ` : "";

    switch (event.kind) {
        case "claude.session_start": {
            const extras = [str(data.source), str(data.model)].filter((part) => part !== undefined);
            return {
                summary: `session ${session ?? "?"} started${extras.length > 0 ? ` (${extras.join(", ")})` : ""}`,
                tone: "strong",
                details,
            };
        }
        case "claude.session_end": {
            const reason = str(data.reason);
            return { summary: `session ${session ?? "?"} ended${reason !== undefined ? ` (${reason})` : ""}`, tone: "strong", details };
        }
        case "claude.prompt": {
            const prompt = str(data.prompt);
            const length = num(data.promptLength);
            if (length !== undefined) details.push(`${length} characters`);
            if (prompt === undefined) return { summary: firstLine(event.message ?? "prompt"), tone: "strong", details };
            const cut = length !== undefined && length > prompt.length ? "…" : "";
            return { summary: `prompt: "${prompt}${cut}"`, tone: "strong", details };
        }
        case "claude.tool_use": {
            const tool = str(data.tool) ?? "";
            return { summary: who + toolLabel(data), tone: READ_ONLY_TOOLS.has(tool) ? "dim" : "normal", details };
        }
        case "claude.tool_result": {
            const tool = str(data.tool) ?? "";
            let duration = num(data.durationMs);
            if (duration === undefined && options.startedAt !== undefined) {
                const elapsed = Date.parse(event.ts) - Date.parse(options.startedAt);
                if (Number.isFinite(elapsed) && elapsed >= 0) duration = elapsed;
            }
            const durationText = duration !== undefined ? ` ${formatDuration(duration)}` : "";
            const error = str(data.error);
            if (error !== undefined) details.push(`error: ${error}`);
            if (data.success === false) {
                const why = data.interrupted === true ? "interrupted" : error !== undefined ? firstLine(error) : "failed";
                return { summary: who + toolLabel(data), tone: "normal", outcome: { text: `${glyphs.failure} ${why}`, tone: "bad" }, details };
            }
            // Successful results repeat their tool_use line, so they recede.
            return {
                summary: who + toolLabel(data),
                tone: "dim",
                outcome: { text: `${glyphs.success}${durationText}`, tone: READ_ONLY_TOOLS.has(tool) ? "dim" : "good" },
                details,
            };
        }
        case "claude.stop": {
            const last = str(data.lastMessage);
            if (last !== undefined) details.push(`last message: ${last}`);
            return { summary: "finished responding", tone: "strong", details };
        }
        case "claude.subagent_stop":
            return { summary: `subagent${agent !== undefined ? ` ${agent}` : ""} finished`, tone: "normal", details };
        case "claude.notification": {
            const text = str(data.message) ?? str(data.title) ?? str(data.notificationType);
            return { summary: `notification: ${text ?? firstLine(event.message ?? "(empty)")}`, tone: "warn", details };
        }
        case "claude.compact": {
            const trigger = str(data.trigger);
            return { summary: `compacting context${trigger !== undefined ? ` (${trigger})` : ""}`, tone: "dim", details };
        }
        case "claude.hook":
            return { summary: `${str(data.hookEvent) ?? "unknown"} hook`, tone: "dim", details };
        default:
            return { summary: firstLine(event.message ?? event.kind), tone: "normal", details };
    }
}

function renderCheck(event: TyrEvent, data: Record<string, unknown>, glyphs: typeof UNICODE_GLYPHS): Rendered {
    const name = str(data.name) ?? str(data.check) ?? str(data.command);
    const text = firstLine(event.message ?? (name !== undefined ? `${event.kind.slice("check.".length)} ${name}` : event.kind));
    if (event.kind === "check.passed") return { summary: text, tone: "normal", outcome: { text: glyphs.success, tone: "good" } };
    if (event.kind === "check.failed") return { summary: text, tone: "normal", outcome: { text: glyphs.failure, tone: "bad" } };
    return { summary: text, tone: "normal" };
}

function render(event: TyrEvent, options: EventViewOptions): Rendered {
    const data = event.data ?? {};
    const glyphs = options.unicode ? UNICODE_GLYPHS : ASCII_GLYPHS;
    const arrow = options.unicode ? "→" : "->";
    if (event.kind.startsWith("daemon.")) return renderDaemon(event, data, arrow);
    if (event.kind.startsWith("git.")) return renderGit(event, data, arrow);
    if (event.kind.startsWith("fs.")) return renderFs(event, data);
    if (event.kind.startsWith("claude.")) return renderClaude(event, data, options, glyphs);
    if (event.kind.startsWith("check.")) return renderCheck(event, data, glyphs);
    if (event.kind === "init.completed") {
        const files = num(data.fileCount);
        const language = str(data.primaryLanguage);
        const extras = [files !== undefined ? plural(files, "file") : undefined, language].filter((part) => part !== undefined);
        const base = firstLine(event.message ?? "Initialized");
        return { summary: `${base}${extras.length > 0 ? ` (${extras.join(", ")})` : ""}`, tone: "strong" };
    }
    // action.taken and every kind nobody has taught this file yet.
    return { summary: firstLine(event.message ?? event.kind), tone: "normal" };
}

/* -------------------------------------------------------------------------
 * Layout
 * ---------------------------------------------------------------------- */

/** Cut `text` to `max` visible characters, marking the cut. */
function truncate(text: string, max: number, unicode: boolean): string {
    const chars = Array.from(text);
    if (chars.length <= max) return text;
    const ellipsis = unicode ? "…" : "...";
    if (max <= ellipsis.length) return chars.slice(0, Math.max(0, max)).join("");
    return chars.slice(0, max - Array.from(ellipsis).length).join("") + ellipsis;
}

function tone(text: string, which: Tone, color: boolean): string {
    const code = TONE_CODES[which];
    return code === null ? text : paint(text, code, color);
}

/**
 * Render one event: a single line, plus indented detail lines under
 * `verbose`. No trailing newline. Width, when given, bounds the first line
 * (colour codes excluded); detail lines are truncated to it too.
 */
export function formatEvent(event: TyrEvent, options: EventViewOptions): string {
    const now = options.now ?? new Date();
    const style = SOURCE_STYLES[event.source] ?? UNKNOWN_SOURCE;
    const glyph = options.unicode ? style.unicode : style.ascii;
    const clock = formatClock(event.ts, now);
    const source = event.source.padEnd(SOURCE_COLUMN);
    const rendered = render(event, options);

    // Visible prefix: "HH:MM:SS g source  ".
    const prefixLength = clock.length + 1 + 1 + 1 + source.length + 2;
    const outcomeLength = rendered.outcome !== undefined ? 2 + Array.from(rendered.outcome.text).length : 0;
    let summary = rendered.summary;
    if (options.width !== undefined && options.width > 0) {
        summary = truncate(summary, Math.max(10, options.width - prefixLength - outcomeLength), options.unicode);
    }

    const { color } = options;
    let line =
        paint(clock, SGR.dim, color) +
        " " +
        paint(glyph, style.color, color) +
        " " +
        paint(source, style.color, color) +
        "  " +
        tone(summary, rendered.tone, color);
    if (rendered.outcome !== undefined) {
        line += "  " + tone(rendered.outcome.text, rendered.outcome.tone, color);
    }

    if (!options.verbose) return line;

    const indent = " ".repeat(clock.length + 3);
    const details = [`${event.kind}${event.id !== "" ? `  ${event.id}` : ""}`, ...(rendered.details ?? [])];
    const lines = details.map((detail) => {
        const text = options.width !== undefined && options.width > 0 ? truncate(detail, Math.max(10, options.width - indent.length), options.unicode) : detail;
        return indent + paint(text, SGR.dim, color);
    });
    return [line, ...lines].join("\n");
}

/**
 * A stateful formatter for a stream: pairs each claude.tool_result with its
 * claude.tool_use (by toolUseId) so a result without `durationMs` still
 * shows how long the call took. Only a bounded number of open calls is
 * remembered, so a session that never reports results cannot grow it.
 */
export function createEventFormatter(options: Omit<EventViewOptions, "startedAt">): (event: TyrEvent) => string {
    const open = new Map<string, string>();
    const MAX_OPEN = 512;
    return (event) => {
        const id = str(event.data?.toolUseId);
        let startedAt: string | undefined;
        if (id !== undefined && event.kind === "claude.tool_use") {
            open.set(id, event.ts);
            if (open.size > MAX_OPEN) {
                const oldest = open.keys().next().value;
                if (oldest !== undefined) open.delete(oldest);
            }
        } else if (id !== undefined && event.kind === "claude.tool_result") {
            startedAt = open.get(id);
            open.delete(id);
        }
        return formatEvent(event, { ...options, now: options.now ?? new Date(), startedAt });
    };
}
