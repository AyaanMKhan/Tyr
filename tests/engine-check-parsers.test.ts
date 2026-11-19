// Check output parsers (cli/engine/check-parsers.ts). The tsc and node:test
// samples were captured from real runs; the others are copied from each tool's
// documented output format.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import { parseCheckRun, relativizePath, stripAnsi } from "../cli/engine/check-parsers.js";
import { MAX_FINDINGS_PER_DETECTOR, type EngineFinding } from "../cli/engine/findings.js";
import type { CheckKind, CheckOutcome, CheckRun } from "../cli/engine/model.js";

const CWD = "/home/dev/proj";

function run(over: Partial<CheckRun> & { kind: CheckKind; command: string }): CheckRun {
    const outcome: CheckOutcome = over.outcome ?? "failed";
    return {
        id: "run-1",
        cwd: CWD,
        trigger: { reason: "manual" },
        startedAt: "2026-11-17T10:00:00.000Z",
        finishedAt: "2026-11-17T10:00:02.000Z",
        durationMs: 2000,
        outcome,
        exitCode: outcome === "passed" ? 0 : outcome === "failed" ? 1 : null,
        signal: null,
        stdout: "",
        stderr: "",
        outputTruncated: false,
        headCommit: "abc123",
        ...over,
    };
}

/** The interesting fields, for compact assertions. */
function brief(f: EngineFinding) {
    return { severity: f.severity, title: f.title, file: f.file, line: f.line, column: f.column, rule: f.rule };
}

function assertCommon(findings: EngineFinding[], kind: CheckKind): void {
    for (const f of findings) {
        assert.equal(f.source, "check");
        assert.equal(f.checkKind, kind);
        assert.match(f.fingerprint, /^[0-9a-f]{16}$/);
    }
}

/* ---------------------------------------------------------------- tsc */

test("tsc: plain format with paths relative to the run's cwd", () => {
    const stdout = [
        "src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
        "src/a.ts(2,34): error TS2339: Property 'foo' does not exist on type 'string'.",
        "src/b.ts(10,3): error TS2345: Argument of type '{ id: string; }' is not assignable to parameter of type 'User'.",
        "  Property 'name' is missing in type '{ id: string; }' but required in type 'User'.",
        "",
    ].join("\n");
    const findings = parseCheckRun(run({ kind: "typecheck", command: "npx tsc --noEmit", stdout, exitCode: 2 }));
    assertCommon(findings, "typecheck");
    assert.deepEqual(findings.map(brief), [
        {
            severity: "error",
            title: "Type 'string' is not assignable to type 'number'.",
            file: "src/a.ts",
            line: 1,
            column: 7,
            rule: "TS2322",
        },
        {
            severity: "error",
            title: "Property 'foo' does not exist on type 'string'.",
            file: "src/a.ts",
            line: 2,
            column: 34,
            rule: "TS2339",
        },
        {
            severity: "error",
            title: "Argument of type '{ id: string; }' is not assignable to parameter of type 'User'.",
            file: "src/b.ts",
            line: 10,
            column: 3,
            rule: "TS2345",
        },
    ]);
    assert.equal(findings[2].detail, "Property 'name' is missing in type '{ id: string; }' but required in type 'User'.");
});

