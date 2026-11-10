// Claude Code session transcripts (PLANNING.md 2.9, the secondary source).
//
// Hooks (claude-hooks.ts) are how Tyr observes sessions live. Transcripts
// are what Claude Code writes regardless: one JSON Lines file per session
// under `~/.claude/projects/<encoded project path>/<session id>.jsonl`. They
// let Tyr look back at sessions that ran before the hooks were installed.
//
// The encoded directory name is the absolute project path with every
// character other than an ASCII letter or digit replaced by "-":
//
//   /Users/me/Tyr               -> -Users-me-Tyr
//   /Users/me/Unreal/My_Game    -> -Users-me-Unreal-My-Game
//   /repo/.claude/worktrees/x   -> -repo--claude-worktrees-x
//
// (Checked against a real ~/.claude/projects, 2026-11. The format is Claude
// Code's private detail and may change, which is why this is the secondary
// source and everything here tolerates surprises.)
//
// Each line is one record with a `type`. The ones read here: "user" and
// "assistant" (with `timestamp`, `sessionId`, and `message.content[]`, where
// an assistant's tool calls are `{ type: "tool_use", name }` items). Unknown
// types and unparseable lines are skipped. Nothing here prints or throws.

import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";

export interface TranscriptLocationOptions {
    /** Home directory holding `.claude/`. Default: os.homedir(). Tests pass a temp dir. */
    home?: string;
}

/** `/Users/me/Tyr` -> `-Users-me-Tyr`. */
export function encodeProjectPath(root: string): string {
    return path.resolve(root).replace(/[^A-Za-z0-9]/g, "-");
}

/** `~/.claude/projects/<encoded root>`. The directory may not exist. */
export function transcriptsDir(root: string, options: TranscriptLocationOptions = {}): string {
    return path.join(options.home ?? os.homedir(), ".claude", "projects", encodeProjectPath(root));
}

export interface TranscriptFile {
    file: string;
    sessionId: string;
    /** Last modification, a cheap "when was this session last active". */
    modifiedAt: string;
    size: number;
}

/**
 * The session transcripts Claude Code kept for `root`, most recently
 * modified first. [] when there are none (or no ~/.claude at all).
 */
export async function findSessionTranscripts(
    root: string,
    options: TranscriptLocationOptions = {},
): Promise<TranscriptFile[]> {
    const dir = transcriptsDir(root, options);
    let names: string[];
    try {
        names = await fs.readdir(dir);
    } catch {
        return [];
    }
    const files: TranscriptFile[] = [];
    for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const file = path.join(dir, name);
        const stat = await fs.stat(file).catch(() => null);
        if (!stat?.isFile()) continue;
        files.push({
            file,
            sessionId: name.slice(0, -".jsonl".length),
            modifiedAt: stat.mtime.toISOString(),
            size: stat.size,
        });
    }
    return files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

export interface TranscriptSummary {
    file: string;
    /** From the records; falls back to the file name. */
    sessionId: string;
    /** Earliest / latest record timestamp, or null when none had one. */
    startedAt: string | null;
    endedAt: string | null;
    /** User records that carry a typed prompt (not tool results). */
    prompts: number;
    /** Tool calls by tool name. */
    toolUses: Record<string, number>;
    totalToolUses: number;
    /** Lines that were not valid JSON (a write in progress, corruption). */
    skippedLines: number;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Whether a user record is a typed prompt rather than a tool result coming back. */
function isPrompt(message: unknown): boolean {
    if (!isObject(message)) return false;
    const content = message.content;
    if (typeof content === "string") return content.trim() !== "";
    if (!Array.isArray(content)) return false;
    return content.some((item) => isObject(item) && item.type === "text");
}

/**
 * Summarize one transcript, reading it line by line (they grow to tens of
 * megabytes). Null only when the file cannot be opened.
 */
export async function readTranscriptSummary(file: string): Promise<TranscriptSummary | null> {
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) return null;

    const summary: TranscriptSummary = {
        file,
        sessionId: path.basename(file, ".jsonl"),
        startedAt: null,
        endedAt: null,
        prompts: 0,
        toolUses: {},
        totalToolUses: 0,
        skippedLines: 0,
    };
    let sawSessionId = false;
    let startMs = Infinity;
    let endMs = -Infinity;

    try {
        const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
        for await (const line of lines) {
            if (line.trim() === "") continue;
            let record: unknown;
            try {
                record = JSON.parse(line);
            } catch {
                summary.skippedLines++;
                continue;
            }
            if (!isObject(record)) continue;

            if (!sawSessionId && typeof record.sessionId === "string" && record.sessionId !== "") {
                summary.sessionId = record.sessionId;
                sawSessionId = true;
            }
            if (typeof record.timestamp === "string") {
                const ms = Date.parse(record.timestamp);
                if (!Number.isNaN(ms)) {
                    if (ms < startMs) startMs = ms;
                    if (ms > endMs) endMs = ms;
                }
            }
            const message = record.message;
            if (record.type === "user" && record.isMeta !== true && isPrompt(message)) {
                summary.prompts++;
            } else if (record.type === "assistant" && isObject(message) && Array.isArray(message.content)) {
                for (const item of message.content) {
                    if (!isObject(item) || item.type !== "tool_use") continue;
                    const name = typeof item.name === "string" && item.name !== "" ? item.name : "unknown";
                    summary.toolUses[name] = (summary.toolUses[name] ?? 0) + 1;
                    summary.totalToolUses++;
                }
            }
        }
    } catch {
        // Truncated or vanished mid-read: report what was read.
    }

    if (startMs !== Infinity) summary.startedAt = new Date(startMs).toISOString();
    if (endMs !== -Infinity) summary.endedAt = new Date(endMs).toISOString();
    return summary;
}
