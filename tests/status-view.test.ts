// status-view.ts: renderStatus against fixture StatusReports, colours off.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import type { InitializedStatus, StatusFinding, StatusReport } from "../cli/core/status.js";
import { formatAgo, hasDrift, renderStatus } from "../cli/ui/status-view.js";

const NOW = new Date("2026-11-17T12:00:00.000Z");
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

function finding(index: number, overrides: Partial<StatusFinding> = {}): StatusFinding {
    return { severity: "warning", title: `warning number ${index}`, file: `src/f${index}.ts`, line: index, ...overrides };
}

function fixture(overrides: Partial<InitializedStatus> = {}): InitializedStatus {
    return {
        statusVersion: 1,
        initialized: true,
        root: "/work/app",
        collectedAt: NOW.toISOString(),
        project: {
            name: "app",
            root: "/work/app",
            primaryLanguage: "TypeScript",
            languages: [
                { name: "TypeScript", fileCount: 80, percentage: 80 },
                { name: "JavaScript", fileCount: 10, percentage: 10 },
                { name: "JSON", fileCount: 6, percentage: 6 },
                { name: "CSS", fileCount: 4, percentage: 4 },
            ],
            frameworks: ["React"],
            packageManager: "npm",
            workspace: null,
            commands: {
                build: { command: "npm run build", tool: "tsc", source: "detected" },
                test: { command: "npm test", tool: "node:test", source: "detected" },
                lint: null,
                format: null,
                typecheck: null,
            },
            git: { isRepo: true, branch: "main", remote: null },
            docs: { readme: "README.md", claudeMd: null },
            tyrVersion: "1.0.0",
            configVersion: 2,
            initializedAt: ago(2 * HOUR),
            migrated: [],
        },
        state: {
            status: "running",
            createdAt: ago(2 * HOUR),
            updatedAt: ago(MIN),
            runCount: 12,
            lastRunAt: ago(3 * MIN),
            pid: 4242,
            startedAt: ago(HOUR),
        },
        daemon: { running: true, pid: 4242, startedAt: ago(HOUR + 5 * MIN), uptimeMs: HOUR + 5 * MIN, stale: false },
        lastRun: {
            lastRunAt: ago(3 * MIN),
            runCount: 12,
            reportCount: 7,
            recentReports: [
                {
                    id: "2026-11-17T11-58-00-review",
                    kind: "review",
                    title: "Review of working tree",
                    createdAt: ago(2 * MIN),
                    summary: "2 findings",
                    findingCounts: { critical: 0, error: 1, warning: 1, info: 0 },
                    jsonFile: "/work/app/.tyr/reports/2026-11-17T11-58-00-review.json",
                },
                {
                    id: "2026-11-17T10-00-00-check",
                    kind: "check",
                    title: "Checks",
                    createdAt: ago(2 * HOUR),
                    summary: "",
                    findingCounts: { critical: 0, error: 0, warning: 0, info: 0 },
                    jsonFile: "/work/app/.tyr/reports/2026-11-17T10-00-00-check.json",
                },
            ],
        },
        findings: {
            source: "engine",
            updatedAt: ago(2 * MIN),
            reportId: "2026-11-17T11-58-00-review",
            threshold: "info",
            total: 2,
            counts: { critical: 0, error: 1, warning: 1, info: 0 },
            regressions: 1,
            items: [
                { severity: "error", title: "test failed", file: "src/a.test.ts", line: 12, regression: true },
                { severity: "warning", title: "console.log left in", file: "src/b.ts" },
            ],
            truncated: false,
        },
        engine: {
            updatedAt: ago(MIN),
            healthy: false,
            checks: [
                {
                    kind: "build",
                    command: "npm run build",
                    outcome: "passed",
                    exitCode: 0,
                    startedAt: ago(5 * MIN),
                    finishedAt: ago(4 * MIN),
                    durationMs: 1500,
                    trigger: "commit",
                    headCommit: "abcdef1234567",
                    lastPassedAt: ago(4 * MIN),
                },
                {
                    kind: "test",
                    command: "npm test",
                    outcome: "failed",
                    exitCode: 1,
                    startedAt: ago(4 * MIN),
                    finishedAt: ago(3 * MIN),
                    durationMs: 61_000,
                    trigger: "commit",
                    headCommit: "abcdef1234567",
                    lastPassedAt: ago(HOUR),
                },
            ],
            problems: [
                {
                    key: "check:test",
                    kind: "test",
                    title: "test is failing",
                    detail: "1 failing\nmore output",
                    firstSeenAt: ago(3 * MIN),
                    lastSeenAt: ago(3 * MIN),
                    regression: true,
                },
            ],
            workingTree: null,
        },
        drift: {
            isRepo: true,
            indexedHead: "1111111aaaaaaa",
            currentHead: "2222222bbbbbbb",
            currentBranch: "main",
            headChanged: true,
            commitsSinceIndex: 3,
            indexedAt: ago(2 * HOUR),
            indexedFileCount: 100,
            currentFileCount: 104,
            fileCountDelta: 4,
            filesAdded: 5,
            filesRemoved: 1,
        },
        warnings: [],
        ...overrides,
    };
}