test("tsc: pretty format with ANSI colors and ../ paths that resolve under cwd", () => {
    // Captured from `tsc -p <dir> --pretty true` run from elsewhere.
    const p = "../../../../home/dev/proj/src/a.ts";
    const stdout =
        `\u001b[96m${p}\u001b[0m:\u001b[93m1\u001b[0m:\u001b[93m7\u001b[0m - \u001b[91merror\u001b[0m\u001b[90m TS2322: \u001b[0mType 'string' is not assignable to type 'number'.\n` +
        "\n" +
        '\u001b[7m1\u001b[0m const x: number = "hi";\n' +
        "\u001b[7m \u001b[0m \u001b[91m      ~\u001b[0m\n" +
        "\n" +
        `\u001b[96m${p}\u001b[0m:\u001b[93m2\u001b[0m:\u001b[93m34\u001b[0m - \u001b[91merror\u001b[0m\u001b[90m TS2339: \u001b[0mProperty 'foo' does not exist on type 'string'.\n` +
        "\n" +
        "\u001b[7m2\u001b[0m function f(a: string) { return a.foo; }\n" +
        "\u001b[7m \u001b[0m \u001b[91m                                 ~~~\u001b[0m\n" +
        "\n\n" +
        `Found 2 errors in the same file, starting at: ${p}\u001b[90m:1\u001b[0m\n`;
    const findings = parseCheckRun(run({ kind: "typecheck", command: "tsc --pretty", stdout, exitCode: 2 }));
    assert.deepEqual(findings.map(brief), [
        { severity: "error", title: "Type 'string' is not assignable to type 'number'.", file: "src/a.ts", line: 1, column: 7, rule: "TS2322" },
        { severity: "error", title: "Property 'foo' does not exist on type 'string'.", file: "src/a.ts", line: 2, column: 34, rule: "TS2339" },
    ]);
});

/* ------------------------------------------------------------- eslint */

const ESLINT_STYLISH = `
/home/dev/proj/src/app.js
   1:7   error    'unused' is assigned a value but never used  no-unused-vars
   4:3   warning  Unexpected console statement                 no-console
  12:10  error    Parsing error: Unexpected token )

/home/dev/proj/src/util/helpers.js
  8:1  warning  Missing JSDoc comment  jsdoc/require-jsdoc

✖ 4 problems (2 errors, 2 warnings)
  0 errors and 1 warning potentially fixable with the \`--fix\` option.
`;

test("eslint: stylish output, errors and warnings with rule ids", () => {
    const findings = parseCheckRun(run({ kind: "lint", command: "npx eslint .", stdout: ESLINT_STYLISH }));
    assertCommon(findings, "lint");
    assert.deepEqual(findings.map(brief), [
        { severity: "error", title: "'unused' is assigned a value but never used", file: "src/app.js", line: 1, column: 7, rule: "no-unused-vars" },
        { severity: "warning", title: "Unexpected console statement", file: "src/app.js", line: 4, column: 3, rule: "no-console" },
        { severity: "error", title: "Parsing error: Unexpected token )", file: "src/app.js", line: 12, column: 10, rule: undefined },
        { severity: "warning", title: "Missing JSDoc comment", file: "src/util/helpers.js", line: 8, column: 1, rule: "jsdoc/require-jsdoc" },
    ]);
});

test("eslint: a passed run still yields its warnings, but no errors", () => {
    const stdout = `
/home/dev/proj/src/app.js
  4:3  warning  Unexpected console statement  no-console

✖ 1 problem (0 errors, 1 warning)
`;
    const findings = parseCheckRun(run({ kind: "lint", command: "eslint src", outcome: "passed", stdout }));
    assert.deepEqual(findings.map(brief), [
        { severity: "warning", title: "Unexpected console statement", file: "src/app.js", line: 4, column: 3, rule: "no-console" },
    ]);
});

test("eslint: unix and compact formats", () => {
    const unix = [
        "/home/dev/proj/src/app.js:1:7: 'unused' is assigned a value but never used. [Error/no-unused-vars]",
        "/home/dev/proj/src/app.js:4:3: Unexpected console statement. [Warning/no-console]",
        "",
        "2 problems",
    ].join("\n");
    const compact = [
        "/home/dev/proj/src/app.js: line 1, col 7, Error - 'unused' is assigned a value but never used. (no-unused-vars)",
        "/home/dev/proj/src/app.js: line 4, col 3, Warning - Unexpected console statement. (no-console)",
        "",
        "2 problems",
    ].join("\n");
    for (const stdout of [unix, compact]) {
        const findings = parseCheckRun(run({ kind: "lint", command: "eslint -f unix .", stdout }));
        assert.deepEqual(findings.map(brief), [
            { severity: "error", title: "'unused' is assigned a value but never used.", file: "src/app.js", line: 1, column: 7, rule: "no-unused-vars" },
            { severity: "warning", title: "Unexpected console statement.", file: "src/app.js", line: 4, column: 3, rule: "no-console" },
        ]);
    }
});

