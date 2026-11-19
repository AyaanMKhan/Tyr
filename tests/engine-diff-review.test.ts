// diff-review.ts: every rule against handcrafted DiffResult fixtures, secret
// masking, suppression, disabled rules, hunk line numbers, and one real diff
// from a throwaway git repo.
//
// Fake secrets are assembled by concatenation so this file itself contains
// nothing secret-shaped.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getDiff, type DiffFileStat, type DiffResult, type DiffStatus } from "../cli/core/git-diff.js";
import { DIFF_RULES, maskSecret, parsePatch, reviewDiff, type DiffReviewOptions } from "../cli/engine/diff-review.js";
import { MAX_FINDINGS_PER_DETECTOR, type EngineFinding } from "../cli/engine/findings.js";
import { makeProject, removeProject } from "./helpers.js";

/* -------------------------------------------------------------------------
 * Fixture builders
 * ---------------------------------------------------------------------- */

interface FileSpec {
    path: string;
    status?: DiffStatus;
    added?: string[];
    removed?: string[];
    /** Start line of the single hunk in the new file. */
    start?: number;
    binary?: boolean;
    /** Override the stat line counts (for size rules without a patch). */
    additions?: number;
    deletions?: number;
    /** Leave out of the patch (stats only). */
    noPatch?: boolean;
}

function filePatch(spec: FileSpec): string {
    const status = spec.status ?? "M";
    const p = spec.path;
    const head = [`diff --git a/${p} b/${p}`];
    if (status === "A") head.push("new file mode 100644");
    if (status === "D") head.push("deleted file mode 100644");
    head.push("index 1111111..2222222");
    if (spec.binary === true) {
        head.push(`Binary files a/${p} and b/${p} differ`);
        return head.join("\n") + "\n";
    }
    const removed = spec.removed ?? [];
    const added = spec.added ?? [];
    head.push(status === "A" ? "--- /dev/null" : `--- a/${p}`);
    head.push(status === "D" ? "+++ /dev/null" : `+++ b/${p}`);
    const start = spec.start ?? 1;
    const oldStart = removed.length === 0 ? 0 : start;
    const newStart = added.length === 0 ? 0 : start;
    head.push(`@@ -${oldStart},${removed.length} +${newStart},${added.length} @@`);
    for (const line of removed) head.push(`-${line}`);
    for (const line of added) head.push(`+${line}`);
    return head.join("\n") + "\n";
}

function makeDiff(specs: FileSpec[], extra: Partial<DiffResult> = {}): DiffResult {
    const files: DiffFileStat[] = specs.map((s) => ({
        path: s.path,
        status: s.status ?? "M",
        additions: s.binary === true ? 0 : (s.additions ?? (s.added ?? []).length),
        deletions: s.binary === true ? 0 : (s.deletions ?? (s.removed ?? []).length),
        binary: s.binary === true,
    }));
    const totals = files.reduce((t, f) => ({ files: t.files + 1, additions: t.additions + f.additions, deletions: t.deletions + f.deletions }), {
        files: 0,
        additions: 0,
        deletions: 0,
    });
    const patch = specs
        .filter((s) => s.noPatch !== true)
        .map(filePatch)
        .join("");
    return { files, totals, untracked: null, patch, truncated: false, ...extra };
}

function review(diff: DiffResult, opts?: DiffReviewOptions): EngineFinding[] {
    return reviewDiff({ root: "/repo", diff, base: "HEAD" }, opts);
}

function rules(findings: EngineFinding[]): string[] {
    return [...new Set(findings.map((f) => f.rule ?? ""))].sort();
}

function only(findings: EngineFinding[], rule: string): EngineFinding[] {
    return findings.filter((f) => f.rule === rule);
}

