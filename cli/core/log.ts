// Tyr's own logging: level filtering, line formatting and size-capped
// rotation for `.tyr/logs/*.log`.
//
// Everything here is best-effort. A log write that fails (missing or
// read-only directory, a rotation race with another Tyr process) is dropped
// silently; logging must never break a command or the background process.

import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Levels a message can be written at, least to most severe. */
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Accepted thresholds: any level, or "silent" to write nothing. */
export const LOG_THRESHOLDS = [...LOG_LEVELS, "silent"] as const;
export type LogThreshold = (typeof LOG_THRESHOLDS)[number];

export const DEFAULT_LOG_LEVEL: LogThreshold = "info";
/** Environment variable read when no level was set explicitly. The daemon inherits it. */
export const LOG_LEVEL_ENV = "TYR_LOG_LEVEL";

/** Rotate once a log reaches this size (1 MiB). */
export const DEFAULT_MAX_LOG_BYTES = 1024 * 1024;
/** Rotated generations kept beside the live file (`.1` newest … `.3` oldest). */
export const DEFAULT_LOG_KEEP = 3;

/** Continuation lines of a multi-line message get this prefix. */
const CONTINUATION_INDENT = "    ";

const RANK: Record<LogThreshold, number> = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };

/* -------------------------------------------------------------------------
 * Level threshold
 * ---------------------------------------------------------------------- */

let explicitLevel: LogThreshold | undefined;

/** Parse a level name (case-insensitive). Throws on anything unknown. */
export function parseLogLevel(value: string): LogThreshold {
    const normalized = value.trim().toLowerCase();
    if ((LOG_THRESHOLDS as readonly string[]).includes(normalized)) {
        return normalized as LogThreshold;
    }
    throw new Error(`Invalid log level "${value}". Expected one of: ${LOG_THRESHOLDS.join(", ")}`);
}

/**
 * Set the process-wide threshold (from `--log-level`). It wins over
 * `TYR_LOG_LEVEL`. Pass undefined to go back to env/default resolution.
 */
export function setLogLevel(level: LogThreshold | undefined): void {
    explicitLevel = level;
}

/**
 * The effective threshold: an explicit `setLogLevel()` value, else a valid
 * `TYR_LOG_LEVEL`, else "info". An invalid env value is ignored rather than
 * failing every command.
 */
export function getLogLevel(): LogThreshold {
    if (explicitLevel !== undefined) {
        return explicitLevel;
    }
    const fromEnv = process.env[LOG_LEVEL_ENV];
    if (fromEnv !== undefined && fromEnv.trim() !== "") {
        try {
            return parseLogLevel(fromEnv);
        } catch {
            // Fall through to the default.
        }
    }
    return DEFAULT_LOG_LEVEL;
}

/** Whether a message at `level` passes the current threshold. */
export function isLogLevelEnabled(level: LogLevel, threshold: LogThreshold = getLogLevel()): boolean {
    return RANK[level] >= RANK[threshold];
}

/* -------------------------------------------------------------------------
 * Formatting
 * ---------------------------------------------------------------------- */

/**
 * `[<ISO timestamp>] <LEVEL> <message>` plus a newline. Further lines of a
 * multi-line message (stack traces) are indented, so every record still
 * starts with `[` and a grep for the timestamp or level finds whole records.
 */
export function formatLogLine(level: LogLevel, message: string, now: Date = new Date()): string {
    const lines = message.replace(/(?:\r?\n)+$/, "").split(/\r?\n/);
    const body = lines.map((line, index) => (index === 0 ? line : CONTINUATION_INDENT + line)).join("\n");
    return `[${now.toISOString()}] ${level.toUpperCase()} ${body}\n`;
}

/* -------------------------------------------------------------------------
 * Rotation
 * ---------------------------------------------------------------------- */

export interface RotationOptions {
    /** Rotate once the file is at least this many bytes. Default 1 MiB. */
    maxBytes?: number;
    /** Rotated files to keep (`file.1` … `file.N`). 0 discards the old log. Default 3. */
    keep?: number;
}

/**
 * Rotate `file` → `file.1` → `file.2` … when it has reached `maxBytes`,
 * dropping anything past `keep`. Returns true when this call rotated.
 *
 * Safe to run from several processes at once and never throws. The live
 * file is first claimed by renaming it to a name unique to this call, so
 * only one process moves a given generation; a loser of that race sees
 * ENOENT and simply carries on appending to the fresh file. Renames that
 * fail on Windows because another process has the file open (EPERM/EBUSY)
 * just postpone rotation to a later write. Data is never deleted except the
 * generation pushed past `keep`.
 */
export async function rotateFileIfLarge(file: string, options: RotationOptions = {}): Promise<boolean> {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_LOG_BYTES;
    const keep = Math.max(0, Math.floor(options.keep ?? DEFAULT_LOG_KEEP));
    try {
        const stat = await fs.stat(file);
        if (!stat.isFile() || stat.size < maxBytes) {
            return false;
        }
    } catch {
        return false; // Missing (nothing to rotate) or unreadable.
    }

    const claimed = `${file}.rotating-${process.pid}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    try {
        await fs.rename(file, claimed);
    } catch {
        return false; // Another process rotated first, or the file is busy.
    }

    try {
        if (keep === 0) {
            await fs.rm(claimed, { force: true });
            return true;
        }
        // Oldest first, so each rename lands on a slot that was just vacated.
        // rename() replaces an existing target, which drops generation `keep`.
        for (let generation = keep - 1; generation >= 1; generation--) {
            await fs.rename(`${file}.${generation}`, `${file}.${generation + 1}`).catch(() => undefined);
        }
        await fs.rename(claimed, `${file}.1`);
        return true;
    } catch {
        // The claimed file could not be moved into place. It stays on disk
        // under its temporary name rather than being lost.
        return true;
    }
}

/* -------------------------------------------------------------------------
 * Writing
 * ---------------------------------------------------------------------- */

export interface WriteLogOptions extends RotationOptions {
    /** Override the process threshold for this write (tests, special sinks). */
    threshold?: LogThreshold;
}

/**
 * Append one record to `file` if `level` passes the threshold: creates the
 * directory when missing, rotates first when the file is over its cap, then
 * appends. Never throws.
 */
export async function writeLog(
    file: string,
    level: LogLevel,
    message: string,
    options: WriteLogOptions = {},
): Promise<void> {
    if (!isLogLevelEnabled(level, options.threshold ?? getLogLevel())) {
        return;
    }
    try {
        // Formatted before any await, so the timestamp is when it was logged.
        const line = formatLogLine(level, message);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await rotateFileIfLarge(file, options);
        await fs.appendFile(file, line, "utf8");
    } catch {
        // Logging is best-effort: a failed log write must never break a command.
    }
}