const UP_TO_DATE = {
    isRepo: true,
    indexedHead: "1111111aaaaaaa",
    currentHead: "1111111aaaaaaa",
    currentBranch: "main",
    headChanged: false,
    commitsSinceIndex: 0,
    indexedAt: ago(2 * HOUR),
    indexedFileCount: 100,
    currentFileCount: 100,
    fileCountDelta: 0,
    filesAdded: 0,
    filesRemoved: 0,
} as const;

function render(report: StatusReport, verbose = false): string {
    return renderStatus(report, { color: false, verbose, now: NOW }).join("\n");
}

test("renderStatus: not initialized says so and suggests tyr init", () => {
    const lines = renderStatus(
        { statusVersion: 1, initialized: false, root: "/tmp/x", collectedAt: NOW.toISOString(), reason: "no-tyr-dir", suggestion: "tyr init" },
        { color: false },
    );
    assert.deepEqual(lines, ["Tyr is not initialized in /tmp/x.", 'Run "tyr init" to set it up.']);
    const noConfig = renderStatus(
        { statusVersion: 1, initialized: false, root: "/tmp/x", collectedAt: NOW.toISOString(), reason: "no-config", suggestion: "tyr init" },
        { color: false },
    );
    assert.match(noConfig[0]!, /has no tyr\.json/);
});

