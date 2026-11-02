// reports.ts: JSON + Markdown report files under .tyr/reports/ with retention.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
    formatReportTimestamp,
    listReports,
    pruneReports,
    readReport,
    renderReportMarkdown,
    retentionFromConfig,
    slugify,
    writeReport,
} from "../cli/core/reports.js";
import { makeProject, removeProject } from "./helpers.js";

const DAY = 24 * 60 * 60 * 1000;

async function reportFiles(root: string): Promise<string[]> {
    return (await fs.readdir(path.join(root, ".tyr", "reports"))).sort();
}

test("names are UTC-timestamped, sortable, Windows-safe and slugged", async () => {
    const root = await makeProject({});
    try {
        const now = new Date(Date.UTC(2026, 10, 1, 9, 5, 7));
        const written = await writeReport(root, { kind: "review", title: "Fix: Auth / Tokens?! (v2)" }, { now });
        assert.equal(written.id, "20261101-090507-review-fix-auth-tokens-v2");
        assert.equal(path.basename(written.jsonFile), `${written.id}.json`);
        assert.equal(path.basename(written.mdFile), `${written.id}.md`);
        assert.ok(!/[:<>"|?*\\/]/.test(written.id));
        assert.equal(written.createdAt, now.toISOString());

        assert.equal(formatReportTimestamp(new Date(Date.UTC(2026, 0, 2, 3, 4, 5))), "20260102-030405");
        const a = formatReportTimestamp(new Date(Date.UTC(2026, 8, 30, 23, 59, 59)));
        const b = formatReportTimestamp(new Date(Date.UTC(2026, 9, 1, 0, 0, 0)));
        assert.ok(a < b, "lexicographic order follows time");

        assert.equal(slugify("   "), "report");
        assert.equal(slugify("Ünïcödé café"), "unicode-cafe");
        assert.ok(slugify("x".repeat(200)).length <= 48);
    } finally {
        await removeProject(root);
    }
});

test("same-second, same-title reports get collision suffixes", async () => {
    const root = await makeProject({});
    try {
        const now = new Date(Date.UTC(2026, 10, 1, 12, 0, 0));
        const results = await Promise.all(
            [1, 2, 3].map(() => writeReport(root, { kind: "check", title: "Lint" }, { now, retention: false })),
        );
        const ids = results.map((r) => r.id).sort();
        assert.deepEqual(ids, [
            "20261101-120000-check-lint",
            "20261101-120000-check-lint-2",
            "20261101-120000-check-lint-3",
        ]);
        assert.equal((await reportFiles(root)).length, 6);
    } finally {
        await removeProject(root);
    }
});

test("markdown groups findings by severity, most severe first", async () => {
    const root = await makeProject({});
    try {
        const written = await writeReport(root, {
            kind: "review",
            title: "Nightly review",
            summary: "Two problems found.",
            git: { branch: "main", headCommit: "0123456789abcdef0123" },
            findings: [
                { severity: "info", title: "Style nit" },
                { severity: "critical", title: "Secret committed", file: "src/a.ts", line: 3, rule: "secrets", detail: "line one\nline two" },
                { severity: "warning", title: "Slow test" },
                { severity: "bogus" as never, title: "Unknown severity" },
            ],
            data: { anything: [1, 2] },
        });
        const md = await fs.readFile(written.mdFile, "utf8");
        assert.equal(md, renderReportMarkdown(written));
        assert.match(md, /^# Nightly review\n/);
        assert.match(md, /- \*\*Git:\*\* main @ 0123456789ab/);
        assert.match(md, /## Summary\n\nTwo problems found\./);
        assert.match(md, /4 total: 1 critical, 1 warning, 2 info\./);
        assert.match(md, /- \*\*Secret committed\*\* `src\/a\.ts:3` \[secrets\]\n  line one\n  line two/);
        const critical = md.indexOf("### Critical (1)");
        const warnings = md.indexOf("### Warnings (1)");
        const info = md.indexOf("### Info (2)");
        assert.ok(critical > 0 && critical < warnings && warnings < info);
        assert.ok(!md.includes("### Errors"));

        const empty = await writeReport(root, { kind: "run", title: "Clean" });
        assert.match(await fs.readFile(empty.mdFile, "utf8"), /No findings\./);
    } finally {
        await removeProject(root);
    }
});

test("readReport and listReports round-trip, newest first, filter and limit", async () => {
    const root = await makeProject({});
    try {
        const base = Date.UTC(2026, 10, 1, 8, 0, 0);
        const first = await writeReport(root, { kind: "review", title: "One", findings: [{ severity: "error", title: "e" }] }, { now: new Date(base) });
        await writeReport(root, { kind: "check", title: "Two" }, { now: new Date(base + 1000) });
        const third = await writeReport(root, { kind: "review", title: "Three" }, { now: new Date(base + 2000) });

        const read = await readReport(root, first.id);
        assert.ok(read !== null);
        assert.equal(read.title, "One");
        assert.equal(read.version, 1);
        assert.deepEqual(read.findings, [{ severity: "error", title: "e" }]);
        assert.equal(await readReport(root, "../../etc/passwd"), null);
        assert.equal(await readReport(root, "20990101-000000-review-missing"), null);

        const all = await listReports(root);
        assert.deepEqual(all.map((r) => r.title), ["Three", "Two", "One"]);
        assert.equal(all[2].findingCounts.error, 1);

        const reviews = await listReports(root, { kind: "review", limit: 1 });
        assert.deepEqual(reviews.map((r) => r.id), [third.id]);
    } finally {
        await removeProject(root);
    }
});

test("listReports falls back to the file name for an unreadable JSON", async () => {
    const root = await makeProject({ ".tyr/reports/20261101-080000-check-broken-thing.json": "{ not json" });
    try {
        const [summary] = await listReports(root);
        assert.equal(summary.id, "20261101-080000-check-broken-thing");
        assert.equal(summary.kind, "check");
        assert.equal(summary.createdAt, "2026-11-01T08:00:00.000Z");
    } finally {
        await removeProject(root);
    }
});

test("retention by count deletes oldest pairs and leaves unrelated files", async () => {
    const root = await makeProject({
        ".tyr/reports/.gitkeep": "",
        ".tyr/reports/notes.md": "mine",
        ".tyr/reports/README.json": "{}",
    });
    try {
        const base = Date.UTC(2026, 10, 1, 8, 0, 0);
        const ids: string[] = [];
        for (let i = 0; i < 5; i++) {
            const r = await writeReport(root, { kind: "run", title: `r${i}` }, { now: new Date(base + i * 1000), retention: false });
            ids.push(r.id);
        }
        const pruned = await pruneReports(root, { maxCount: 2, maxAgeDays: 0 }, new Date(base + 10_000));
        assert.deepEqual(pruned.map((p) => p.id).sort(), ids.slice(0, 3).sort());
        assert.ok(pruned.every((p) => p.reason === "count" && p.files.length === 2));

        const files = await reportFiles(root);
        assert.deepEqual(files, [
            ".gitkeep",
            `${ids[3]}.json`,
            `${ids[3]}.md`,
            `${ids[4]}.json`,
            `${ids[4]}.md`,
            "README.json",
            "notes.md",
        ].sort());
    } finally {
        await removeProject(root);
    }
});

test("retention by age, applied automatically after writeReport from config", async () => {
    const root = await makeProject({ ".tyr/reports/.gitkeep": "" });
    try {
        const now = Date.UTC(2026, 10, 1, 8, 0, 0);
        const old = await writeReport(root, { kind: "run", title: "old" }, { now: new Date(now - 10 * DAY), retention: false });
        const recent = await writeReport(root, { kind: "run", title: "recent" }, { now: new Date(now - 2 * DAY), retention: false });

        const config = { version: 1, reports: { maxAgeDays: 7 } };
        assert.deepEqual(retentionFromConfig(config), { maxCount: 100, maxAgeDays: 7 });
        assert.deepEqual(retentionFromConfig({ reports: { maxCount: "lots" } }), { maxCount: 100, maxAgeDays: 30 });
        assert.deepEqual(retentionFromConfig(null), { maxCount: 100, maxAgeDays: 30 });

        const fresh = await writeReport(root, { kind: "run", title: "fresh" }, { now: new Date(now), config });
        assert.deepEqual(fresh.pruned.map((p) => [p.id, p.reason]), [[old.id, "age"]]);
        assert.deepEqual(await reportFiles(root), [".gitkeep", `${fresh.id}.json`, `${fresh.id}.md`, `${recent.id}.json`, `${recent.id}.md`].sort());

        // Disabled rules prune nothing.
        assert.deepEqual(await pruneReports(root, { maxCount: 0, maxAgeDays: 0 }, new Date(now + 365 * DAY)), []);
    } finally {
        await removeProject(root);
    }
});