/* ---------------------------------------------------------- node:test */

// Captured from `node --test --test-reporter=tap` (paths rewritten under CWD).
const NODE_TAP = `TAP version 13
# Subtest: math
    # Subtest: adds
    not ok 1 - adds
      ---
      duration_ms: 0.722417
      type: 'test'
      location: '/home/dev/proj/tests/t.test.mjs:2:26'
      failureType: 'testCodeFailure'
      error: |-
        Expected values to be strictly equal:

        2 !== 3

      code: 'ERR_ASSERTION'
      name: 'AssertionError'
      expected: 3
      actual: 2
      operator: 'strictEqual'
      stack: |-
        TestContext.<anonymous> (file:///home/dev/proj/tests/t.test.mjs:2:52)
        Test.runInAsyncScope (node:async_hooks:226:14)
      ...
    # Subtest: ok
    ok 2 - ok
      ---
      duration_ms: 0.080667
      type: 'test'
      ...
    # Subtest: later
    not ok 3 - later # TODO
      ---
      duration_ms: 0.05
      ...
    1..3
not ok 1 - math
  ---
  duration_ms: 1.309417
  type: 'suite'
  location: '/home/dev/proj/tests/t.test.mjs:2:1'
  failureType: 'subtestsFailed'
  error: '1 subtest failed'
  code: 'ERR_TEST_FAILURE'
  ...
# Subtest: top level fails
not ok 2 - top level fails
  ---
  duration_ms: 0.476791
  type: 'test'
  location: '/home/dev/proj/tests/t.test.mjs:3:1'
  failureType: 'testCodeFailure'
  error: 'boom'
  code: 'ERR_TEST_FAILURE'
  stack: |-
    TestContext.<anonymous> (file:///home/dev/proj/tests/t.test.mjs:3:39)
  ...
1..2
# tests 3
# suites 1
# pass 1
# fail 2
`;

test("node:test TAP: failing tests with location and error, skipping suites and TODOs", () => {
    const findings = parseCheckRun(run({ kind: "test", command: "node --test --test-reporter=tap", stdout: NODE_TAP }));
    assertCommon(findings, "test");
    assert.deepEqual(findings.map(brief), [
        { severity: "error", title: "Test failed: adds", file: "tests/t.test.mjs", line: 2, column: 26, rule: "adds" },
        { severity: "error", title: "Test failed: top level fails", file: "tests/t.test.mjs", line: 3, column: 1, rule: "top level fails" },
    ]);
    assert.equal(findings[0].detail, "Expected values to be strictly equal:\n2 !== 3");
    assert.equal(findings[1].detail, "boom");
});

// Captured from `node --test --test-reporter=spec`, run from /home/dev.
const NODE_SPEC = `▶ math
  ✖ adds (1.070416ms)
  ✔ ok (0.079333ms)
✖ math (1.691083ms)
✖ top level fails (0.456375ms)
ℹ tests 3
ℹ suites 1
ℹ pass 1
ℹ fail 2
ℹ duration_ms 47.968083

✖ failing tests:

test at proj/tests/t.test.mjs:2:26
✖ adds (1.070416ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  2 !== 3

      at TestContext.<anonymous> (file:///home/dev/proj/tests/t.test.mjs:2:52)
      at Test.runInAsyncScope (node:async_hooks:226:14) {
    generatedMessage: true,
    code: 'ERR_ASSERTION'
  }

test at proj/tests/t.test.mjs:3:1
✖ top level fails (0.456375ms)
  Error: boom
      at TestContext.<anonymous> (file:///home/dev/proj/tests/t.test.mjs:3:39)
`;

