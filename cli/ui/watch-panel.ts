// cli/ui/watch-panel.ts — the live status panel under `tyr watch`
// (PLANNING.md 2.16, "live multi-line view").
//
// While `tyr watch` follows the journal on a terminal, a few lines stay
// pinned below the scrolling events and are redrawn in place:
//
//   ── live ──────────────────────────────────────────
//   daemon ● running, pid 4120, up 12m · claude ● working: Edit cli/x.ts (4s)
//   checks build ✓  typecheck ✓  test ✗  · running lint 3s
//   problems 1: test regressed · findings 2 (1 error) · alert: Tyr: test regressed (2m ago)
//
// Two parts:
//   - pure state: initialPanelState() from what is on disk, applyPanelEvent()
//     folds each journal event in, renderPanel() turns it into lines. Tested
//     without a terminal.
//   - LivePanel: the drawing. Every write to the screen goes through
//     print(), which erases the panel (cursor up N, clear to end of screen),
//     writes the text and redraws the panel underneath, in one write so it
//     does not flicker. Panel lines are cut to the terminal width, because a
//     wrapped line would break the "up N lines" arithmetic. A one-second
//     timer keeps elapsed times moving.

import type { TyrEvent } from "../core/events.js";
import type { EngineState } from "../engine/model.js";
import { formatDuration, formatUptime } from "./event-view.js";
import { paint, SGR } from "./reporter.js";

export interface PanelState {
    daemon: { running: boolean; pid: number | null; startedAt: string | null; crashed: boolean };
    /** The check running now, if any. */
    running: { kind: string; startedAt: string } | null;
    /** Last outcome per check kind, in first-seen order. */
    checks: { kind: string; outcome: string }[];
    /** Open problems: check kind and whether it is a regression. */
    problems: { kind: string; regression: boolean }[];
    /** Reported findings of the last review, with the count of error/critical ones. */
    findings: { total: number; serious: number } | null;
    claude: { busy: boolean; tool: string | null; at: string } | null;
    alert: { title: string; severity: string; at: string } | null;
}

export interface InitialPanelInput {
    daemon: { running: boolean; pid: number | null; startedAt: string | null };
    engine: EngineState | null;
    findings: { severity: string }[] | null;
}

const CHECK_ORDER = ["build", "typecheck", "lint", "test", "format"];

export function initialPanelState(input: InitialPanelInput): PanelState {
    const engine = input.engine;
    const checks: PanelState["checks"] = [];
    if (engine) {
        for (const kind of CHECK_ORDER) {
            const last = engine.checks[kind as keyof EngineState["checks"]]?.last;
            if (last) checks.push({ kind, outcome: last.outcome });
        }
    }
    return {
        daemon: { ...input.daemon, crashed: false },
        running: null,
        checks,
        problems: (engine?.problems ?? []).map((p) => ({ kind: p.kind, regression: p.regression })),
        findings:
            input.findings === null
                ? null
                : { total: input.findings.length, serious: input.findings.filter((f) => f.severity === "error" || f.severity === "critical").length },
        claude: null,
        alert: null,
    };
}

function str(value: unknown): string | undefined {
    return typeof value === "string" && value !== "" ? value : undefined;
}

