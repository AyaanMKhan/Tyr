// Review pass (PLANNING.md 2.11): turns one check pass into findings and a
// report.
//
//   check runs ──parseCheckRun──┐
//   working-tree diff ─reviewDiff─┼─▶ merge + dedupe ─▶ regressions ─▶ threshold ─▶ report + findings.json + journal
//   (optional) LLM ─reviewDiffWithLlm┘
//
// Regression detection compares against the previous pass, kept in
// `.tyr/state/findings.json`:
//   - a check finding is a REGRESSION when its fingerprint was absent last
//     time and that check had passed before this pass (the check's lastGood in
//     engine.json predates it). A check that never passed only has
//     pre-existing failures.
//   - every finding is NEW when its fingerprint was absent last time; findings
//     present last time but gone now are RESOLVED. Both go into the report
//     data and the journal event.
// The comparison uses the unfiltered findings, so changing the severity
// threshold does not make old findings look new.
//
// The detectors are injected (ReviewDetectors), so this module is testable
// without real tools, diffs or a model. Like the rest of cli/engine it never
// prints; reviewPass never throws: a failing detector costs its findings and a
// note in the report, not the pass.

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { appendEvent } from "../core/events.js";
import { getDiff, type DiffResult } from "../core/git-diff.js";
import { getCurrentBranch, getHeadCommit } from "../core/git.js";
import { FINDING_SEVERITIES, writeReport, type FindingSeverity, type WrittenReport } from "../core/reports.js";
import { readConfig, readJsonObject, resolveTyrPaths, writeFileAtomic, toJsonDocument } from "../core/scaffold.js";
import type { Severity } from "../core/settings-types.js";
import {
    compareFindings,
    dedupeFindings,
    MAX_FINDINGS_PER_DETECTOR,
    SEVERITY_RANK,
    type EngineFinding,
    type FindingSource,
    type ReviewContext,
} from "./findings.js";
import type { CheckKind, CheckRun, CheckTrigger, EngineState } from "./model.js";

/* -------------------------------------------------------------------------
 * Detectors
 * ---------------------------------------------------------------------- */

export interface LlmOutcome {
    status: "ok" | "skipped" | "error";
    findings: EngineFinding[];
    reason?: string;
}

export interface ReviewDetectors {
    parseCheckRun?: (run: CheckRun) => EngineFinding[];
    reviewDiff?: (ctx: ReviewContext) => EngineFinding[];
    reviewDiffWithLlm?: (ctx: ReviewContext) => Promise<LlmOutcome>;
}

/* -------------------------------------------------------------------------
 * Previous pass — .tyr/state/findings.json
 * ---------------------------------------------------------------------- */

export const FINDINGS_STATE_VERSION = 1;

export interface FindingsState {
    version: typeof FINDINGS_STATE_VERSION;
    updatedAt: string;
    /** Every finding of the last pass, before the severity threshold. */
    findings: EngineFinding[];
    /** Report written for that pass, if any. */
    reportId: string | null;
}

export function findingsStateFile(root: string): string {
    return path.join(resolveTyrPaths(root).stateDir, "findings.json");
}

/** Never throws; missing or malformed → null. */
export async function readFindingsState(root: string): Promise<FindingsState | null> {
    const raw = await readJsonObject<FindingsState>(findingsStateFile(root)).catch(() => null);
    if (raw === null || raw.version !== FINDINGS_STATE_VERSION || !Array.isArray(raw.findings)) return null;
    return raw;
}

async function writeFindingsState(root: string, state: FindingsState): Promise<void> {
    const file = findingsStateFile(root);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, toJsonDocument(state));
}

/* -------------------------------------------------------------------------
 * Pure steps
 * ---------------------------------------------------------------------- */

/**
 * Mark regressions in `current` against the previous pass. `passedBefore`
 * holds the checks whose last good run predates this pass.
 */
export function markRegressions(
    current: readonly EngineFinding[],
    previous: readonly EngineFinding[] | null,
    passedBefore: ReadonlySet<CheckKind>,
): { findings: EngineFinding[]; added: EngineFinding[]; resolved: EngineFinding[] } {
    const before = new Set((previous ?? []).map((f) => f.fingerprint));
    const now = new Set(current.map((f) => f.fingerprint));
    const findings = current.map((f) => {
        const isNew = previous !== null && !before.has(f.fingerprint);
        const regression = f.source === "check" && f.checkKind !== undefined && passedBefore.has(f.checkKind) && (isNew || previous === null);
        return regression ? { ...f, regression: true } : f;
    });
    const added = previous === null ? [] : findings.filter((f) => !before.has(f.fingerprint));
    const resolved = (previous ?? []).filter((f) => !now.has(f.fingerprint));
    return { findings, added, resolved };
}

/** Keep findings at or above the threshold. Critical always passes. */
export function applyThreshold(findings: readonly EngineFinding[], threshold: Severity): EngineFinding[] {
    const min = SEVERITY_RANK[threshold];
    return findings.filter((f) => SEVERITY_RANK[f.severity] >= min);
}