test("node:test spec: the failing-tests summary gives names, locations and messages", () => {
    const findings = parseCheckRun(run({ kind: "test", command: "node --test", cwd: "/home/dev", stdout: NODE_SPEC }));
    assert.deepEqual(findings.map(brief), [
        { severity: "error", title: "Test failed: adds", file: "proj/tests/t.test.mjs", line: 2, column: 26, rule: "adds" },
        { severity: "error", title: "Test failed: top level fails", file: "proj/tests/t.test.mjs", line: 3, column: 1, rule: "top level fails" },
    ]);
    assert.equal(findings[0].detail, "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n2 !== 3");
    assert.equal(findings[1].detail, "Error: boom");
});

test("node:test spec: without the summary, progress lines are used and suites skipped", () => {
    const stdout = NODE_SPEC.slice(0, NODE_SPEC.indexOf("ℹ tests"));
    const findings = parseCheckRun(run({ kind: "test", command: "node --test", stdout }));
    assert.deepEqual(
        findings.map((f) => f.rule),
        ["adds", "top level fails"],
    );
});

/* ------------------------------------------------------- jest / vitest */

const JEST = `PASS src/util.test.js
FAIL src/sum.test.js
  Math
    ✓ subtracts (2 ms)
    ✕ adds numbers (4 ms)

  ● Math › adds numbers

    expect(received).toBe(expected) // Object.is equality

    Expected: 4
    Received: 3

      3 | describe('Math', () => {
      4 |   test('adds numbers', () => {
    > 5 |     expect(sum(1, 2)).toBe(4);
        |                       ^
      6 |   });

      at Object.toBe (src/sum.test.js:5:23)

Test Suites: 1 failed, 1 passed, 2 total
Tests:       1 failed, 2 passed, 3 total
`;

test("jest: ● blocks give the test name, message and the test file's frame", () => {
    const findings = parseCheckRun(run({ kind: "test", command: "npx jest", stderr: JEST }));
    assertCommon(findings, "test");
    assert.deepEqual(findings.map(brief), [
        { severity: "error", title: "Test failed: Math › adds numbers", file: "src/sum.test.js", line: 5, column: 23, rule: "Math › adds numbers" },
    ]);
    assert.equal(findings[0].detail, "expect(received).toBe(expected) // Object.is equality\nExpected: 4\nReceived: 3");
});

test("jest: ✕ lines are used when no ● blocks are present", () => {
    const stderr = "FAIL src/sum.test.js\n  Math\n    ✕ adds numbers (4 ms)\n    ✕ multiplies (1 ms)\n";
    const findings = parseCheckRun(run({ kind: "test", command: "jest", stderr }));
    assert.deepEqual(
        findings.map((f) => [f.title, f.rule]),
        [
            ["Test failed: adds numbers", "adds numbers"],
            ["Test failed: multiplies", "multiplies"],
        ],
    );
});

const VITEST = ` ❯ src/sum.test.ts (2 tests | 1 failed) 5ms
   × Math > adds numbers 3ms
     → expected 3 to be 4 // Object.is equality

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/sum.test.ts > Math > adds numbers
AssertionError: expected 3 to be 4 // Object.is equality

- Expected
+ Received

- 4
+ 3

 ❯ src/sum.test.ts:5:23
      3| describe('Math', () => {
      4|   it('adds numbers', () => {
      5|     expect(sum(1, 2)).toBe(4);
       |                       ^

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
`;

