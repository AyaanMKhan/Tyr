// Findings contract for problem detection (PLANNING.md 2.11).
//
// A finding is one concrete thing wrong: a type error at src/a.ts:12, a
// failing test, a deleted test file, a leaked key, a convention the LLM
// reviewer flagged. Every detector produces EngineFinding[]; the engine
// combines them, marks regressions against the previous pass, filters by the
// user's severity threshold and writes a report to `.tyr/reports/`
// (cli/core/reports.ts, whose Finding this extends so reports stay
// readable by anything that already reads them).
//
// Detectors:
//   check-parsers.ts  CheckRun output (tsc, eslint, test runners, ...)  source "check"
//   diff-review.ts    heuristic rules over the working-tree diff        source "diff"
//   llm-review.ts     model review against CLAUDE.md / README            source "llm"
//
// Pure: types and small helpers only, no I/O.

import { createHash } from "node:crypto";
import type { Finding, FindingSeverity } from "../core/reports.js";
import type { DiffResult } from "../core/git-diff.js";
import type { CheckKind } from "./model.js";

export type FindingSource = "check" | "diff" | "llm";

export interface EngineFinding extends Finding {
    source: FindingSource;
    /**
     * Stable identity across passes (see fingerprintFinding): the same
     * problem found again gets the same fingerprint even if lines shifted.
     */
    fingerprint: string;
    /** For source "check": which check produced it. */
    checkKind?: CheckKind;
    column?: number;
    /** Set by the engine: absent from the previous pass where this check passed / this finding was not present. */
    regression?: boolean;
}

/** What a detector supplies; fingerprint is derived unless given. */
export type FindingInput = Omit<EngineFinding, "fingerprint"> & { fingerprint?: string };

/**
 * sha1 over source, checkKind, rule, file and the title with digits
 * collapsed. Deliberately excludes line/column and detail, which drift as
 * code moves.
 */
export function fingerprintFinding(finding: Omit<FindingInput, "fingerprint">): string {
    const title = finding.title.replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
    const parts = [finding.source, finding.checkKind ?? "", finding.rule ?? "", finding.file ?? "", title];
    return createHash("sha1").update(parts.join("\u0000")).digest("hex").slice(0, 16);
}

export function makeFinding(input: FindingInput): EngineFinding {
    return { ...input, fingerprint: input.fingerprint ?? fingerprintFinding(input) };
}

/** Numeric rank, higher is worse. */
export const SEVERITY_RANK: Record<FindingSeverity, number> = { info: 0, warning: 1, error: 2, critical: 3 };

/** Most severe first, then file, then line. */
export function compareFindings(a: Finding, b: Finding): number {
    return (
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
        (a.file ?? "").localeCompare(b.file ?? "") ||
        (a.line ?? 0) - (b.line ?? 0)
    );
}

/** Drop duplicates by fingerprint + line, keeping the first. */
export function dedupeFindings(findings: readonly EngineFinding[]): EngineFinding[] {
    const seen = new Set<string>();
    return findings.filter((f) => {
        const key = `${f.fingerprint}:${f.line ?? ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** Input shared by the diff-based reviewers. */
export interface ReviewContext {
    root: string;
    /** Working tree vs HEAD (or vs the base ref being reviewed), with patch text. */
    diff: DiffResult;
    /** What the diff is against, e.g. "HEAD" or a commit hash. */
    base: string;
}

/** Cap on findings one detector may return, so a broken build cannot flood a report. */
export const MAX_FINDINGS_PER_DETECTOR = 200;
