import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";

import { readEvents } from "../cli/core/events.js";
import { listReports, readReport } from "../cli/core/reports.js";
import { makeFinding, type EngineFinding, type ReviewContext } from "../cli/engine/findings.js";
import type { CheckRun, EngineState } from "../cli/engine/model.js";
import { emptyEngineState } from "../cli/engine/repo-state.js";
import {
    applyThreshold,
    markRegressions,
    withUntrackedFiles,
    readFindingsState,
    reviewPass,
    type ReviewDetectors,
} from "../cli/engine/review.js";
import { makeProject, removeProject } from "./helpers.js";

function run(kind: CheckRun["kind"], outcome: CheckRun["outcome"], stderr = ""): CheckRun {
    return {
        id: `${kind}-${outcome}`,
        kind,
        command: `run ${kind}`,
        cwd: "/x",
        trigger: { reason: "idle" },
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
        durationMs: 1000,
        outcome,
        exitCode: outcome === "passed" ? 0 : 1,
        signal: null,
        stdout: "",
        stderr,
        outputTruncated: false,
        headCommit: null,
    };
}

const typeError = (line: number): EngineFinding =>
    makeFinding({ source: "check", checkKind: "typecheck", severity: "error", title: "Type 'string' is not assignable to type 'number'", file: "src/a.ts", line, rule: "TS2322" });
const todo = makeFinding({ source: "diff", severity: "info", title: "TODO added", file: "src/a.ts", line: 3, rule: "diff/todo" });
const secret = makeFinding({ source: "diff", severity: "critical", title: "AWS key added", file: ".env", line: 1, rule: "diff/secret-aws-key" });

function passedBefore(...kinds: CheckRun["kind"][]): EngineState {
    const state = emptyEngineState();
    for (const kind of kinds) state.checks[kind] = { last: null, lastGood: { ...run(kind, "passed") } };
    return state;
}

const noDiff: ReviewContext = { root: "/x", diff: { files: [], totals: { files: 0, additions: 0, deletions: 0 }, untracked: null, patch: "", truncated: false }, base: "HEAD" };

describe("review: pure steps", () => {
    it("a new failure in a check that passed before is a regression; line drift is not new", () => {
        const first = markRegressions([typeError(10)], [], new Set(["typecheck"]));
        assert.equal(first.findings[0]!.regression, true);
        assert.equal(first.added.length, 1);

        const again = markRegressions([typeError(14)], first.findings, new Set(["typecheck"]));
        assert.equal(again.findings[0]!.regression, undefined, "same fingerprint: not new");
        assert.equal(again.added.length, 0);
    });

    it("a check that never passed has pre-existing failures, not regressions", () => {
        const result = markRegressions([typeError(1)], [], new Set());
        assert.equal(result.findings[0]!.regression, undefined);
    });

    it("diff findings are never regressions; resolved findings are reported", () => {
        const result = markRegressions([todo], [secret], new Set(["typecheck"]));
        assert.equal(result.findings[0]!.regression, undefined);
        assert.deepEqual(result.resolved.map((f) => f.rule), ["diff/secret-aws-key"]);
    });

    it("threshold keeps findings at or above it; critical always", () => {
        assert.deepEqual(applyThreshold([todo, typeError(1), secret], "error").map((f) => f.severity), ["error", "critical"]);
        assert.equal(applyThreshold([todo], "info").length, 1);
    });
});