test("vitest: FAIL path > suite > test blocks with the ❯ location", () => {
    const findings = parseCheckRun(run({ kind: "test", command: "npx vitest run", stdout: VITEST }));
    assert.deepEqual(findings.map(brief), [
        { severity: "error", title: "Test failed: Math > adds numbers", file: "src/sum.test.ts", line: 5, column: 23, rule: "Math > adds numbers" },
    ]);
    assert.match(findings[0].detail ?? "", /^AssertionError: expected 3 to be 4/);
});

/* -------------------------------------------------------------- pytest */

const PYTEST = `============================= test session starts ==============================
platform linux -- Python 3.12.1, pytest-8.0.0, pluggy-1.4.0
rootdir: /home/dev/proj
collected 3 items

tests/test_math.py .F                                                    [ 66%]
tests/test_user.py F                                                     [100%]

=================================== FAILURES ===================================
___________________________________ test_add ___________________________________

    def test_add():
>       assert add(1, 2) == 4
E       assert 3 == 4
E        +  where 3 = add(1, 2)

tests/test_math.py:5: AssertionError
____________________________ TestUser.test_name ________________________________

self = <tests.test_user.TestUser object at 0x7f>

    def test_name(self):
>       assert User("a").name == "b"
E       AssertionError: assert 'a' == 'b'

tests/test_user.py:9: AssertionError
=========================== short test summary info ============================
FAILED tests/test_math.py::test_add - assert 3 == 4
FAILED tests/test_user.py::TestUser::test_name - AssertionError: assert 'a' == 'b'
========================= 2 failed, 1 passed in 0.12s ==========================
`;

test("pytest: FAILED summary lines with E detail and the failing line", () => {
    const findings = parseCheckRun(run({ kind: "test", command: "pytest -q", stdout: PYTEST }));
    assertCommon(findings, "test");
    assert.deepEqual(findings.map(brief), [
        { severity: "error", title: "Test failed: test_add", file: "tests/test_math.py", line: 5, column: undefined, rule: "test_add" },
        {
            severity: "error",
            title: "Test failed: TestUser.test_name",
            file: "tests/test_user.py",
            line: 9,
            column: undefined,
            rule: "TestUser::test_name",
        },
    ]);
    assert.equal(findings[0].detail, "assert 3 == 4\n +  where 3 = add(1, 2)");
    assert.equal(findings[1].detail, "AssertionError: assert 'a' == 'b'");
});

/* ---------------------------------------------------------------- rust */

const CARGO_BUILD = `   Compiling demo v0.1.0 (/home/dev/proj)
warning: unused variable: \`y\`
 --> src/main.rs:3:9
  |
3 |     let y = 2;
  |         ^ help: if this is intentional, prefix it with an underscore: \`_y\`
  |
  = note: \`#[warn(unused_variables)]\` on by default

error[E0308]: mismatched types
 --> src/main.rs:4:18
  |
4 |     let x: i32 = "hello";
  |            ---   ^^^^^^^ expected \`i32\`, found \`&str\`
  |            |
  |            expected due to this

For more information about this error, try \`rustc --explain E0308\`.
warning: \`demo\` (bin "demo") generated 1 warning
error: could not compile \`demo\` (bin "demo") due to 1 previous error; 1 warning emitted
`;

test("cargo: error[E....] and warnings with their --> locations", () => {
    const findings = parseCheckRun(run({ kind: "build", command: "cargo build", stderr: CARGO_BUILD, exitCode: 101 }));
    assertCommon(findings, "build");
    assert.deepEqual(findings.map(brief), [
        { severity: "warning", title: "unused variable: `y`", file: "src/main.rs", line: 3, column: 9, rule: "unused_variables" },
        { severity: "error", title: "mismatched types", file: "src/main.rs", line: 4, column: 18, rule: "E0308" },
    ]);
});

const CARGO_TEST = `running 2 tests
test tests::subtracts ... ok
test tests::adds ... FAILED

failures:

---- tests::adds stdout ----

thread 'tests::adds' panicked at src/lib.rs:12:9:
assertion \`left == right\` failed
  left: 3
 right: 4
note: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace


failures:
    tests::adds

test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
`;

