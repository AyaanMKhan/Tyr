// Human-readable rendering of a StatusReport for `tyr status`.
//
// Pure: no I/O, no capability detection, no clock unless the caller omits
// `now`. cli/commands/status.ts collects the report (core/status.ts), asks the
// reporter's probes for colour and Unicode, and prints the lines returned
// here. `--json` never comes through this file: it prints the report itself.
//
// Layout, one section per source the collector reads:
//
//   Tyr status: my-app
//     /home/me/my-app
//
//   Project      TypeScript 82%, JavaScript 12%, JSON 6%
//   ...
//
// Normal mode keeps each section to a line or a few; `verbose` lists every
// command slot, every language, more findings, the check commands and the
// recent reports. Colours and glyphs come from ui/reporter.ts so status
// looks like the rest of the CLI.

import * as path from "node:path";
import { FINDING_SEVERITIES, type FindingSeverity } from "../core/reports.js";
import type {
    InitializedStatus,
    StatusCheck,
    StatusDrift,
    StatusEngine,
    StatusFinding,
    StatusFindings,
    StatusLastRun,
    StatusProject,
    StatusReport,
    UninitializedStatus,
} from "../core/status.js";
import { CHECK_KINDS } from "../engine/model.js";
import { formatDuration, formatUptime } from "./event-view.js";
import { paint, SGR } from "./reporter.js";

export interface StatusViewOptions {
    /** ANSI colours. Default false. */
    color?: boolean;
    /** Show everything (all commands, languages, findings, reports). Default false. */
    verbose?: boolean;
    /** Reference time for "3m ago". Default: the report's `collectedAt`. */
    now?: Date;
    /** Unicode glyphs; false falls back to ASCII. Default true. */
    unicode?: boolean;
}

/** Findings listed in normal mode; verbose lists every item the report carries. */
export const STATUS_VIEW_FINDINGS = 5;
/** Open check problems listed in normal mode. */
export const STATUS_VIEW_PROBLEMS = 3;
/** Languages listed in normal mode. */
export const STATUS_VIEW_LANGUAGES = 3;

/** Width of the label column ("Project      ..."). */
const LABEL_WIDTH = 15;
const INDENT = "  ";

interface Ctx {
    color: boolean;
    verbose: boolean;
    now: Date;
    glyph: { ok: string; fail: string; dot: string; arrow: string; warn: string; sep: string };
}

/** Render `report` as lines of text (no trailing newlines). */
export function renderStatus(report: StatusReport, options: StatusViewOptions = {}): string[] {
    const unicode = options.unicode !== false;
    const parsedNow = new Date(report.collectedAt);
    const ctx: Ctx = {
        color: options.color === true,
        verbose: options.verbose === true,
        now: options.now ?? (Number.isNaN(parsedNow.getTime()) ? new Date() : parsedNow),
        glyph: unicode ? { ok: "✓", fail: "✗", dot: "●", arrow: "→", warn: "!", sep: "·" } : { ok: "v", fail: "x", dot: "*", arrow: "->", warn: "!", sep: "-" },
    };
    return report.initialized ? renderInitialized(report, ctx) : renderUninitialized(report, ctx);
}

/* -------------------------------------------------------------------------
 * Not initialized
 * ---------------------------------------------------------------------- */

function renderUninitialized(report: UninitializedStatus, ctx: Ctx): string[] {
    const why = report.reason === "no-config" ? " (.tyr/ exists but has no tyr.json)" : "";
    return [`Tyr is not initialized in ${report.root}${why}.`, `Run ${paint(`"${report.suggestion}"`, SGR.bold, ctx.color)} to set it up.`];
}

/* -------------------------------------------------------------------------
 * Initialized
 * ---------------------------------------------------------------------- */