// Fake secrets, built so no literal in this file matches a secret pattern.
const FAKE = {
    aws: "AKIA" + "IOSFODNN7" + "EXAMPLE",
    github: "gh" + "p_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
    githubPat: "github" + "_pat_" + "11ABCDEFG0123456789_abcdefghijKLMNOP",
    slack: "xo" + "xb-" + "123456789012-abcdefABCDEF",
    anthropic: "sk-" + "ant-" + "api03-Abc123Def456Ghi789Jkl",
    openai: "sk-" + "proj-" + "Q1w2E3r4T5y6U7i8O9p0Asdf",
    jwt: "ey" + "JhbGciOiJIUzI1NiJ9" + ".ey" + "JzdWIiOiIxMjM0NTY3ODkwIn0" + "." + "dBjftJeZ4CVPmB92K27uhbUJU1p1r",
    password: "Hunt3r2" + "SuperSecretValue9",
    privateKey: "-----BEGIN " + "RSA PRIVATE " + "KEY-----",
};

/* -------------------------------------------------------------------------
 * Patch parsing
 * ---------------------------------------------------------------------- */

test("parsePatch tracks new-file line numbers across hunks", () => {
    const patch = [
        "diff --git a/src/a.ts b/src/a.ts",
        "index 1..2 100644",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,3 +1,4 @@",
        " one",
        "+two",
        " three",
        "-gone",
        "+four",
        "@@ -40,2 +41,3 @@ function x() {",
        " forty",
        "+-- not a header",
        "--- also not a header",
        "+++ nor this",
        "\\ No newline at end of file",
        "",
    ].join("\n");
    const [file] = parsePatch(patch);
    assert.equal(file.path, "src/a.ts");
    const added = file.hunks.flatMap((h) => h.lines.filter((l) => l.kind === "add").map((l) => [l.line, l.text]));
    assert.deepEqual(added, [
        [2, "two"],
        [4, "four"],
        [42, "-- not a header"],
        [43, "++ nor this"],
    ]);
    const removed = file.hunks.flatMap((h) => h.lines.filter((l) => l.kind === "remove").map((l) => l.text));
    assert.deepEqual(removed, ["gone", "-- also not a header"]);
});

test("parsePatch handles renames, deletions, binaries and truncation", () => {
    const patch = [
        "diff --git a/old name.ts b/new name.ts",
        "similarity index 90%",
        "rename from old name.ts",
        "rename to new name.ts",
        "diff --git a/gone.test.ts b/gone.test.ts",
        "deleted file mode 100644",
        "--- a/gone.test.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-x",
        "diff --git a/img.png b/img.png",
        "Binary files a/img.png and b/img.png differ",
        "diff --git a/last.ts b/last.ts",
        "--- a/last.ts",
        "+++ b/last.ts",
        "@@ -1,1 +1,9 @@",
        "+cut",
    ].join("\n");
    const files = parsePatch(patch, true);
    assert.deepEqual(
        files.map((f) => [f.path, f.oldPath, f.status, f.binary, f.truncated]),
        [
            ["new name.ts", "old name.ts", "renamed", false, false],
            ["gone.test.ts", undefined, "deleted", false, false],
            ["img.png", undefined, "modified", true, false],
            ["last.ts", undefined, "modified", false, true],
        ],
    );
});

/* -------------------------------------------------------------------------
 * Secrets
 * ---------------------------------------------------------------------- */

test("each secret kind is a critical finding with file, line and a masked value", () => {
    const lines = [
        `const aws = "${FAKE.aws}";`,
        `token: ${FAKE.github}`,
        `pat = "${FAKE.githubPat}"`,
        `SLACK=${FAKE.slack}`,
        `const claude = "${FAKE.anthropic}";`,
        `const openai = "${FAKE.openai}";`,
        `auth: "Bearer ${FAKE.jwt}"`,
        `db_password = "${FAKE.password}"`,
        FAKE.privateKey,
    ];
    const findings = review(makeDiff([{ path: "src/config.ts", added: lines, start: 10 }]));
    const expected: [string, number][] = [
        ["diff/secret-aws-key", 10],
        ["diff/secret-github-token", 11],
        ["diff/secret-github-token", 12],
        ["diff/secret-slack-token", 13],
        ["diff/secret-anthropic-key", 14],
        ["diff/secret-openai-key", 15],
        ["diff/secret-jwt", 16],
        ["diff/secret-assignment", 17],
        ["diff/secret-private-key", 18],
    ];
    const secrets = findings.filter((f) => f.rule?.startsWith("diff/secret-"));
    assert.deepEqual(
        secrets.map((f) => [f.rule, f.line]).sort((a, b) => Number(a[1]) - Number(b[1])),
        expected,
    );
    for (const f of secrets) {
        assert.equal(f.severity, "critical");
        assert.equal(f.source, "diff");
        assert.equal(f.file, "src/config.ts");
        assert.match(f.fingerprint, /^[0-9a-f]{16}$/);
    }
    assert.ok(only(findings, "diff/secret-aws-key")[0].title.includes(maskSecret(FAKE.aws)));
    assert.equal(maskSecret(FAKE.aws), "AKIA…");

    // No secret appears anywhere in the serialized findings.
    const json = JSON.stringify(findings);
    for (const [name, secret] of Object.entries(FAKE)) {
        if (name === "privateKey") continue; // the marker line is not itself secret
        assert.ok(!json.includes(secret), `${name} leaked`);
        assert.ok(!json.includes(secret.slice(4, 16)), `${name} partly leaked`);
    }
});