test("cargo test: test x ... FAILED with the panic location", () => {
    const findings = parseCheckRun(run({ kind: "test", command: "cargo test", stdout: CARGO_TEST, exitCode: 101 }));
    assert.deepEqual(findings.map(brief), [
        { severity: "error", title: "Test failed: tests::adds", file: "src/lib.rs", line: 12, column: 9, rule: "tests::adds" },
    ]);
    assert.equal(findings[0].detail, "assertion `left == right` failed\n  left: 3\n right: 4");
});

/* ------------------------------------------------------------------ go */

test("go: build errors as file.go:l:c: msg", () => {
    const stderr = "# example.com/demo\n./main.go:7:2: undefined: fmt.Printn\n./main.go:9:6: declared and not used: x\n";
    const findings = parseCheckRun(run({ kind: "build", command: "go build ./...", stderr }));
    assert.deepEqual(findings.map(brief), [
        { severity: "error", title: "undefined: fmt.Printn", file: "main.go", line: 7, column: 2, rule: undefined },
        { severity: "error", title: "declared and not used: x", file: "main.go", line: 9, column: 6, rule: undefined },
    ]);
});

test("go test: --- FAIL with subtests reported instead of their parent", () => {
    const stdout = `--- FAIL: TestAdd (0.00s)
    --- FAIL: TestAdd/negative (0.00s)
        math_test.go:14: Add(-1, -2) = -4, want -3
--- FAIL: TestDivide (0.00s)
    math_test.go:22: expected error for division by zero
FAIL
FAIL	example.com/demo	0.002s
FAIL
`;
    const findings = parseCheckRun(run({ kind: "test", command: "go test ./...", stdout }));
    assert.deepEqual(findings.map(brief), [
        { severity: "error", title: "Test failed: TestAdd/negative", file: "math_test.go", line: 14, column: undefined, rule: "TestAdd/negative" },
        { severity: "error", title: "Test failed: TestDivide", file: "math_test.go", line: 22, column: undefined, rule: "TestDivide" },
    ]);
    assert.equal(findings[0].detail, "Add(-1, -2) = -4, want -3");
});

/* -------------------------------------------------------------- python */

test("ruff / flake8 concise output: codes as rules, W codes as warnings", () => {
    const stdout = [
        "src/app.py:1:8: F401 [*] `os` imported but unused",
        "src/app.py:12:89: E501 Line too long (104 > 88)",
        "src/app.py:20:1: W291 trailing whitespace",
        "Found 3 errors.",
        "[*] 1 fixable with the `--fix` option.",
    ].join("\n");
    const findings = parseCheckRun(run({ kind: "lint", command: "ruff check .", stdout }));
    assert.deepEqual(findings.map(brief), [
        { severity: "error", title: "`os` imported but unused", file: "src/app.py", line: 1, column: 8, rule: "F401" },
        { severity: "error", title: "Line too long (104 > 88)", file: "src/app.py", line: 12, column: 89, rule: "E501" },
        { severity: "warning", title: "trailing whitespace", file: "src/app.py", line: 20, column: 1, rule: "W291" },
    ]);
});

test("ruff full output format", () => {
    const stdout = `F401 [*] \`os\` imported but unused
 --> src/app.py:1:8
  |
1 | import os
  |        ^^
  |
help: Remove unused import: \`os\`

Found 1 error.
`;
    const findings = parseCheckRun(run({ kind: "lint", command: "ruff check", stdout }));
    assert.deepEqual(findings.map(brief), [{ severity: "error", title: "`os` imported but unused", file: "src/app.py", line: 1, column: 8, rule: "F401" }]);
});