export function countBySeverity(findings: readonly EngineFinding[]): Record<FindingSeverity, number> {
    const counts = Object.fromEntries(FINDING_SEVERITIES.map((s) => [s, 0])) as Record<FindingSeverity, number>;
    for (const f of findings) counts[f.severity]++;
    return counts;
}

/* -------------------------------------------------------------------------
 * The pass
 * ---------------------------------------------------------------------- */

export interface ReviewPassInput {
    trigger: CheckTrigger;
    /** Runs of this pass, in order. */
    runs: readonly CheckRun[];
    /** engine.json as it was BEFORE this pass's runs were recorded. */
    stateBefore: EngineState;
    threshold: Severity;
    /** Run the LLM detector this pass. */
    llm: boolean;
    detectors: ReviewDetectors;
    now?: Date;
    /** Diff override (tests); default: working tree vs HEAD with patch. */
    diff?: ReviewContext | null;
}

export interface ReviewPassResult {
    /** Reported findings (after threshold), most severe first. */
    findings: EngineFinding[];
    /** All findings before the threshold. */
    all: EngineFinding[];
    added: EngineFinding[];
    resolved: EngineFinding[];
    regressions: EngineFinding[];
    report: WrittenReport | null;
    notes: string[];
}

const DETECTOR_NAMES: Record<FindingSource, string> = { check: "check output", diff: "diff review", llm: "LLM review" };

/** Untracked files larger than this are listed but not read into the patch. */
export const MAX_UNTRACKED_FILE_BYTES = 256 * 1024;
/** Total untracked text added to the patch. */
export const MAX_UNTRACKED_TOTAL_BYTES = 2 * 1024 * 1024;

/**
 * git diff never shows untracked files, yet new files are exactly what an
 * agent writes. Append each small, text, untracked file to the diff as a
 * "new file" patch so the reviewers see its contents with line numbers.
 */
export async function withUntrackedFiles(root: string, diff: DiffResult): Promise<DiffResult> {
    const untracked = diff.untracked ?? [];
    if (untracked.length === 0) return diff;
    const files = [...diff.files];
    const totals = { ...diff.totals };
    let patch = diff.patch;
    let budget = MAX_UNTRACKED_TOTAL_BYTES;
    for (const file of untracked) {
        let text: string;
        try {
            const stat = await fs.stat(path.join(root, file));
            if (!stat.isFile() || stat.size > MAX_UNTRACKED_FILE_BYTES || stat.size > budget) continue;
            const buffer = await fs.readFile(path.join(root, file));
            if (buffer.includes(0)) continue; // binary
            text = buffer.toString("utf8");
            budget -= buffer.length;
        } catch {
            continue;
        }
        const lines = text.length === 0 ? [] : text.replace(/\n$/, "").split("\n");
        const header = `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n`;
        const body = lines.length === 0 ? "" : `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`;
        if (patch.length > 0 && !patch.endsWith("\n")) patch += "\n";
        patch += header + body;
        files.push({ path: file, status: "A", additions: lines.length, deletions: 0, binary: false });
        totals.files += 1;
        totals.additions += lines.length;
    }
    return { ...diff, files, totals, patch };
}

async function workingTreeContext(root: string): Promise<ReviewContext | null> {
    const diff = await getDiff(root, { kind: "since", ref: "HEAD" }, { includeUntracked: true }).catch(() => null);
    if (diff === null) return null;
    // A truncated patch already lost its tail; appending would mislead the parsers.
    const full = diff.truncated ? diff : await withUntrackedFiles(root, diff).catch(() => diff);
    return { root, diff: full, base: "HEAD" };
}

function cap(findings: EngineFinding[]): EngineFinding[] {
    return findings.slice(0, MAX_FINDINGS_PER_DETECTOR);
}