test("secrets in lines flagged by other rules are redacted from their excerpts", () => {
    const findings = review(makeDiff([{ path: "src/a.ts", added: [`eval("${FAKE.anthropic}") // TODO`] }]));
    assert.deepEqual(rules(findings), ["diff/eval", "diff/secret-anthropic-key", "diff/todo"]);
    assert.ok(!JSON.stringify(findings).includes(FAKE.anthropic));
    assert.ok(only(findings, "diff/eval")[0].detail?.includes("sk-a…"));
});

test("placeholder credentials and identifiers are not secrets", () => {
    const findings = review(
        makeDiff([
            {
                path: "src/a.ts",
                added: [
                    `const passwordField = "password_confirmation";`,
                    `api_key = "\${process.env.API_KEY}"`,
                    `secret: "your_secret_here_1234"`,
                    `password = "xxxxxxxxxxxxxxxx"`,
                    `const sk = "sk-some-long-css-class-name";`,
                ],
            },
        ]),
    );
    assert.deepEqual(findings, []);
});

test(".env files added or left untracked are critical; examples are not", () => {
    const diff = makeDiff(
        [
            { path: ".env", status: "A", added: ["FOO=bar"] },
            { path: "app/.env.production", status: "A", added: ["X=1"] },
            { path: ".env.example", status: "A", added: ["FOO="] },
            { path: ".env.local", status: "M", added: ["Y=2"] },
        ],
        { untracked: ["docs/env.md", "web/.env"] },
    );
    const env = only(review(diff), "diff/secret-env-file");
    assert.deepEqual(env.map((f) => f.file).sort(), [".env", "app/.env.production", "web/.env"]);
    assert.ok(env.every((f) => f.severity === "critical"));
});

/* -------------------------------------------------------------------------
 * Tests deleted, removed, focused or skipped
 * ---------------------------------------------------------------------- */

test("deleted test files are flagged for every naming convention", () => {
    const paths = ["src/a.test.ts", "src/b.spec.js", "py/test_models.py", "go/server_test.go", "tests/integration.rb", "src/__tests__/c.tsx"];
    const diff = makeDiff([
        ...paths.map((p) => ({ path: p, status: "D" as const, removed: ["x"] })),
        { path: "src/contest.ts", status: "D", removed: ["x"] },
        { path: "src/testing.ts", status: "D", removed: ["x"] },
    ]);
    const deleted = only(review(diff), "diff/deleted-test-file");
    assert.deepEqual(deleted.map((f) => f.file).sort(), [...paths].sort());
    assert.ok(deleted.every((f) => f.severity === "warning"));
});

test("net removal of test cases inside a test file is flagged", () => {
    const diff = makeDiff([
        {
            path: "tests/math.test.ts",
            removed: ['test("adds", () => {', 'it("subtracts", () => {', "  expect(1).toBe(1);"],
            added: ['test("adds numbers", () => {'],
            start: 20,
        },
        { path: "py/test_x.py", removed: ["def test_a():", "async def test_b():"] },
        { path: "rs/tests/lib.rs", removed: ["#[test]"], added: ["#[test]"] },
        { path: "src/math.ts", removed: ['test("not a test file", () => {'] },
    ]);
    const removed = only(review(diff), "diff/removed-test-cases");
    assert.deepEqual(
        removed.map((f) => [f.file, f.title, f.line]),
        [
            ["py/test_x.py", "2 test cases removed from py/test_x.py", 1],
            ["tests/math.test.ts", "1 test case removed from tests/math.test.ts", 20],
        ],
    );
});