test("mypy: errors with [code], notes ignored", () => {
    const stdout = [
        'src/app.py:12: error: Incompatible types in assignment (expression has type "str", variable has type "int")  [assignment]',
        "src/app.py:12: note: See https://mypy.readthedocs.io for more info",
        "src/models.py:3:5: error: Missing return statement  [return]",
        "Found 2 errors in 2 files (checked 5 source files)",
    ].join("\n");
    const findings = parseCheckRun(run({ kind: "typecheck", command: "mypy src", stdout }));
    assert.deepEqual(findings.map(brief), [
        {
            severity: "error",
            title: 'Incompatible types in assignment (expression has type "str", variable has type "int")',
            file: "src/app.py",
            line: 12,
            column: undefined,
            rule: "assignment",
        },
        { severity: "error", title: "Missing return statement", file: "src/models.py", line: 3, column: 5, rule: "return" },
    ]);
});

/* ------------------------------------------------------------- generic */

test("generic path:line:col: error|warning: msg fallback (gcc/clang)", () => {
    const stderr = [
        "src/main.c: In function 'main':",
        "src/main.c:5:9: warning: unused variable 'y' [-Wunused-variable]",
        "src/main.c:6:5: error: 'z' undeclared (first use in this function)",
        "    6 |     z = 1;",
        "      |     ^",
    ].join("\n");
    const findings = parseCheckRun(run({ kind: "build", command: "make", stderr, exitCode: 2 }));
    assert.deepEqual(findings.map(brief), [
        { severity: "warning", title: "unused variable 'y'", file: "src/main.c", line: 5, column: 9, rule: "unused-variable" },
        { severity: "error", title: "'z' undeclared (first use in this function)", file: "src/main.c", line: 6, column: 5, rule: undefined },
    ]);
});

/* ---------------------------------------------------- paths and ANSI */

test("relativizePath: absolute under cwd, Windows separators, file URLs, outside paths", () => {
    assert.equal(relativizePath("/home/dev/proj/src/a.ts", CWD), "src/a.ts");
    assert.equal(relativizePath("./src/a.ts", CWD), "src/a.ts");
    assert.equal(relativizePath("file:///home/dev/proj/src/a.ts", CWD), "src/a.ts");
    assert.equal(relativizePath("/usr/lib/node/x.js", CWD), "/usr/lib/node/x.js");
    assert.equal(relativizePath("../other/x.ts", CWD), "../other/x.ts");
    assert.equal(relativizePath("C:\\Users\\dev\\proj\\src\\a.ts", "C:\\Users\\dev\\proj"), "src/a.ts");
    assert.equal(relativizePath("c:\\users\\dev\\proj\\src\\a.ts", "C:\\Users\\dev\\proj"), "src/a.ts");
    assert.equal(relativizePath("src\\lib\\b.ts", "C:\\Users\\dev\\proj"), "src/lib/b.ts");
});

test("Windows tsc output is relativized against a Windows cwd", () => {
    const stdout = "C:\\work\\proj\\src\\a.ts(3,1): error TS1005: ';' expected.\n";
    const findings = parseCheckRun(run({ kind: "typecheck", command: "tsc", cwd: "C:\\work\\proj", stdout }));
    assert.equal(findings[0].file, "src/a.ts");
    assert.equal(findings[0].line, 3);
});

test("stripAnsi removes colors, cursor codes and OSC hyperlinks", () => {
    assert.equal(stripAnsi("\u001b[1m\u001b[31mred\u001b[39m\u001b[22m \u001b[2K\u001b[1Gx"), "red x");
    assert.equal(stripAnsi("\u001b]8;;file:///a.ts\u0007a.ts\u001b]8;;\u0007"), "a.ts");
});