export async function reviewPass(root: string, input: ReviewPassInput): Promise<ReviewPassResult> {
    const now = input.now ?? new Date();
    const notes: string[] = [];
    const collected: EngineFinding[] = [];
    const guard = (source: FindingSource, fn: () => EngineFinding[]): void => {
        try {
            collected.push(...cap(fn()));
        } catch (error) {
            notes.push(`${DETECTOR_NAMES[source]} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    };

    const { parseCheckRun, reviewDiff, reviewDiffWithLlm } = input.detectors;
    if (parseCheckRun) {
        for (const run of input.runs) guard("check", () => parseCheckRun(run));
    }
    for (const run of input.runs) {
        if (run.outcome === "error") notes.push(`${run.kind} could not run: ${run.error ?? "unknown error"}`);
        if (run.outcome === "timeout") notes.push(`${run.kind} timed out after ${Math.round(run.durationMs / 1000)}s`);
    }

    const ctx = input.diff !== undefined ? input.diff : reviewDiff || (input.llm && reviewDiffWithLlm) ? await workingTreeContext(root) : null;
    if (ctx !== null && reviewDiff) guard("diff", () => reviewDiff(ctx));
    if (ctx !== null && input.llm && reviewDiffWithLlm) {
        const outcome = await reviewDiffWithLlm(ctx).catch(
            (error: unknown): LlmOutcome => ({ status: "error", findings: [], reason: error instanceof Error ? error.message : String(error) }),
        );
        if (outcome.status === "ok") collected.push(...cap(outcome.findings));
        else notes.push(`LLM review ${outcome.status}${outcome.reason ? `: ${outcome.reason}` : ""}`);
    }

    const passedBefore = new Set<CheckKind>();
    for (const [kind, state] of Object.entries(input.stateBefore.checks)) {
        if (state?.lastGood) passedBefore.add(kind as CheckKind);
    }
    const previous = await readFindingsState(root);
    const marked = markRegressions(dedupeFindings(collected), previous?.findings ?? null, passedBefore);
    const all = marked.findings.sort(compareFindings);
    const findings = applyThreshold(all, input.threshold);
    const regressions = findings.filter((f) => f.regression === true);

    // A report only when there is something new to say: the first findings,
    // new ones, resolved ones, or failures to explain. The same findings pass
    // after pass (an idle loop over unchanged code) update findings.json and
    // the journal but do not pile up identical reports.
    let report: WrittenReport | null = null;
    const reportedBefore = new Set(applyThreshold(previous?.findings ?? [], input.threshold).map((f) => f.fingerprint));
    const changed = findings.some((f) => !reportedBefore.has(f.fingerprint)) || marked.resolved.length > 0;
    const worthReporting = changed || notes.length > 0;
    if (worthReporting) {
        try {
            const [config, branch, head] = await Promise.all([
                readConfig(root).catch(() => null),
                getCurrentBranch(root).catch(() => null),
                getHeadCommit(root).catch(() => null),
            ]);
            report = await writeReport(
                root,
                {
                    kind: "review",
                    title: reportTitle(findings, regressions.length, marked.resolved.length),
                    summary: reportSummary(input, findings, marked.added.length, marked.resolved.length, regressions.length),
                    git: { branch: branch?.branch ?? null, headCommit: head?.hash ?? null },
                    findings,
                    data: {
                        trigger: input.trigger,
                        runs: input.runs.map(({ stdout: _o, stderr: _e, ...summary }) => summary),
                        threshold: input.threshold,
                        counts: countBySeverity(all),
                        new: marked.added.map((f) => f.fingerprint),
                        resolved: marked.resolved.map((f) => ({ fingerprint: f.fingerprint, title: f.title, file: f.file ?? null })),
                        notes,
                    },
                },
                { now, config },
            );
        } catch (error) {
            notes.push(`could not write the report: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    await writeFindingsState(root, {
        version: FINDINGS_STATE_VERSION,
        updatedAt: now.toISOString(),
        findings: all,
        reportId: report?.id ?? null,
    }).catch((error: unknown) => notes.push(`could not save findings: ${error instanceof Error ? error.message : String(error)}`));

    await appendEvent(root, {
        source: "tyr",
        kind: "review.completed",
        message: reviewMessage(findings, regressions.length, marked.added.length, marked.resolved.length),
        data: {
            trigger: input.trigger,
            counts: countBySeverity(findings),
            total: findings.length,
            regressions: regressions.length,
            new: marked.added.length,
            resolved: marked.resolved.length,
            reportId: report?.id ?? null,
            top: findings.slice(0, 5).map((f) => ({ severity: f.severity, title: f.title, file: f.file ?? null, line: f.line ?? null })),
        },
    });

    return { findings, all, added: marked.added, resolved: marked.resolved, regressions, report, notes };
}

function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function reportTitle(findings: readonly EngineFinding[], regressions: number, resolved: number): string {
    if (findings.length === 0) return resolved > 0 ? `All clear: ${plural(resolved, "finding")} resolved` : "Review notes";
    const head = regressions > 0 ? `${plural(regressions, "regression")}, ` : "";
    return `${head}${plural(findings.length, "finding")}`;
}

function reportSummary(input: ReviewPassInput, findings: readonly EngineFinding[], added: number, resolved: number, regressions: number): string {
    const ran = input.runs.map((r) => `${r.kind} ${r.outcome}`).join(", ") || "no checks";
    const counts = countBySeverity(findings);
    const bySeverity = FINDING_SEVERITIES.filter((s) => counts[s] > 0).map((s) => `${counts[s]} ${s}`).join(", ") || "none";
    return (
        `Triggered by ${input.trigger.reason}. Checks: ${ran}. Findings: ${bySeverity}` +
        ` (${added} new, ${resolved} resolved, ${plural(regressions, "regression")}).`
    );
}

function reviewMessage(findings: readonly EngineFinding[], regressions: number, added: number, resolved: number): string {
    if (findings.length === 0) return resolved > 0 ? `Review clean: ${plural(resolved, "finding")} resolved` : "Review clean";
    const parts = [plural(findings.length, "finding")];
    if (regressions > 0) parts.push(plural(regressions, "regression"));
    if (added > 0) parts.push(`${added} new`);
    if (resolved > 0) parts.push(`${resolved} resolved`);
    return `Review: ${parts.join(", ")}`;
}