test("renderStatus: header and project profile", () => {
    const text = render(fixture());
    const lines = text.split("\n");
    assert.equal(lines[0], "Tyr status: app");
    assert.equal(lines[1], "  /work/app");
    assert.match(text, /^Project\s+TypeScript 80%, JavaScript 10%, JSON 6%, \+1 more$/m);
    assert.match(text, /^Frameworks\s+React$/m);
    assert.match(text, /^Packages\s+npm$/m);
    assert.match(text, /^Commands\s+build: npm run build · test: npm test$/m);
    assert.doesNotMatch(text, /not configured/);
    assert.doesNotMatch(text, /\x1b\[/, "no ANSI codes with color off");
});

test("renderStatus: daemon running, stale and stopped", () => {
    assert.match(render(fixture()), /^Background\s+● running \(pid 4242, up 1h 5m\)$/m);
    const stale = render(fixture({ daemon: { running: false, pid: 99, startedAt: null, uptimeMs: null, stale: true } }));
    assert.match(stale, /not running \(stale PID file for pid 99; "tyr start" replaces it\)/);
    const stopped = render(fixture({ daemon: { running: false, pid: null, startedAt: null, uptimeMs: null, stale: false } }));
    assert.match(stopped, /^Background\s+● not running \(start it with "tyr start"\)$/m);
});

test("renderStatus: last run and latest report", () => {
    const text = render(fixture());
    assert.match(text, /^Last run\s+3m ago \(12 runs\)$/m);
    assert.match(text, /^Latest report\s+Review of working tree \(review, 2m ago\): 1 error, 1 warning$/m);
    const never = render(fixture({ lastRun: { lastRunAt: null, runCount: 0, reportCount: 0, recentReports: [] } }));
    assert.match(never, /^Last run\s+no runs yet$/m);
    assert.doesNotMatch(never, /Latest report/);
});

test("renderStatus: engine checks and open problems", () => {
    const text = render(fixture());
    assert.match(text, /^Checks\s+✓ build\s+passed 4m ago$/m);
    assert.match(text, /^\s+✗ test\s+failed \(exit 1\) 3m ago · last passed 1h 0m ago$/m);
    assert.match(text, /^Problems\s+1 open problem \(1 regression\)$/m);
    assert.match(text, /test is failing \[regression\] since 3m ago/);
    assert.match(render(fixture({ engine: null })), /^Checks\s+none run yet$/m);
});

test("renderStatus: open findings with counts, regressions and +N more", () => {
    const text = render(fixture());
    assert.match(text, /^Findings\s+2 open: 1 error, 1 warning, 1 regression$/m);
    assert.match(text, /^\s+error\s+src\/a\.test\.ts:12 test failed \[regression\]$/m);
    assert.match(text, /^\s+warning\s+src\/b\.ts console\.log left in$/m);

    const items = Array.from({ length: 20 }, (_, i) => finding(i + 1));
    const many = fixture({
        findings: {
            source: "engine",
            updatedAt: ago(MIN),
            reportId: null,
            threshold: "info",
            total: 30,
            counts: { critical: 0, error: 0, warning: 30, info: 0 },
            regressions: 0,
            items,
            truncated: true,
        },
    });
    const normal = render(many);
    assert.match(normal, /src\/f5\.ts:5 warning number 5/);
    assert.doesNotMatch(normal, /src\/f6\.ts/);
    assert.match(normal, /\+25 more \(--verbose shows more\)/);
    const verbose = render(many, true);
    assert.match(verbose, /src\/f20\.ts:20 warning number 20/);
    assert.match(verbose, /\+10 more$/m);

    const clean = render(fixture({ findings: { ...fixture().findings, total: 0, counts: { critical: 0, error: 0, warning: 0, info: 0 }, regressions: 0, items: [] } }));
    assert.match(clean, /^Findings\s+✓ none open \(as of 2m ago\)$/m);
    const none = render(fixture({ findings: { ...fixture().findings, source: "none", total: 0, items: [] } }));
    assert.match(none, /^Findings\s+none recorded yet$/m);
});

test("renderStatus: drift shows heads, file counts and the reindex hint", () => {
    const text = render(fixture());
    assert.match(text, /^Drift\s+changed since the index \(indexed 2h 0m ago\)$/m);
    assert.match(text, /HEAD   1111111 → 2222222 on main, 3 commits since index$/m);
    assert.match(text, /Files  100 → 104 \(\+4\): 5 added, 1 removed$/m);
    assert.match(text, /Run "tyr init --force" to reindex\./);
});

test("renderStatus: no drift reads up to date, without the reindex hint", () => {
    const report = fixture({ drift: { ...UP_TO_DATE } });
    assert.equal(hasDrift(report.drift), false);
    const text = render(report);
    assert.match(text, /^Drift\s+✓ up to date with the index/m);
    assert.doesNotMatch(text, /tyr init --force/);
    assert.doesNotMatch(text, /HEAD /);
    assert.match(render(report, true), /HEAD   1111111 on main \(unchanged\)/);
});

test("renderStatus: skipped scan and a non-repo", () => {
    const report = fixture({
        drift: { ...UP_TO_DATE, isRepo: false, indexedHead: null, currentHead: null, currentBranch: null, headChanged: null, commitsSinceIndex: null, currentFileCount: null, fileCountDelta: null, filesAdded: null, filesRemoved: null },
    });
    const text = render(report, true);
    assert.match(text, /^Drift\s+unknown/m);
    assert.match(text, /HEAD   not a git repository/);
    assert.match(text, /Files  100 at index \(current count not scanned\)/);
});

test("renderStatus: warnings and an unreadable profile", () => {
    const report = fixture({
        project: null,
        warnings: [{ source: "config", message: "tyr.json: invalid JSON" }],
    });
    const text = render(report);
    assert.equal(text.split("\n")[0], "Tyr status: app");
    assert.match(text, /^Project\s+profile unavailable/m);
    assert.match(text, /^Warnings \(1\)$/m);
    assert.match(text, /^  ! tyr\.json: invalid JSON$/m);
    assert.match(render(report, true), /^  ! config: tyr\.json: invalid JSON$/m);
});

test("renderStatus: verbose lists every command slot, languages and reports", () => {
    const text = render(fixture(), true);
    assert.match(text, /^Commands\s+build\s+npm run build \(tsc, detected\)$/m);
    assert.match(text, /^\s+lint\s+not configured$/m);
    assert.match(text, /CSS 4% \(4 files\)/);
    assert.match(text, /^Reports\s+7 on disk; newest first:$/m);
    assert.match(text, /2026-11-17T10-00-00-check \(check, 2h 0m ago\) Checks: no findings/);
    assert.match(text, /npm test, 1m 01s/);
    assert.match(text, /^\s+1 failing$/m);
});

test("renderStatus: ASCII glyphs and colour", () => {
    const ascii = renderStatus(fixture(), { color: false, unicode: false, now: NOW }).join("\n");
    assert.match(ascii, /HEAD   1111111 -> 2222222/);
    assert.doesNotMatch(ascii, /[✓✗●→·]/);
    const colored = renderStatus(fixture(), { color: true, now: NOW }).join("\n");
    assert.match(colored, /\x1b\[/);
});

test("formatAgo", () => {
    assert.equal(formatAgo(null, NOW), "never");
    assert.equal(formatAgo(ago(1000), NOW), "just now");
    assert.equal(formatAgo(ago(45_000), NOW), "45s ago");
    assert.equal(formatAgo(ago(3 * 24 * HOUR), NOW), "3d 0h ago");
    assert.equal(formatAgo("garbage", NOW), "garbage");
});