test("colored eslint output parses the same as plain", () => {
    const colored =
        "\n\u001b[4m/home/dev/proj/src/app.js\u001b[24m\n" +
        "  \u001b[2m4:3\u001b[22m  \u001b[33mwarning\u001b[39m  Unexpected console statement  \u001b[2mno-console\u001b[22m\n\n" +
        "\u001b[33m\u001b[1m✖ 1 problem (0 errors, 1 warning)\u001b[22m\u001b[39m\n";
    const findings = parseCheckRun(run({ kind: "lint", command: "eslint .", outcome: "passed", stdout: colored }));
    assert.deepEqual(findings.map(brief), [
        { severity: "warning", title: "Unexpected console statement", file: "src/app.js", line: 4, column: 3, rule: "no-console" },
    ]);
});

/* ------------------------------------------------- fallback and outcomes */

test("fallback: a failed run nothing recognizes yields one summary with the output tail", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `step ${i + 1} went sideways`);
    const findings = parseCheckRun(run({ kind: "test", command: "./run-tests.sh", stdout: lines.join("\n"), exitCode: 3 }));
    assert.equal(findings.length, 1);
    assert.equal(findings[0].title, "test failed (exit 3)");
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].source, "check");
    assert.equal(findings[0].checkKind, "test");
    assert.deepEqual(findings[0].detail?.split("\n"), lines.slice(-20));
});

test("fallback: timeouts are always reported, alongside anything parsed", () => {
    const findings = parseCheckRun(run({ kind: "test", command: "npx jest", outcome: "timeout", durationMs: 600_000, stderr: JEST }));
    assert.deepEqual(
        findings.map((f) => f.title),
        ["test timed out after 600s", "Test failed: Math › adds numbers"],
    );
});

test("fallback: a failed run with only warnings still gets a summary error", () => {
    const stdout = "\n/home/dev/proj/src/app.js\n  4:3  warning  Unexpected console statement  no-console\n";
    const findings = parseCheckRun(run({ kind: "lint", command: "eslint --max-warnings 0 .", stdout }));
    assert.deepEqual(
        findings.map((f) => [f.severity, f.title]),
        [
            ["error", "lint failed (exit 1)"],
            ["warning", "Unexpected console statement"],
        ],
    );
});

test("passed runs without warnings, and error/cancelled runs, yield nothing", () => {
    assert.deepEqual(parseCheckRun(run({ kind: "test", command: "node --test", outcome: "passed", stdout: "ℹ tests 3\nℹ pass 3\n" })), []);
    assert.deepEqual(parseCheckRun(run({ kind: "typecheck", command: "tsc", outcome: "passed" })), []);
    assert.deepEqual(parseCheckRun(run({ kind: "test", command: "nope", outcome: "error", exitCode: null, error: "spawn ENOENT" })), []);
    assert.deepEqual(parseCheckRun(run({ kind: "test", command: "npx jest", outcome: "cancelled", stderr: JEST })), []);
});

test("cap and dedupe: a flood of errors is cut to MAX_FINDINGS_PER_DETECTOR, repeats removed", () => {
    const lines: string[] = [];
    for (let i = 1; i <= MAX_FINDINGS_PER_DETECTOR + 50; i++) {
        lines.push(`src/f${i}.ts(1,1): error TS2304: Cannot find name 'x'.`);
    }
    lines.push(lines[0], lines[1]); // exact repeats
    const findings = parseCheckRun(run({ kind: "typecheck", command: "tsc", stdout: lines.join("\n") }));
    assert.equal(findings.length, MAX_FINDINGS_PER_DETECTOR);
    assert.equal(new Set(findings.map((f) => `${f.fingerprint}:${f.line}`)).size, findings.length);

    const dupes = parseCheckRun(run({ kind: "typecheck", command: "tsc", stdout: [lines[0], lines[0], lines[1]].join("\n") }));
    assert.equal(dupes.length, 2);
});

test("never throws on odd input", () => {
    const odd = run({ kind: "test", command: undefined as unknown as string, stdout: undefined as unknown as string, stderr: "\u001b[" });
    assert.doesNotThrow(() => parseCheckRun(odd));
    const findings = parseCheckRun(odd);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].title, "test failed (exit 1)");
});