test("added .only and skips in test files are flagged", () => {
    const diff = makeDiff([
        {
            path: "src/a.test.ts",
            added: ['it.only("x", () => {});', 'describe.skip("y", () => {});', 'xit("z", () => {});', "it('fine', () => {});"],
        },
        { path: "test_api.py", added: ["@pytest.mark.skip(reason='flaky')"] },
        { path: "x_test.go", added: ['\tt.Skip("later")'] },
        { path: "src/stream.ts", added: ["iter.skip(3); list.only(1);"] },
    ]);
    const findings = review(diff);
    assert.deepEqual(
        only(findings, "diff/test-focus").map((f) => [f.file, f.line]),
        [["src/a.test.ts", 1]],
    );
    assert.deepEqual(
        only(findings, "diff/test-skip")
            .map((f) => [f.file, f.line])
            .sort(),
        [
            ["src/a.test.ts", 2],
            ["src/a.test.ts", 3],
            ["test_api.py", 1],
            ["x_test.go", 1],
        ],
    );
});

/* -------------------------------------------------------------------------
 * Risky patterns
 * ---------------------------------------------------------------------- */

test("risky patterns are flagged with the right rule and severity", () => {
    const cases: [string, string, string, string][] = [
        ["src/a.ts", "const f = eval(code);", "diff/eval", "warning"],
        ["src/a.ts", "const f = new Function('a', body);", "diff/eval", "warning"],
        ["src/a.ts", "execSync(`git log ${ref}`);", "diff/exec-interpolated", "error"],
        ["src/a.js", 'exec("rm " + file);', "diff/exec-interpolated", "error"],
        ["scripts/clean.sh", "rm -rf build/", "diff/rm-rf", "warning"],
        ["scripts/clean.sh", 'rm -rf "$OUT"/', "diff/rm-rf", "error"],
        ["scripts/clean.sh", "sudo rm -fr /", "diff/rm-rf", "error"],
        ["Makefile", "\tgit commit --no-verify -m wip", "diff/no-verify", "warning"],
        ["src/http.ts", "const agent = new Agent({ rejectUnauthorized: false });", "diff/tls-verify-disabled", "error"],
        ["api/client.py", "requests.get(url, verify=False)", "diff/tls-verify-disabled", "error"],
        ["ci/env.sh", "export NODE_TLS_REJECT_UNAUTHORIZED=0", "diff/tls-verify-disabled", "error"],
        ["src/a.ts", "// @ts-ignore", "diff/ts-ignore", "warning"],
        ["src/a.ts", "// eslint-disable-next-line no-console", "diff/eslint-disable", "warning"],
        ["src/a.ts", "const x = y as any;", "diff/any-cast", "info"],
        ["src/a.py", "# FIXME handle unicode", "diff/todo", "info"],
        ["src/a.ts", 'console.log("here", x);', "diff/console-log", "info"],
        ["src/a.ts", "  debugger;", "diff/debugger", "info"],
        ["src/a.py", "breakpoint()", "diff/debugger", "info"],
    ];
    for (const [file, line, rule, severity] of cases) {
        const findings = review(makeDiff([{ path: file, added: [line] }]));
        const hit = only(findings, rule);
        assert.equal(hit.length, 1, `${rule} for ${JSON.stringify(line)}: got ${JSON.stringify(rules(findings))}`);
        assert.equal(hit[0].severity, severity, `${rule} severity for ${JSON.stringify(line)}`);
        assert.equal(hit[0].file, file);
        assert.equal(hit[0].line, 1);
    }
});

