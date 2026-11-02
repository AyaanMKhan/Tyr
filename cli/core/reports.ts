// Report writer: Tyr's durable, human-readable output under `.tyr/reports/`.
//
// Every review, check run or other piece of analysis Tyr wants a person to
// read later becomes one report: a machine-readable JSON document plus a
// rendered Markdown sibling with the same name.
//
//   .tyr/reports/20261101-142233-review-tighten-auth-checks.json
//   .tyr/reports/20261101-142233-review-tighten-auth-checks.md
//
// Naming: `<UTC yyyyMMdd-HHmmss>-<kind>-<slug>`. The UTC timestamp prefix makes
// names sort chronologically, contains no `:` (Windows-safe), and the slug is
// reduced to `[a-z0-9-]`. A name that already exists gets `-2`, `-3`, ...; the
// name is claimed with an exclusive create, so two writers in the same second
// can never overwrite each other. The file stem doubles as the report `id`.
//
// Retention: after each write, reports beyond `maxCount` (default 100) or
// older than `maxAgeDays` (default 30) are deleted, JSON and Markdown together.
// `.gitkeep` and any file not matching the report naming scheme are never
// touched. Settings can come from an optional block in `.tyr/tyr.json`:
//
//   "reports": { "maxCount": 100, "maxAgeDays": 30 }
//
// A value of 0 (or any non-positive / non-finite number) disables that rule.
//
// Public API:
//   writeReport(root, input, opts?)      -> Promise<TyrReport & { jsonFile, mdFile, pruned }>
//   listReports(root, { kind?, limit? }) -> Promise<ReportSummary[]>   newest first
//   readReport(root, id)                 -> Promise<TyrReport | null>
//   pruneReports(root, retention?, now?) -> Promise<PrunedReport[]>
//   retentionFromConfig(config)          -> ReportRetention            reads `reports` loosely
//   renderReportMarkdown(report)         -> string
//
// Typical use (pass the parsed tyr.json so its retention block applies):
//   const config = await readConfig(root);
//   await writeReport(root, { kind: "review", title, summary, findings }, { config });
//
// Like scaffold.ts this module is silent: it returns data and never prints.
// Writing throws on genuine I/O failure (the caller asked for a report and
// should know it was not written); retention is best-effort and never throws.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveTyrPaths, toJsonDocument, writeFileAtomic } from "./scaffold.js";

/* -------------------------------------------------------------------------
 * Model
 * ---------------------------------------------------------------------- */

export const REPORT_VERSION = 1;

export type FindingSeverity = "info" | "warning" | "error" | "critical";

/** Most severe first; also the Markdown section order. */
export const FINDING_SEVERITIES: readonly FindingSeverity[] = ["critical", "error", "warning", "info"];

export interface Finding {
    severity: FindingSeverity;
    title: string;
    detail?: string;
    /** Root-relative path, when the finding points at a file. */
    file?: string;
    line?: number;
    /** Identifier of the check or rule that produced the finding. */
    rule?: string;
}

/** Well-known kinds; any other string is accepted too. */
export type ReportKind = "review" | "check" | "run" | (string & {});

export interface ReportGitContext {
    branch: string | null;
    headCommit: string | null;
}

export interface TyrReport {
    version: typeof REPORT_VERSION;
    /** File stem, e.g. "20261101-142233-review-tighten-auth-checks". */
    id: string;
    kind: ReportKind;
    title: string;
    /** ISO-8601 UTC timestamp. */
    createdAt: string;
    summary: string;
    git?: ReportGitContext;
    findings: Finding[];
    /** Free-form, kind-specific payload. Must be JSON-serializable. */
    data?: Record<string, unknown>;
}

/** What callers supply; id, createdAt and version are assigned. */
export interface ReportInput {
    kind: ReportKind;
    title: string;
    summary?: string;
    git?: ReportGitContext;
    findings?: Finding[];
    data?: Record<string, unknown>;
}

export interface ReportRetention {
    /** Keep at most this many reports. Default 100; <= 0 disables. */
    maxCount?: number;
    /** Delete reports older than this. Default 30; <= 0 disables. */
    maxAgeDays?: number;
}