function renderInitialized(report: InitializedStatus, ctx: Ctx): string[] {
    const name = report.project?.name ?? path.basename(report.root);
    const lines: string[] = [
        `${paint("Tyr status:", SGR.bold, ctx.color)} ${paint(name, SGR.cyan, ctx.color)}`,
        INDENT + paint(report.root, SGR.dim, ctx.color),
        "",
    ];
    lines.push(...projectSection(report.project, ctx));
    lines.push(...daemonSection(report, ctx));
    lines.push(...lastRunSection(report.lastRun, ctx));
    lines.push(...engineSection(report.engine, ctx));
    lines.push(...findingsSection(report.findings, ctx));
    lines.push(...driftSection(report.drift, ctx));
    if (report.warnings.length > 0) {
        lines.push("", paint(`Warnings (${report.warnings.length})`, SGR.bold, ctx.color));
        for (const warning of report.warnings) {
            const text = ctx.verbose ? `${warning.source}: ${warning.message}` : warning.message;
            lines.push(`${INDENT}${paint(ctx.glyph.warn, SGR.yellow, ctx.color)} ${text}`);
        }
    }
    return lines;
}

/** "Label        value", the label bold and padded. */
function row(label: string, value: string, ctx: Ctx): string {
    return paint(label.padEnd(LABEL_WIDTH), SGR.bold, ctx.color) + value;
}

/** A continuation line aligned under a row's value. */
function cont(value: string): string {
    return " ".repeat(LABEL_WIDTH) + value;
}

function dim(text: string, ctx: Ctx): string {
    return paint(text, SGR.dim, ctx.color);
}

/** "just now", "45s ago", "2h 13m ago"; "never" for null; the raw text if unparseable. */
export function formatAgo(iso: string | null, now: Date): string {
    if (iso === null) return "never";
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return iso;
    const diff = now.getTime() - ms;
    if (diff < 5_000) return "just now";
    return `${formatUptime(diff)} ago`;
}