test("risky patterns stay quiet where they do not apply", () => {
    const findings = review(
        makeDiff([
            { path: "src/a.test.ts", added: ['console.log("debug in a test");', "debugger;"] },
            { path: "src/a.js", added: ["const y = x as any;"] }, // not TypeScript
            { path: "src/a.ts", added: ["page.eval(x); execFile('git', ['log', ref]); exec(`git status`);"] },
            { path: "README.md", added: ["Run `rm -rf dist` then commit with --no-verify. TODO"] },
            { path: "src/a.ts", status: "D", removed: ["eval(x)"] },
        ]),
    );
    assert.deepEqual(findings, []);
});

/* -------------------------------------------------------------------------
 * Size and sensitive files
 * ---------------------------------------------------------------------- */

test("large changes: total lines, file count and single files, with thresholds", () => {
    const big = makeDiff([
        { path: "src/huge.ts", additions: 600, deletions: 10, noPatch: true },
        { path: "src/b.ts", additions: 300, deletions: 0, noPatch: true },
        { path: "package-lock.json", additions: 5000, deletions: 4000, noPatch: true },
        { path: "package.json", additions: 1, deletions: 1, noPatch: true },
        { path: "logo.png", binary: true },
    ]);
    const findings = review(big);
    assert.equal(only(findings, "diff/large-change").length, 1);
    assert.match(only(findings, "diff/large-change")[0].title, /9912 lines changed/);
    assert.deepEqual(
        only(findings, "diff/large-file-change").map((f) => f.file),
        ["src/huge.ts"],
    );
    assert.equal(only(findings, "diff/many-files").length, 0);

    const tuned = review(big, { thresholds: { maxChangedLines: 100000, maxFiles: 3, maxFileChangedLines: 250 } });
    assert.equal(only(tuned, "diff/large-change").length, 0);
    assert.equal(only(tuned, "diff/many-files").length, 1);
    assert.deepEqual(
        only(tuned, "diff/large-file-change")
            .map((f) => f.file)
            .sort(),
        ["src/b.ts", "src/huge.ts"],
    );

    const many = makeDiff(Array.from({ length: 41 }, (_, i) => ({ path: `f${i}.txt`, added: ["x"] })));
    assert.equal(only(review(many), "diff/many-files").length, 1);
});

test("lockfiles without manifests, CI files and manifests are flagged", () => {
    const findings = review(
        makeDiff([
            { path: "package-lock.json", added: ["x"] },
            { path: "rust/Cargo.lock", added: ["x"] },
            { path: "rust/Cargo.toml", added: ["x"] },
            { path: "go.sum", added: ["x"] },
            { path: "packages/web/package.json", added: ["x"] },
            { path: "yarn.lock", added: ["x"] },
            { path: ".github/workflows/ci.yml", added: ["x"] },
        ]),
    );
    // The root package-lock.json and yarn.lock are covered by the nested
    // workspace package.json; go.sum has no go.mod change.
    assert.deepEqual(
        only(findings, "diff/lockfile-without-manifest").map((f) => f.file),
        ["go.sum"],
    );
    assert.deepEqual(
        only(findings, "diff/ci-config").map((f) => [f.file, f.severity]),
        [[".github/workflows/ci.yml", "info"]],
    );
    assert.deepEqual(
        only(findings, "diff/dependency-manifest")
            .map((f) => f.file)
            .sort(),
        ["packages/web/package.json", "rust/Cargo.toml"],
    );

    const lonely = review(makeDiff([{ path: "package-lock.json", added: ["x"] }]));
    assert.match(only(lonely, "diff/lockfile-without-manifest")[0].title, /without package\.json/);
});

/* -------------------------------------------------------------------------
 * Suppression, disabling, skipping, capping
 * ---------------------------------------------------------------------- */

test("tyr-ignore suppresses all findings on its line, or only the named rules", () => {
    const findings = review(
        makeDiff([
            {
                path: "src/a.ts",
                added: ["eval(x) // TODO tyr-ignore", "eval(x) // TODO tyr-ignore: diff/todo", "eval(x) // TODO tyr-ignore: todo, eval", "eval(x) // TODO"],
            },
        ]),
    );
    assert.deepEqual(findings.map((f) => [f.rule, f.line]).sort(), [
        ["diff/eval", 2],
        ["diff/eval", 4],
        ["diff/todo", 4],
    ]);
});