export const DEFAULT_REPORT_RETENTION: Required<ReportRetention> = { maxCount: 100, maxAgeDays: 30 };

export interface WriteReportOptions {
    /** Clock override (tests). Default `new Date()`. */
    now?: Date;
    /** Explicit retention; wins over `config`. `false` skips pruning. */
    retention?: ReportRetention | false;
    /** Parsed tyr.json (or anything); its `reports` block is read loosely. */
    config?: unknown;
}

export interface WrittenReport extends TyrReport {
    jsonFile: string;
    mdFile: string;
    /** Reports deleted by the retention pass that followed the write. */
    pruned: PrunedReport[];
}

export interface ReportSummary {
    id: string;
    kind: string;
    title: string;
    createdAt: string;
    summary: string;
    findingCounts: Record<FindingSeverity, number>;
    jsonFile: string;
}

export interface PrunedReport {
    id: string;
    reason: "count" | "age";
    /** Absolute paths actually deleted. */
    files: string[];
}

/* -------------------------------------------------------------------------
 * Naming
 * ---------------------------------------------------------------------- */

/** `<yyyyMMdd>-<HHmmss>-<rest>` — anything else in reports/ is not ours. */
const REPORT_STEM = /^(\d{8})-(\d{6})-([a-z0-9][a-z0-9-]*)$/;
const MAX_SLUG_LENGTH = 48;
const MAX_KIND_LENGTH = 24;
const MAX_SUFFIX = 1000;

function pad(value: number, width = 2): string {
    return String(value).padStart(width, "0");
}