function plural(count: number, word: string): string {
    return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function shortHash(hash: string | null): string {
    return hash === null ? "unknown" : hash.slice(0, 7);
}

/* ----- Project --------------------------------------------------------- */

function projectSection(project: StatusProject | null, ctx: Ctx): string[] {
    if (project === null) {
        return [row("Project", paint("profile unavailable (tyr.json unreadable; see warnings)", SGR.yellow, ctx.color), ctx)];
    }
    const lines: string[] = [];

    // Languages
    const languages = ctx.verbose ? project.languages : project.languages.slice(0, STATUS_VIEW_LANGUAGES);
    let languageText: string;
    if (languages.length === 0) {
        languageText = project.primaryLanguage ?? "none detected";
    } else {
        languageText = languages
            .map((language) => {
                const pct = `${Math.round(language.percentage)}%`;
                return ctx.verbose ? `${language.name} ${pct} (${plural(language.fileCount, "file")})` : `${language.name} ${pct}`;
            })
            .join(", ");
        const hidden = project.languages.length - languages.length;
        if (hidden > 0) languageText += `, +${hidden} more`;
    }
    lines.push(row("Project", languageText, ctx));

    if (project.frameworks.length > 0) lines.push(row("Frameworks", project.frameworks.join(", "), ctx));

    const tooling: string[] = [];
    if (project.packageManager !== null) tooling.push(project.packageManager);
    if (project.workspace !== null) {
        tooling.push(`${project.workspace.tool} workspace (${plural(project.workspace.packages.length, "package")})`);
    }
    if (tooling.length > 0) lines.push(row("Packages", tooling.join(` ${ctx.glyph.sep} `), ctx));
    if (ctx.verbose && project.workspace !== null) {
        for (const pkg of project.workspace.packages) lines.push(cont(dim(pkg, ctx)));
    }

    // Commands
    if (ctx.verbose) {
        let first = true;
        for (const kind of CHECK_KINDS) {
            const command = project.commands[kind];
            const text =
                command === null
                    ? dim(`${kind.padEnd(10)} not configured`, ctx)
                    : `${kind.padEnd(10)} ${command.command} ${dim(`(${command.tool}, ${command.source})`, ctx)}`;
            lines.push(first ? row("Commands", text, ctx) : cont(text));
            first = false;
        }
    } else {
        const configured = CHECK_KINDS.flatMap((kind) => {
            const command = project.commands[kind];
            return command === null ? [] : [`${kind}: ${command.command}`];
        });
        lines.push(row("Commands", configured.length === 0 ? dim("none configured", ctx) : configured.join(` ${ctx.glyph.sep} `), ctx));
    }

    if (ctx.verbose) {
        const git = project.git.isRepo
            ? `branch ${project.git.branch ?? "unknown"} at init${project.git.remote === null ? "" : `, remote ${project.git.remote}`}`
            : "not a git repository at init";
        lines.push(row("Git", git, ctx));
        lines.push(row("Initialized", `${formatAgo(project.initializedAt, ctx.now)} by Tyr ${project.tyrVersion} (config v${project.configVersion})`, ctx));
        if (project.migrated.length > 0) lines.push(cont(dim(`migrated on read: ${project.migrated.join(", ")}`, ctx)));
    }
    return lines;
}

/* ----- Background process ---------------------------------------------- */

function daemonSection(report: InitializedStatus, ctx: Ctx): string[] {
    const { daemon } = report;
    let text: string;
    if (daemon.running) {
        const up = daemon.uptimeMs === null ? "" : `, up ${formatUptime(daemon.uptimeMs)}`;
        text = `${paint(ctx.glyph.dot, SGR.green, ctx.color)} running (pid ${daemon.pid ?? "unknown"}${up})`;
    } else if (daemon.stale) {
        const pid = daemon.pid === null ? "" : ` for pid ${daemon.pid}`;
        text = `${paint(ctx.glyph.dot, SGR.yellow, ctx.color)} not running (stale PID file${pid}; "tyr start" replaces it)`;
    } else {
        text = `${paint(ctx.glyph.dot, SGR.dim, ctx.color)} not running ${dim('(start it with "tyr start")', ctx)}`;
    }
    return [row("Background", text, ctx)];
}

/* ----- Last run -------------------------------------------------------- */

function countsText(counts: Record<FindingSeverity, number>): string {
    const parts = FINDING_SEVERITIES.filter((severity) => counts[severity] > 0).map((severity) =>
        severity === "critical" || severity === "info" ? `${counts[severity]} ${severity}` : plural(counts[severity], severity),
    );
    return parts.length === 0 ? "no findings" : parts.join(", ");
}

function lastRunSection(lastRun: StatusLastRun, ctx: Ctx): string[] {
    const runs = lastRun.runCount === 0 ? "no runs yet" : plural(lastRun.runCount, "run");
    const lines = [row("Last run", lastRun.lastRunAt === null ? runs : `${formatAgo(lastRun.lastRunAt, ctx.now)} (${runs})`, ctx)];
    const reports = ctx.verbose ? lastRun.recentReports : lastRun.recentReports.slice(0, 1);
    if (reports.length === 0) {
        if (ctx.verbose) lines.push(row("Reports", dim("none yet", ctx), ctx));
        return lines;
    }
    if (ctx.verbose) {
        lines.push(row("Reports", `${lastRun.reportCount} on disk; newest first:`, ctx));
        for (const report of reports) {
            lines.push(
                cont(
                    `${report.id} ${dim(`(${report.kind}, ${formatAgo(report.createdAt, ctx.now)})`, ctx)} ${report.title}: ${countsText(report.findingCounts)}`,
                ),
            );
        }
    } else {
        const latest = reports[0]!;
        lines.push(
            row(
                "Latest report",
                `${latest.title} ${dim(`(${latest.kind}, ${formatAgo(latest.createdAt, ctx.now)})`, ctx)}: ${countsText(latest.findingCounts)}`,
                ctx,
            ),
        );
    }
    return lines;
}

/* ----- Engine ---------------------------------------------------------- */

function checkLine(check: StatusCheck, ctx: Ctx): string {
    const passed = check.outcome === "passed";
    const mark = passed ? paint(ctx.glyph.ok, SGR.green, ctx.color) : paint(ctx.glyph.fail, SGR.red, ctx.color);
    let outcome: string = check.outcome;
    if (!passed && check.exitCode !== null && check.outcome === "failed") outcome += ` (exit ${check.exitCode})`;
    let text = `${mark} ${check.kind.padEnd(10)} ${outcome} ${formatAgo(check.finishedAt, ctx.now)}`;
    if (!passed) {
        text += dim(` ${ctx.glyph.sep} ${check.lastPassedAt === null ? "never passed" : `last passed ${formatAgo(check.lastPassedAt, ctx.now)}`}`, ctx);
    }
    if (ctx.verbose) text += dim(` ${ctx.glyph.sep} ${check.command}, ${formatDuration(check.durationMs)}`, ctx);
    return text;
}

function engineSection(engine: StatusEngine | null, ctx: Ctx): string[] {
    if (engine === null) return [row("Checks", dim("none run yet", ctx), ctx)];
    const lines: string[] = [];
    if (engine.checks.length === 0) {
        lines.push(row("Checks", dim("none run yet", ctx), ctx));
    } else {
        engine.checks.forEach((check, index) => {
            lines.push(index === 0 ? row("Checks", checkLine(check, ctx), ctx) : cont(checkLine(check, ctx)));
        });
    }
    if (engine.problems.length > 0) {
        const regressions = engine.problems.filter((problem) => problem.regression).length;
        const summary = `${plural(engine.problems.length, "open problem")}${regressions > 0 ? ` (${plural(regressions, "regression")})` : ""}`;
        lines.push(row("Problems", paint(summary, SGR.red, ctx.color), ctx));
        const shown = ctx.verbose ? engine.problems : engine.problems.slice(0, STATUS_VIEW_PROBLEMS);
        for (const problem of shown) {
            const tag = problem.regression ? " [regression]" : "";
            lines.push(cont(`${problem.title}${tag} ${dim(`since ${formatAgo(problem.firstSeenAt, ctx.now)}`, ctx)}`));
            if (ctx.verbose && problem.detail.trim() !== "") {
                const first = problem.detail.trim().split("\n")[0]!;
                lines.push(cont(INDENT + dim(first, ctx)));
            }
        }
        if (shown.length < engine.problems.length) lines.push(cont(dim(`+${engine.problems.length - shown.length} more`, ctx)));
    }
    if (ctx.verbose && engine.workingTree !== null) {
        const tree = engine.workingTree;
        lines.push(
            row(
                "Working tree",
                `${plural(tree.filesChanged, "file")} changed (+${tree.additions} -${tree.deletions}), ${tree.untracked} untracked ${dim(`(as of ${formatAgo(tree.takenAt, ctx.now)})`, ctx)}`,
                ctx,
            ),
        );
    }
    return lines;
}

/* ----- Findings -------------------------------------------------------- */

const SEVERITY_COLOR: Record<FindingSeverity, string> = {
    critical: SGR.red,
    error: SGR.red,
    warning: SGR.yellow,
    info: SGR.blue,
};

function findingLine(finding: StatusFinding, ctx: Ctx): string {
    const severity = paint(finding.severity.padEnd(8), SEVERITY_COLOR[finding.severity], ctx.color);
    const where = finding.file === undefined ? "" : `${finding.file}${finding.line === undefined ? "" : `:${finding.line}`} `;
    const tag = finding.regression === true ? " [regression]" : "";
    return `${severity} ${where}${finding.title}${tag}`;
}

function findingsSection(findings: StatusFindings, ctx: Ctx): string[] {
    if (findings.source === "none") return [row("Findings", dim("none recorded yet", ctx), ctx)];
    if (findings.total === 0) {
        return [
            row("Findings", `${paint(ctx.glyph.ok, SGR.green, ctx.color)} none open ${dim(`(as of ${formatAgo(findings.updatedAt, ctx.now)})`, ctx)}`, ctx),
        ];
    }
    const regressions = findings.regressions > 0 ? `, ${plural(findings.regressions, "regression")}` : "";
    const lines = [row("Findings", `${findings.total} open: ${countsText(findings.counts)}${regressions}`, ctx)];
    if (ctx.verbose) {
        const from = findings.source === "engine" ? "last review pass" : `report ${findings.reportId ?? "unknown"}`;
        const threshold = findings.threshold === null ? "" : `, threshold ${findings.threshold}`;
        lines.push(cont(dim(`from the ${from}, ${formatAgo(findings.updatedAt, ctx.now)}${threshold}`, ctx)));
    }
    const shown = ctx.verbose ? findings.items : findings.items.slice(0, STATUS_VIEW_FINDINGS);
    for (const finding of shown) lines.push(cont(findingLine(finding, ctx)));
    const hidden = findings.total - shown.length;
    if (hidden > 0) {
        lines.push(cont(dim(`+${hidden} more${ctx.verbose ? "" : " (--verbose shows more)"}`, ctx)));
    }
    return lines;
}

/* ----- Drift ----------------------------------------------------------- */

/** True when anything is known to have changed since the index. */
export function hasDrift(drift: StatusDrift): boolean {
    return (
        drift.headChanged === true ||
        (drift.fileCountDelta !== null && drift.fileCountDelta !== 0) ||
        (drift.filesAdded ?? 0) > 0 ||
        (drift.filesRemoved ?? 0) > 0
    );
}

function signed(n: number): string {
    return n > 0 ? `+${n}` : String(n);
}

function driftSection(drift: StatusDrift, ctx: Ctx): string[] {
    const lines: string[] = [];
    const drifted = hasDrift(drift);
    const indexed = drift.indexedAt === null ? "" : ` ${dim(`(indexed ${formatAgo(drift.indexedAt, ctx.now)})`, ctx)}`;

    if (!drifted) {
        const known = drift.headChanged !== null || drift.fileCountDelta !== null;
        const text = known ? `${paint(ctx.glyph.ok, SGR.green, ctx.color)} up to date with the index` : dim("unknown", ctx);
        lines.push(row("Drift", text + indexed, ctx));
        if (ctx.verbose) lines.push(...driftDetails(drift, ctx));
        return lines;
    }

    lines.push(row("Drift", paint("changed since the index", SGR.yellow, ctx.color) + indexed, ctx));
    lines.push(...driftDetails(drift, ctx));
    lines.push(cont(dim('Run "tyr init --force" to reindex.', ctx)));
    return lines;
}

function driftDetails(drift: StatusDrift, ctx: Ctx): string[] {
    const lines: string[] = [];
    if (!drift.isRepo) {
        lines.push(cont("HEAD   not a git repository"));
    } else if (drift.indexedHead !== null || drift.currentHead !== null) {
        const branch = drift.currentBranch === null ? "" : ` on ${drift.currentBranch}`;
        if (drift.headChanged === false) {
            lines.push(cont(`HEAD   ${shortHash(drift.currentHead)}${branch} (unchanged)`));
        } else {
            let since = "";
            if (drift.commitsSinceIndex !== null) since = `, ${plural(drift.commitsSinceIndex, "commit")} since index`;
            else if (drift.headChanged === true) since = ", indexed commit not an ancestor";
            lines.push(cont(`HEAD   ${shortHash(drift.indexedHead)} ${ctx.glyph.arrow} ${shortHash(drift.currentHead)}${branch}${since}`));
        }
    }
    if (drift.indexedFileCount !== null || drift.currentFileCount !== null) {
        let text: string;
        if (drift.currentFileCount === null) {
            text = `Files  ${drift.indexedFileCount} at index (current count not scanned)`;
        } else if (drift.indexedFileCount === null) {
            text = `Files  ${drift.currentFileCount} now`;
        } else {
            text = `Files  ${drift.indexedFileCount} ${ctx.glyph.arrow} ${drift.currentFileCount}`;
            if (drift.fileCountDelta !== null && drift.fileCountDelta !== 0) text += ` (${signed(drift.fileCountDelta)})`;
        }
        const churn: string[] = [];
        if ((drift.filesAdded ?? 0) > 0) churn.push(`${drift.filesAdded} added`);
        if ((drift.filesRemoved ?? 0) > 0) churn.push(`${drift.filesRemoved} removed`);
        if (churn.length > 0) text += `: ${churn.join(", ")}`;
        lines.push(cont(text));
    }
    return lines;
}