describe("review pass", () => {
    it("merges detectors, writes a report, saves findings and journals review.completed", async () => {
        const root = await makeProject({ ".tyr/state/.keep": "" });
        try {
            const detectors: ReviewDetectors = {
                parseCheckRun: (r) => (r.outcome === "failed" ? [typeError(10)] : []),
                reviewDiff: () => [todo, secret],
            };
            const result = await reviewPass(root, {
                trigger: { reason: "claude-stop" },
                runs: [run("build", "passed"), run("typecheck", "failed")],
                stateBefore: passedBefore("typecheck"),
                threshold: "warning",
                llm: false,
                detectors,
                diff: noDiff,
            });
            assert.deepEqual(result.findings.map((f) => f.severity), ["critical", "error"], "info dropped, most severe first");
            assert.equal(result.regressions.length, 1);
            assert.equal(result.all.length, 3);
            assert.ok(result.report);

            const report = await readReport(root, result.report!.id);
            assert.equal(report?.kind, "review");
            assert.equal(report?.findings.length, 2);
            assert.match(report!.title, /1 regression, 2 findings/);
            assert.ok(!JSON.stringify(report).includes('"stderr"'), "run output is not copied into the report");

            assert.equal((await readFindingsState(root))?.findings.length, 3);
            const events = await readEvents(root, { kinds: ["review.completed"] });
            assert.equal(events.length, 1);
            assert.equal(events[0]!.data?.regressions, 1);
        } finally {
            await removeProject(root);
        }
    });

    it("reports only changes: new findings, resolved ones, not repeats or clean passes", async () => {
        const root = await makeProject({ ".tyr/state/.keep": "" });
        try {
            let findings: EngineFinding[] = [secret];
            const base = {
                trigger: { reason: "idle" as const },
                runs: [],
                stateBefore: emptyEngineState(),
                threshold: "warning" as const,
                llm: false,
                detectors: { reviewDiff: () => findings },
                diff: noDiff,
            };
            assert.ok((await reviewPass(root, base)).report, "findings → report");
            assert.equal((await reviewPass(root, base)).report, null, "same findings again → no new report");
            findings = [];
            const resolved = await reviewPass(root, base);
            assert.equal(resolved.resolved.length, 1);
            assert.match(resolved.report!.title, /All clear/);
            const clean = await reviewPass(root, base);
            assert.equal(clean.report, null);
            assert.equal((await listReports(root)).length, 2);
        } finally {
            await removeProject(root);
        }
    });

    it("a throwing detector or failing LLM costs a note, not the pass", async () => {
        const root = await makeProject({ ".tyr/state/.keep": "" });
        try {
            const result = await reviewPass(root, {
                trigger: { reason: "commit" },
                runs: [run("lint", "error")],
                stateBefore: emptyEngineState(),
                threshold: "info",
                llm: true,
                detectors: {
                    parseCheckRun: () => {
                        throw new Error("parser bug");
                    },
                    reviewDiff: () => [todo],
                    reviewDiffWithLlm: async () => ({ status: "error", findings: [], reason: "HTTP 529" }),
                },
                diff: noDiff,
            });
            assert.deepEqual(result.findings.map((f) => f.rule), ["diff/todo"]);
            assert.ok(result.notes.some((n) => n.includes("parser bug")));
            assert.ok(result.notes.some((n) => n.includes("lint could not run")));
            assert.ok(result.notes.some((n) => n.includes("HTTP 529")));
        } finally {
            await removeProject(root);
        }
    });

    it("skips the LLM unless asked", async () => {
        const root = await makeProject({ ".tyr/state/.keep": "" });
        try {
            let called = false;
            await reviewPass(root, {
                trigger: { reason: "idle" },
                runs: [],
                stateBefore: emptyEngineState(),
                threshold: "info",
                llm: false,
                detectors: { reviewDiffWithLlm: async () => ((called = true), { status: "ok", findings: [] }) },
                diff: noDiff,
            });
            assert.equal(called, false);
            await fs.access(path.join(root, ".tyr", "state", "findings.json"));
        } finally {
            await removeProject(root);
        }
    });

    it("untracked text files are added to the diff as new-file patches", async () => {
        const root = await makeProject({ "new.js": "const a = 1;\nconst b = 2;\n", "bin.dat": "x\u0000y" });
        try {
            const diff = await withUntrackedFiles(root, { ...noDiff.diff, untracked: ["new.js", "bin.dat", "gone.js"] });
            assert.deepEqual(diff.files.map((f) => `${f.status} ${f.path} +${f.additions}`), ["A new.js +2"]);
            assert.match(diff.patch, /\+\+\+ b\/new\.js\n@@ -0,0 \+1,2 @@\n\+const a = 1;\n\+const b = 2;\n/);
            assert.equal(diff.totals.additions, 2);
        } finally {
            await removeProject(root);
        }
    });
});