/** UTC `yyyyMMdd-HHmmss`. */
export function formatReportTimestamp(date: Date): string {
    return (
        `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-` +
        `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
    );
}

/** Lowercase `[a-z0-9-]`, no leading/trailing/double dashes, length-capped. */
export function slugify(text: string, maxLength = MAX_SLUG_LENGTH, fallback = "report"): string {
    const slug = text
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, maxLength)
        .replace(/-+$/g, "");
    return slug === "" ? fallback : slug;
}

/** Base stem (without collision suffix) for a report created at `date`. */
export function reportBaseName(kind: string, title: string, date: Date): string {
    return `${formatReportTimestamp(date)}-${slugify(kind, MAX_KIND_LENGTH, "report")}-${slugify(title)}`;
}

/** Parse the timestamp prefix of a report stem; null when it is not one. */
function stemDate(stem: string): Date | null {
    const match = REPORT_STEM.exec(stem);
    if (match === null) return null;
    const [, day, time] = match;
    const ms = Date.UTC(
        Number(day.slice(0, 4)),
        Number(day.slice(4, 6)) - 1,
        Number(day.slice(6, 8)),
        Number(time.slice(0, 2)),
        Number(time.slice(2, 4)),
        Number(time.slice(4, 6)),
    );
    return Number.isNaN(ms) ? null : new Date(ms);
}

/** Ids are file stems; refuse anything that could escape reports/. */
function isSafeId(id: string): boolean {
    return REPORT_STEM.test(id);
}

/* -------------------------------------------------------------------------
 * Config
 * ---------------------------------------------------------------------- */

function numberOrUndefined(value: unknown): number | undefined {
    return typeof value === "number" && !Number.isNaN(value) ? value : undefined;
}

/**
 * Read `reports: { maxCount?, maxAgeDays? }` from a parsed tyr.json without
 * trusting its shape. Missing or wrongly typed values fall back to defaults.
 */
export function retentionFromConfig(config: unknown): ReportRetention {
    const block =
        config !== null && typeof config === "object" ? (config as { reports?: unknown }).reports : undefined;
    const source = block !== null && typeof block === "object" ? (block as Record<string, unknown>) : {};
    return {
        maxCount: numberOrUndefined(source.maxCount) ?? DEFAULT_REPORT_RETENTION.maxCount,
        maxAgeDays: numberOrUndefined(source.maxAgeDays) ?? DEFAULT_REPORT_RETENTION.maxAgeDays,
    };
}

/* -------------------------------------------------------------------------
 * Normalization and rendering
 * ---------------------------------------------------------------------- */

function normalizeSeverity(value: unknown): FindingSeverity {
    return FINDING_SEVERITIES.includes(value as FindingSeverity) ? (value as FindingSeverity) : "info";
}

/** Copy field by field so the on-disk shape never picks up stray keys. */
function normalizeFinding(finding: Finding): Finding {
    const out: Finding = { severity: normalizeSeverity(finding.severity), title: String(finding.title ?? "") };
    if (typeof finding.detail === "string" && finding.detail !== "") out.detail = finding.detail;
    if (typeof finding.file === "string" && finding.file !== "") out.file = finding.file;
    if (typeof finding.line === "number" && Number.isFinite(finding.line)) out.line = finding.line;
    if (typeof finding.rule === "string" && finding.rule !== "") out.rule = finding.rule;
    return out;
}

function countFindings(findings: readonly Finding[]): Record<FindingSeverity, number> {
    const counts: Record<FindingSeverity, number> = { critical: 0, error: 0, warning: 0, info: 0 };
    for (const finding of findings) counts[normalizeSeverity(finding.severity)] += 1;
    return counts;
}

const SEVERITY_HEADINGS: Record<FindingSeverity, string> = {
    critical: "Critical",
    error: "Errors",
    warning: "Warnings",
    info: "Info",
};

function location(finding: Finding): string {
    if (finding.file === undefined) return "";
    return finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`;
}

/** Human-readable rendering: title, metadata, summary, findings by severity. */
export function renderReportMarkdown(report: TyrReport): string {
    const lines: string[] = [`# ${report.title}`, ""];

    lines.push(`- **Kind:** ${report.kind}`);
    lines.push(`- **Created:** ${report.createdAt}`);
    if (report.git !== undefined) {
        const commit = report.git.headCommit === null ? "(no commit)" : report.git.headCommit.slice(0, 12);
        lines.push(`- **Git:** ${report.git.branch ?? "(no branch)"} @ ${commit}`);
    }
    lines.push(`- **Report id:** ${report.id}`);
    lines.push("");

    if (report.summary.trim() !== "") {
        lines.push("## Summary", "", report.summary.trim(), "");
    }

    const counts = countFindings(report.findings);
    lines.push("## Findings", "");
    if (report.findings.length === 0) {
        lines.push("No findings.", "");
    } else {
        const tally = FINDING_SEVERITIES.filter((severity) => counts[severity] > 0)
            .map((severity) => `${counts[severity]} ${severity}`)
            .join(", ");
        lines.push(`${report.findings.length} total: ${tally}.`, "");

        for (const severity of FINDING_SEVERITIES) {
            const group = report.findings.filter((finding) => finding.severity === severity);
            if (group.length === 0) continue;
            lines.push(`### ${SEVERITY_HEADINGS[severity]} (${group.length})`, "");
            for (const finding of group) {
                const where = location(finding);
                const parts = [`**${finding.title}**`];
                if (where !== "") parts.push(`\`${where}\``);
                if (finding.rule !== undefined) parts.push(`[${finding.rule}]`);
                lines.push(`- ${parts.join(" ")}`);
                if (finding.detail !== undefined) {
                    for (const detailLine of finding.detail.trim().split(/\r?\n/)) {
                        lines.push(`  ${detailLine}`);
                    }
                }
            }
            lines.push("");
        }
    }

    return `${lines.join("\n").trimEnd()}\n`;
}

/* -------------------------------------------------------------------------
 * Write
 * ---------------------------------------------------------------------- */

/**
 * Claim `<base>.json` (or `<base>-N.json`) with an exclusive create so that a
 * concurrent writer can never pick the same name. Returns the claimed stem.
 */
async function claimName(dir: string, base: string): Promise<string> {
    for (let attempt = 1; attempt <= MAX_SUFFIX; attempt++) {
        const stem = attempt === 1 ? base : `${base}-${attempt}`;
        try {
            // Also skip a stem whose .md exists (e.g. an orphan left behind).
            await fs.access(path.join(dir, `${stem}.md`));
            continue;
        } catch {
            // Free so far.
        }
        try {
            const handle = await fs.open(path.join(dir, `${stem}.json`), "wx");
            await handle.close();
            return stem;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
            throw error;
        }
    }
    throw new Error(`Could not find a free report name for ${base} in ${dir}`);
}

/**
 * Write a report as JSON + Markdown under `.tyr/reports/`, then apply
 * retention. Throws only if the report itself could not be written.
 */
export async function writeReport(
    root: string,
    input: ReportInput,
    opts: WriteReportOptions = {},
): Promise<WrittenReport> {
    const { reportsDir } = resolveTyrPaths(root);
    const now = opts.now ?? new Date();
    await fs.mkdir(reportsDir, { recursive: true });

    const kind = String(input.kind ?? "report");
    const title = String(input.title ?? "").trim() || "Untitled report";
    const id = await claimName(reportsDir, reportBaseName(kind, title, now));
    const jsonFile = path.join(reportsDir, `${id}.json`);
    const mdFile = path.join(reportsDir, `${id}.md`);

    const report: TyrReport = {
        version: REPORT_VERSION,
        id,
        kind,
        title,
        createdAt: now.toISOString(),
        summary: typeof input.summary === "string" ? input.summary : "",
        findings: (input.findings ?? []).map(normalizeFinding),
    };
    if (input.git !== undefined) {
        report.git = { branch: input.git.branch ?? null, headCommit: input.git.headCommit ?? null };
    }
    if (input.data !== undefined) report.data = input.data;

    try {
        // Markdown first: a reader that sees a complete JSON can rely on the
        // .md sibling existing too.
        await writeFileAtomic(mdFile, renderReportMarkdown(report));
        await writeFileAtomic(jsonFile, toJsonDocument(report));
    } catch (error) {
        await fs.rm(jsonFile, { force: true }).catch(() => undefined);
        await fs.rm(mdFile, { force: true }).catch(() => undefined);
        throw error;
    }

    let pruned: PrunedReport[] = [];
    if (opts.retention !== false) {
        const retention = opts.retention ?? retentionFromConfig(opts.config);
        pruned = await pruneReports(root, retention, now);
    }

    return { ...report, jsonFile, mdFile, pruned };
}

/* -------------------------------------------------------------------------
 * Read / list
 * ---------------------------------------------------------------------- */

/** Report stems present in reports/, from both .json and .md files. */
async function reportStems(reportsDir: string): Promise<Map<string, Set<".json" | ".md">>> {
    const stems = new Map<string, Set<".json" | ".md">>();
    let names: string[];
    try {
        names = await fs.readdir(reportsDir);
    } catch {
        return stems;
    }
    for (const name of names) {
        const ext = path.extname(name);
        if (ext !== ".json" && ext !== ".md") continue;
        const stem = name.slice(0, -ext.length);
        if (!REPORT_STEM.test(stem)) continue;
        const entry = stems.get(stem) ?? new Set();
        entry.add(ext);
        stems.set(stem, entry);
    }
    return stems;
}

function asReport(value: unknown, id: string): TyrReport | null {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const raw = value as Partial<TyrReport>;
    if (typeof raw.title !== "string" || typeof raw.kind !== "string") return null;
    const report: TyrReport = {
        version: REPORT_VERSION,
        id,
        kind: raw.kind,
        title: raw.title,
        createdAt: typeof raw.createdAt === "string" ? raw.createdAt : (stemDate(id)?.toISOString() ?? ""),
        summary: typeof raw.summary === "string" ? raw.summary : "",
        findings: Array.isArray(raw.findings)
            ? raw.findings.filter((f): f is Finding => f !== null && typeof f === "object").map(normalizeFinding)
            : [],
    };
    if (raw.git !== undefined && raw.git !== null && typeof raw.git === "object") report.git = raw.git;
    if (raw.data !== undefined && raw.data !== null && typeof raw.data === "object") report.data = raw.data;
    return report;
}

/** Full report by id, or null when missing, malformed, or the id is unsafe. */
export async function readReport(root: string, id: string): Promise<TyrReport | null> {
    if (!isSafeId(id)) return null;
    const { reportsDir } = resolveTyrPaths(root);
    try {
        const raw = await fs.readFile(path.join(reportsDir, `${id}.json`), "utf8");
        return asReport(JSON.parse(raw), id);
    } catch {
        return null;
    }
}

export interface ListReportsOptions {
    /** Only reports of this kind. */
    kind?: string;
    /** At most this many (newest first). */
    limit?: number;
}

/**
 * Report metadata, newest first. Reads each JSON; a report whose JSON is
 * unreadable (e.g. mid-write) falls back to what the file name says.
 */
export async function listReports(root: string, options: ListReportsOptions = {}): Promise<ReportSummary[]> {
    const { reportsDir } = resolveTyrPaths(root);
    const stems = await reportStems(reportsDir);
    const summaries: ReportSummary[] = [];

    for (const [id, exts] of stems) {
        if (!exts.has(".json")) continue;
        const jsonFile = path.join(reportsDir, `${id}.json`);
        const report = await readReport(root, id);
        let summary: ReportSummary;
        if (report !== null) {
            summary = {
                id,
                kind: report.kind,
                title: report.title,
                createdAt: report.createdAt,
                summary: report.summary,
                findingCounts: countFindings(report.findings),
                jsonFile,
            };
        } else {
            const rest = REPORT_STEM.exec(id)?.[3] ?? "";
            const dash = rest.indexOf("-");
            summary = {
                id,
                kind: dash === -1 ? rest : rest.slice(0, dash),
                title: dash === -1 ? "" : rest.slice(dash + 1),
                createdAt: stemDate(id)?.toISOString() ?? "",
                summary: "",
                findingCounts: countFindings([]),
                jsonFile,
            };
        }
        if (options.kind !== undefined && summary.kind !== options.kind) continue;
        summaries.push(summary);
    }

    summaries.sort((a, b) => {
        const byTime = Date.parse(b.createdAt || "0") - Date.parse(a.createdAt || "0");
        if (byTime !== 0 && !Number.isNaN(byTime)) return byTime;
        return b.id.localeCompare(a.id, "en", { numeric: true });
    });

    if (options.limit !== undefined && options.limit >= 0) return summaries.slice(0, options.limit);
    return summaries;
}

/* -------------------------------------------------------------------------
 * Retention
 * ---------------------------------------------------------------------- */

function isActive(limit: number | undefined): limit is number {
    return typeof limit === "number" && Number.isFinite(limit) && limit > 0;
}

/**
 * Delete reports beyond `maxCount` or older than `maxAgeDays` (age comes from
 * the file name's timestamp). Omitted fields use the defaults; pass 0 to
 * disable a rule. Only report-named .json/.md files are considered, and each
 * report's pair is removed together. Best-effort: never throws.
 */
export async function pruneReports(
    root: string,
    retention: ReportRetention = {},
    now: Date = new Date(),
): Promise<PrunedReport[]> {
    const maxCount = retention.maxCount ?? DEFAULT_REPORT_RETENTION.maxCount;
    const maxAgeDays = retention.maxAgeDays ?? DEFAULT_REPORT_RETENTION.maxAgeDays;
    if (!isActive(maxCount) && !isActive(maxAgeDays)) return [];

    const { reportsDir } = resolveTyrPaths(root);
    const pruned: PrunedReport[] = [];

    try {
        const stems = await reportStems(reportsDir);
        // Newest first: timestamp prefix, then numeric-aware stem for suffixes.
        const ordered = [...stems.keys()].sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
        const cutoff = isActive(maxAgeDays) ? now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000 : -Infinity;

        let kept = 0;
        for (const id of ordered) {
            let reason: PrunedReport["reason"] | null = null;
            const created = stemDate(id);
            if (created !== null && created.getTime() < cutoff) {
                reason = "age";
            } else if (isActive(maxCount) && kept >= maxCount) {
                reason = "count";
            } else {
                kept += 1;
            }
            if (reason === null) continue;

            const files: string[] = [];
            for (const ext of stems.get(id) ?? []) {
                const file = path.join(reportsDir, `${id}${ext}`);
                try {
                    await fs.rm(file);
                    files.push(file);
                } catch {
                    // Already gone or locked; retry on the next pass.
                }
            }
            if (files.length > 0) pruned.push({ id, reason, files });
        }
    } catch {
        // Retention must never break the write that triggered it.
    }

    return pruned;
}
