// cli/engine/alerts.ts — what a finished check pass is worth telling the user
// about (PLANNING.md 2.15, the 2.11 follow-up "notify on new regressions").
//
// Pure: compares engine.json before and after a pass plus the review result,
// and returns at most one notification per pass (a summary, never a burst):
//
//   error    a check regressed (it passed before), or the diff review found a
//            new error/critical problem
//   warning  a check started failing that never passed (a pre-existing failure)
//   info     only good news: checks that were failing pass again
//
// Check findings are left out of the review part: the failing check already
// says it. The dedupe key names exactly which problems changed, so the
// notifier drops a repeat of the same news but not a new problem.

import type { TyrNotification, NotificationSeverity } from "../integrations/notify.js";
import type { EngineFinding } from "./findings.js";
import type { EngineState, Problem } from "./model.js";
import type { ReviewPassResult } from "./review.js";

/** Lines in one notification body before "+N more". */
export const MAX_ALERT_LINES = 3;

export interface PassAlertInput {
    before: EngineState;
    after: EngineState;
    review: ReviewPassResult | null;
}

function isNew(problem: Problem, before: EngineState): boolean {
    const old = before.problems.find((p) => p.key === problem.key);
    return old === undefined || old.firstSeenRunId !== problem.firstSeenRunId;
}

function where(finding: EngineFinding): string {
    if (finding.file === undefined) return "";
    return ` (${finding.file}${finding.line !== undefined ? `:${finding.line}` : ""})`;
}

function list(names: string[]): string {
    if (names.length <= 1) return names.join("");
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function passNotification(input: PassAlertInput): TyrNotification | null {
    const { before, after, review } = input;
    const opened = after.problems.filter((p) => isNew(p, before));
    const closed = before.problems.filter((p) => !after.problems.some((q) => q.key === p.key));
    const serious = (review?.added ?? []).filter((f) => f.source !== "check" && (f.severity === "error" || f.severity === "critical"));
    if (opened.length === 0 && closed.length === 0 && serious.length === 0) return null;

    const regressed = opened.filter((p) => p.regression);
    const severity: NotificationSeverity = regressed.length > 0 || serious.length > 0 ? "error" : opened.length > 0 ? "warning" : "info";

    let title: string;
    if (regressed.length > 0) title = `${list(regressed.map((p) => p.kind))} regressed`;
    else if (opened.length > 0) title = `${list(opened.map((p) => p.kind))} failing`;
    else if (serious.length > 0) title = `${serious.length} new ${serious.length === 1 ? "problem" : "problems"} in your changes`;
    else title = `${list(closed.map((p) => p.kind))} passing again`;

    const lines: string[] = [
        ...opened.map((p) => `${p.kind} ${p.regression ? "regressed" : "is failing"}: ${p.title}`),
        ...serious.map((f) => `${f.severity}: ${f.title}${where(f)}`),
        ...closed.map((p) => `${p.kind} passes again`),
    ];
    const shown = lines.slice(0, MAX_ALERT_LINES);
    if (lines.length > shown.length) shown.push(`+${lines.length - shown.length} more (tyr status)`);

    const key = [
        ...opened.map((p) => `open:${p.key}:${p.firstSeenRunId}`),
        ...serious.map((f) => `finding:${f.fingerprint}`),
        ...closed.map((p) => `closed:${p.key}:${p.lastSeenRunId}`),
    ]
        .sort()
        .join("|");

    return {
        title: `Tyr: ${title}`,
        message: shown.join("\n"),
        severity,
        key,
        data: {
            opened: opened.map((p) => ({ key: p.key, regression: p.regression })),
            closed: closed.map((p) => p.key),
            findings: serious.map((f) => f.fingerprint),
        },
    };
}