function num(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function setCheck(checks: PanelState["checks"], kind: string, outcome: string): PanelState["checks"] {
    const next = checks.filter((c) => c.kind !== kind);
    next.push({ kind, outcome });
    return next.sort((a, b) => {
        const ia = CHECK_ORDER.indexOf(a.kind);
        const ib = CHECK_ORDER.indexOf(b.kind);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
}

/** Fold one journal event into the panel. Pure; unknown events change nothing. */
export function applyPanelEvent(state: PanelState, event: TyrEvent): PanelState {
    const data = event.data ?? {};
    switch (event.kind) {
        case "daemon.started":
            return { ...state, daemon: { running: true, pid: num(data.pid) ?? null, startedAt: event.ts, crashed: false } };
        case "daemon.stopped":
            return { ...state, daemon: { ...state.daemon, running: false, crashed: false }, running: null };
        case "daemon.crashed":
            return { ...state, daemon: { ...state.daemon, running: false, crashed: true }, running: null };
        case "check.started": {
            const kind = str(data.kind);
            return kind === undefined ? state : { ...state, running: { kind, startedAt: event.ts } };
        }
        case "check.passed":
        case "check.failed": {
            const run = (data.run ?? {}) as Record<string, unknown>;
            const kind = str(run.kind) ?? str(data.kind);
            if (kind === undefined) return state;
            const outcome = str(run.outcome) ?? (event.kind === "check.passed" ? "passed" : "failed");
            const wasPassing = state.checks.find((c) => c.kind === kind)?.outcome === "passed";
            let problems = state.problems;
            if (outcome === "passed") problems = problems.filter((p) => p.kind !== kind);
            else if (outcome !== "cancelled" && !problems.some((p) => p.kind === kind)) problems = [...problems, { kind, regression: wasPassing }];
            return {
                ...state,
                running: state.running?.kind === kind ? null : state.running,
                checks: outcome === "cancelled" ? state.checks : setCheck(state.checks, kind, outcome),
                problems,
            };
        }
        case "review.completed": {
            const total = num(data.total);
            if (total === undefined) return state;
            const counts = (data.counts ?? {}) as Record<string, unknown>;
            return { ...state, findings: { total, serious: (num(counts.error) ?? 0) + (num(counts.critical) ?? 0) } };
        }
        case "notification":
            return { ...state, alert: { title: str(data.title) ?? event.message ?? "notification", severity: str(data.severity) ?? "info", at: event.ts } };
        case "claude.prompt":
        case "claude.session_start":
            return { ...state, claude: { busy: event.kind === "claude.prompt", tool: null, at: event.ts } };
        case "claude.tool_use": {
            // The hook records a one-line label ("Edit cli/x.ts") as the message.
            const tool = str(event.message) ?? str(data.tool) ?? null;
            return { ...state, claude: { busy: true, tool, at: event.ts } };
        }
        case "claude.stop":
        case "claude.session_end":
            return { ...state, claude: { busy: false, tool: null, at: event.ts } };
        default:
            return state;
    }
}

export interface PanelRenderOptions {
    now: Date;
    color: boolean;
    unicode: boolean;
    /** Terminal columns; each line is cut to width - 1 so it never wraps. */
    width?: number;
}

function ago(ts: string, now: Date): string {
    const ms = now.getTime() - Date.parse(ts);
    return Number.isNaN(ms) ? "?" : formatDuration(Math.max(0, ms));
}

/** Visible length, ignoring SGR codes. */
function visible(text: string): number {
    return Array.from(text.replace(/\x1b\[[0-9;]*m/g, "")).length;
}

/** Cut a painted line to `max` visible characters, keeping escape codes intact. */
export function fitLine(text: string, max: number, unicode: boolean): string {
    if (visible(text) <= max) return text;
    const ellipsis = unicode ? "…" : "...";
    const keep = Math.max(0, max - Array.from(ellipsis).length);
    let out = "";
    let shown = 0;

    const parts = text.split(/(\x1b\[[0-9;]*m)/);
    for (const part of parts) {
        if (part.startsWith("\x1b[")) {
            out += part;
            continue;
        }
        for (const ch of Array.from(part)) {
            if (shown >= keep) break;
            out += ch;
            shown += 1;
        }
    }
    return out + ellipsis + (text.includes("\x1b[") ? SGR.reset : "");
}

export function renderPanel(state: PanelState, options: PanelRenderOptions): string[] {
    const { now, color, unicode } = options;
    const g = unicode ? { on: "●", off: "○", ok: "✓", bad: "✗", rule: "─", dot: "·" } : { on: "*", off: "o", ok: "ok", bad: "X", rule: "-", dot: "|" };
    const label = (text: string): string => paint(text.padEnd(9), SGR.dim, color);
    const sep = paint(` ${g.dot} `, SGR.dim, color);

    // Line 1: daemon and Claude.
    const d = state.daemon;
    let daemon: string;
    if (d.running) {
        const parts = ["running"];
        if (d.pid !== null) parts.push(`pid ${d.pid}`);
        if (d.startedAt !== null && !Number.isNaN(Date.parse(d.startedAt))) parts.push(`up ${formatUptime(now.getTime() - Date.parse(d.startedAt))}`);
        daemon = `${paint(g.on, SGR.green, color)} ${parts.join(", ")}`;
    } else {
        daemon = d.crashed ? paint(`${g.off} crashed (tyr start)`, SGR.red, color) : paint(`${g.off} not running (tyr start)`, SGR.yellow, color);
    }
    let claude = "";
    if (state.claude !== null) {
        const c = state.claude;
        claude = c.busy
            ? `${sep}claude ${paint(g.on, SGR.magenta, color)} working${c.tool ? `: ${c.tool}` : ""} (${ago(c.at, now)})`
            : `${sep}claude ${paint(g.off, SGR.dim, color)} idle`;
    }
    const line1 = label("daemon") + daemon + claude;

    // Line 2: checks.
    const results = state.checks.map((c) => {
        const mark = c.outcome === "passed" ? paint(g.ok, SGR.green, color) : paint(g.bad, SGR.red, color);
        return `${c.kind} ${mark}`;
    });
    let checks = results.length > 0 ? results.join("  ") : paint("none run yet", SGR.dim, color);
    if (state.running !== null) checks += `${sep}${paint(`running ${state.running.kind} ${ago(state.running.startedAt, now)}`, SGR.cyan, color)}`;
    const line2 = label("checks") + checks;

    // Line 3: problems, findings, last alert.
    const problems =
        state.problems.length === 0
            ? paint("none", SGR.green, color)
            : paint(`${state.problems.length}: ${state.problems.map((p) => `${p.kind} ${p.regression ? "regressed" : "failing"}`).join(", ")}`, SGR.red, color);
    let line3 = label("problems") + problems;
    if (state.findings !== null) {
        const f = state.findings;
        line3 += `${sep}findings ${f.total}${f.serious > 0 ? ` (${paint(`${f.serious} serious`, SGR.red, color)})` : ""}`;
    }
    if (state.alert !== null) {
        const tone = state.alert.severity === "error" ? SGR.red : state.alert.severity === "warning" ? SGR.yellow : SGR.green;
        line3 += `${sep}alert: ${paint(state.alert.title, tone, color)} (${ago(state.alert.at, now)} ago)`;
    }

    const max = options.width !== undefined && options.width > 1 ? options.width - 1 : undefined;
    const ruleWidth = max ?? 60;
    const rule = paint(`${g.rule}${g.rule} live ${g.rule.repeat(Math.max(0, Math.min(ruleWidth, 72) - 8))}`, SGR.dim, color);
    const lines = [rule, line1, line2, line3];
    return max === undefined ? lines : lines.map((line) => fitLine(line, max, unicode));
}

/* -------------------------------------------------------------------------
 * Drawing
 * ---------------------------------------------------------------------- */

export interface PanelStream {
    write(chunk: string): unknown;
}

export interface LivePanelOptions {
    out: PanelStream;
    /** The lines to show now. */
    render: () => string[];
    /** Redraw period for moving times; 0 disables the timer. Default 1000. */
    intervalMs?: number;
}

const CURSOR_UP = (n: number): string => `\x1b[${n}A`;
const CLEAR_DOWN = "\r\x1b[J";

/** Keeps a block of lines pinned under everything printed through it. */
export class LivePanel {
    private drawn = 0;
    private timer: NodeJS.Timeout | null = null;
    private closed = false;

    constructor(private readonly options: LivePanelOptions) {}

    /** Draw the panel and start the timer. */
    start(): void {
        this.options.out.write(this.panelText());
        const interval = this.options.intervalMs ?? 1000;
        if (interval > 0) {
            this.timer = setInterval(() => this.refresh(), interval);
            this.timer.unref?.();
        }
    }

    /** Write `text` (complete lines) above the panel. */
    print(text: string): void {
        if (this.closed) {
            this.options.out.write(text);
            return;
        }
        this.options.out.write(this.erase() + text + this.panelText());
    }

    /** Redraw in place (state changed, or time moved). */
    refresh(): void {
        if (this.closed) return;
        this.options.out.write(this.erase() + this.panelText());
    }

    /** Stop the timer and remove the panel, leaving the log as the last thing on screen. */
    close(): void {
        if (this.closed) return;
        this.closed = true;
        if (this.timer !== null) clearInterval(this.timer);
        this.timer = null;
        this.options.out.write(this.erase());
        this.drawn = 0;
    }

    private erase(): string {
        if (this.drawn === 0) return "";
        return CURSOR_UP(this.drawn) + CLEAR_DOWN;
    }

    private panelText(): string {
        let lines: string[];
        try {
            lines = this.options.render();
        } catch {
            lines = [];
        }
        this.drawn = lines.length;
        return lines.length === 0 ? "" : lines.join("\n") + "\n";
    }
}