test("disabledRules turns rules off by id, short id or prefix", () => {
    const diff = makeDiff([{ path: "src/a.ts", added: ["eval(x) // TODO", `k = "${FAKE.aws}"`] }]);
    assert.deepEqual(rules(review(diff)), ["diff/eval", "diff/secret-aws-key", "diff/todo"]);
    assert.deepEqual(rules(review(diff, { disabledRules: ["diff/eval", "todo"] })), ["diff/secret-aws-key"]);
    assert.deepEqual(rules(review(diff, { disabledRules: ["diff/secret-*"] })), ["diff/eval", "diff/todo"]);
});

test("binary and truncated files are skipped by patch rules but count for size", () => {
    const diff = makeDiff(
        [
            { path: "src/ok.ts", added: ["eval(a)"] },
            { path: "blob.bin", binary: true },
            { path: "src/cut.ts", added: ["eval(b)"], additions: 900 },
        ],
        { truncated: true },
    );
    const findings = review(diff);
    assert.deepEqual(
        only(findings, "diff/eval").map((f) => f.file),
        ["src/ok.ts"],
    );
    assert.deepEqual(
        only(findings, "diff/large-file-change").map((f) => f.file),
        ["src/cut.ts"],
    );
    assert.equal(only(findings, "diff/large-change").length, 1);
});

test("results are sorted most severe first, deduplicated and capped", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `x${i} = 1 // TODO`);
    lines.push(`k = "${FAKE.aws}"`);
    const findings = review(makeDiff([{ path: "src/a.py", added: lines }]));
    assert.equal(findings.length, MAX_FINDINGS_PER_DETECTOR);
    assert.equal(findings[0].rule, "diff/secret-aws-key");
    assert.equal(new Set(findings.map((f) => `${f.fingerprint}:${f.line}`)).size, findings.length);
});

test("reviewDiff never throws on malformed input", () => {
    const junk = { files: null, totals: { files: 0, additions: 0, deletions: 0 }, patch: 42, truncated: false, untracked: null };
    assert.deepEqual(reviewDiff({ root: "/", base: "HEAD", diff: junk as unknown as DiffResult }), []);
    assert.deepEqual(review(makeDiff([], { patch: "@@ garbage\n+++\n-\ndiff --git\n" })), []);
});

test("rule ids are unique and namespaced", () => {
    const ids = DIFF_RULES.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.every((id) => /^diff\/[a-z0-9-]+$/.test(id)));
});

/* -------------------------------------------------------------------------
 * Real repository
 * ---------------------------------------------------------------------- */

function git(root: string, ...args: string[]): string {
    return execFileSync("git", ["-c", "user.name=Tyr", "-c", "user.email=tyr@example.com", ...args], {
        cwd: root,
        encoding: "utf8",
    });
}

test("reviews a real diff from git with correct lines", async () => {
    const original = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const root = await makeProject({
        "src/app.ts": original.join("\n") + "\n",
        "tests/app.test.ts": 'test("a", () => {});\ntest("b", () => {});\n',
    });
    try {
        git(root, "init", "-q");
        git(root, "add", ".");
        git(root, "commit", "-q", "-m", "first");

        const edited = [...original];
        edited.splice(2, 0, "const r = eval(input);");
        edited.splice(25, 0, `const key = "${FAKE.github}";`);
        await fs.writeFile(path.join(root, "src/app.ts"), edited.join("\n") + "\n");
        await fs.rm(path.join(root, "tests/app.test.ts"));

        const diff = await getDiff(root, { kind: "since", ref: "HEAD" });
        assert.ok(diff !== null);
        const findings = reviewDiff({ root, diff, base: "HEAD" });
        assert.deepEqual(
            findings.map((f) => [f.rule, f.file, f.line, f.severity]),
            [
                ["diff/secret-github-token", "src/app.ts", 26, "critical"],
                ["diff/eval", "src/app.ts", 3, "warning"],
                ["diff/deleted-test-file", "tests/app.test.ts", undefined, "warning"],
            ],
        );
        assert.ok(!JSON.stringify(findings).includes(FAKE.github));
    } finally {
        await removeProject(root);
    }
});
