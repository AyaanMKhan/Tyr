// PLANNING.md 2.16 / 2.17: the reporter's error stream, the live watch panel,
// typed errors and --debug.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { Command } from "commander";
import type { TyrEvent } from "../cli/core/events.js";
import {
    ConfigError,
    errorTypeOf,
    EXIT_CODES,
    formatFatal,
    GitUnavailableError,
    NotInitializedError,
    TyrError,
    UsageError,
} from "../cli/core/errors.js";
import { readFatalContext } from "../cli/core/fatal.js";
import { logLevelOf, readGlobals, registerGlobalOptions } from "../cli/core/globals.js";
import { emptyEngineState } from "../cli/engine/repo-state.js";
import type { EngineState } from "../cli/engine/model.js";
import { createReporter } from "../cli/ui/reporter.js";
import { applyPanelEvent, fitLine, initialPanelState, LivePanel, renderPanel, type PanelState } from "../cli/ui/watch-panel.js";

function fakeStream(isTTY = false): { stream: NodeJS.WriteStream; output: () => string } {
    const chunks: string[] = [];
    const stream = {
        isTTY,
        write(chunk: string): boolean {
            chunks.push(chunk);
            return true;
        },
    } as unknown as NodeJS.WriteStream;
    return { stream, output: () => chunks.join("") };
}

/* ---- reporter: warn/error on the error stream ---------------------------- */

test("reporter: warn and error go to the error stream, everything else to the main one", () => {
    const main = fakeStream();
    const errors = fakeStream();
    const reporter = createReporter({ stream: main.stream, errorStream: errors.stream, color: false, animate: false, unicode: true });
    reporter.info("hello");
    reporter.success("done");
    reporter.warn("careful");
    reporter.error("broken");
    const task = reporter.task("step");
    task.fail("step failed");
    assert.equal(main.output(), "hello\n✓ done\n✗ step failed\n");
    assert.equal(errors.output(), "! careful\n✗ broken\n");
});

test("reporter: a caller that moved or captures output keeps one stream", () => {
    const only = fakeStream();
    const reporter = createReporter({ stream: only.stream, color: false, animate: false, unicode: true });
    reporter.info("a");
    reporter.warn("b");
    assert.equal(only.output(), "a\n! b\n");
});

test("reporter: a warning under a live spinner erases the spinner row first and redraws it", () => {
    const main = fakeStream(true);
    const errors = fakeStream(true);
    const reporter = createReporter({ stream: main.stream, errorStream: errors.stream, color: false, animate: true, unicode: true });
    reporter.task("working");
    const before = main.output().length;
    reporter.warn("careful");
    const after = main.output().slice(before);
    assert.match(after, /\r\x1b\[K/, "spinner row cleared");
    assert.match(after, /working/, "spinner redrawn");
    assert.equal(errors.output(), "! careful\n");
    reporter.stop();
});

/* ---- typed errors -------------------------------------------------------- */

test("typed errors fix their exit codes and carry default hints", () => {
    const usage = new UsageError("bad flag");
    assert.ok(usage instanceof TyrError);
    assert.equal(usage.exitCode, EXIT_CODES.USAGE);

    const init = new NotInitializedError("/repo");
    assert.equal(init.exitCode, EXIT_CODES.NOT_INITIALIZED);
    assert.equal(init.message, "Tyr is not initialized in /repo.");
    assert.equal(init.hint, 'Run "tyr init" first.');
    assert.equal(init.root, "/repo");
    assert.equal(new NotInitializedError("/r", { hint: "custom", message: "m" }).hint, "custom");

    const config = new ConfigError("broken", { file: "/repo/.tyr/tyr.json" });
    assert.equal(config.exitCode, EXIT_CODES.CONFIG);
    assert.equal(config.file, "/repo/.tyr/tyr.json");

    const git = new GitUnavailableError();
    assert.equal(git.exitCode, EXIT_CODES.FAILURE);
    assert.match(git.hint!, /git/);

    assert.equal(errorTypeOf(init), "NotInitializedError");
    assert.equal(errorTypeOf(new TyrError("plain")), undefined);
    assert.equal(errorTypeOf(new Error("bug")), undefined);
});

test("formatFatal: --json reports the error type of a typed error", () => {
    const output = formatFatal(new NotInitializedError("/repo"), { json: true, verbose: false });
    const body = JSON.parse(output.stdout);
    assert.deepEqual(body.error, {
        message: "Tyr is not initialized in /repo.",
        code: "NOT_INITIALIZED",
        exitCode: 3,
        hint: 'Run "tyr init" first.',
        type: "NotInitializedError",
    });
    assert.equal(JSON.parse(formatFatal(new TyrError("plain"), { json: true, verbose: false }).stdout).error.type, undefined);
});

test("formatFatal: --debug adds the stack and cause chain of expected errors; without it they stay clean", () => {
    const error = new ConfigError("broken", { cause: new Error("root cause") });
    const plain = formatFatal(error, { json: false, verbose: true });
    assert.equal(plain.stderr, "error: broken\n");
    const debug = formatFatal(error, { json: false, verbose: true, debug: true });
    assert.match(debug.stderr, /^error: broken\n/);
    assert.match(debug.stderr, /ConfigError: broken\n\s+at /);
    assert.match(debug.stderr, /Caused by: Error: root cause/);
});

test("--debug: read from raw argv and TYR_DEBUG, implies verbose and the debug log level", async () => {
    assert.deepEqual(readFatalContext(["node", "tyr", "run", "--debug"], {}), { json: false, verbose: true, debug: true });
    assert.deepEqual(readFatalContext(["node", "tyr"], { TYR_DEBUG: "1" }), { json: false, verbose: true, debug: true });
    assert.equal(readFatalContext(["node", "tyr", "--", "--debug"], {}).debug, false);

    const program = new Command().exitOverride();
    registerGlobalOptions(program);
    let seen: ReturnType<typeof readGlobals> | null = null;
    program.command("x").action((_o, command: Command) => {
        seen = readGlobals(command, {});
    });
    await program.parseAsync(["node", "tyr", "--debug", "x"]);
    assert.equal(seen!.debug, true);
    assert.equal(logLevelOf(seen!), "debug");
    assert.equal(logLevelOf({ debug: true, logLevel: "warn" }), "warn", "--log-level still wins");
});

/* ---- watch panel: state -------------------------------------------------- */

const T0 = "2026-11-18T12:00:00.000Z";
const NOW = new Date("2026-11-18T12:00:30.000Z");

function ev(kind: string, data: Record<string, unknown> = {}, message?: string, ts = T0): TyrEvent {
    return { v: 1, id: kind, ts, source: kind.split(".")[0] as TyrEvent["source"], kind, message, data };
}

function engineWith(partial: Partial<EngineState>): EngineState {
    return { ...emptyEngineState(), ...partial };
}

function base(): PanelState {
    return initialPanelState({ daemon: { running: true, pid: 42, startedAt: "2026-11-18T11:00:00.000Z" }, engine: null, findings: null });
}

test("panel: initial state comes from engine.json and findings.json", () => {
    const last = (outcome: string) => ({ last: { outcome } as never, lastGood: null });
    const state = initialPanelState({
        daemon: { running: false, pid: null, startedAt: null },
        engine: engineWith({
            checks: { test: last("failed"), build: last("passed") },
            problems: [{ key: "check:test", kind: "test", title: "t", detail: "", firstSeenRunId: "r", lastSeenRunId: "r", firstSeenAt: T0, lastSeenAt: T0, regression: true }],
        }),
        findings: [{ severity: "error" }, { severity: "warning" }, { severity: "critical" }],
    });
    assert.deepEqual(state.checks, [
        { kind: "build", outcome: "passed" },
        { kind: "test", outcome: "failed" },
    ]);
    assert.deepEqual(state.problems, [{ kind: "test", regression: true }]);
    assert.deepEqual(state.findings, { total: 3, serious: 2 });
});

test("panel: a check runs, fails as a regression, then recovers", () => {
    let state = applyPanelEvent(base(), ev("check.passed", { run: { kind: "test", outcome: "passed" } }));
    state = applyPanelEvent(state, ev("check.started", { kind: "test" }));
    assert.deepEqual(state.running, { kind: "test", startedAt: T0 });
    state = applyPanelEvent(state, ev("check.failed", { run: { kind: "test", outcome: "failed" } }));
    assert.equal(state.running, null);
    assert.deepEqual(state.problems, [{ kind: "test", regression: true }]);
    state = applyPanelEvent(state, ev("check.passed", { run: { kind: "test", outcome: "passed" } }));
    assert.deepEqual(state.problems, []);
    assert.deepEqual(state.checks, [{ kind: "test", outcome: "passed" }]);
});

test("panel: a cancelled run changes no result", () => {
    let state = applyPanelEvent(base(), ev("check.started", { kind: "lint" }));
    state = applyPanelEvent(state, ev("check.failed", { run: { kind: "lint", outcome: "cancelled" } }));
    assert.deepEqual(state.checks, []);
    assert.deepEqual(state.problems, []);
    assert.equal(state.running, null);
});

test("panel: daemon lifecycle, Claude activity, review and notification", () => {
    let state = applyPanelEvent(base(), ev("daemon.crashed", { pid: 42 }));
    assert.equal(state.daemon.crashed, true);
    state = applyPanelEvent(state, ev("daemon.started", { pid: 7 }));
    assert.deepEqual(state.daemon, { running: true, pid: 7, startedAt: T0, crashed: false });
    state = applyPanelEvent(state, ev("claude.prompt"));
    state = applyPanelEvent(state, ev("claude.tool_use", { tool: "Edit" }, "Edit cli/x.ts"));
    assert.deepEqual(state.claude, { busy: true, tool: "Edit cli/x.ts", at: T0 });
    state = applyPanelEvent(state, ev("claude.stop"));
    assert.equal(state.claude!.busy, false);
    state = applyPanelEvent(state, ev("review.completed", { total: 4, counts: { error: 1, critical: 1, warning: 2 } }));
    assert.deepEqual(state.findings, { total: 4, serious: 2 });
    state = applyPanelEvent(state, { ...ev("notification", { title: "Tyr: test regressed", severity: "error" }), source: "tyr" });
    assert.deepEqual(state.alert, { title: "Tyr: test regressed", severity: "error", at: T0 });
    assert.equal(applyPanelEvent(state, ev("git.head")), state, "unrelated events change nothing");
});

/* ---- watch panel: rendering ---------------------------------------------- */

test("panel: renders four lines with times relative to now", () => {
    let state = base();
    state = applyPanelEvent(state, ev("check.passed", { run: { kind: "build", outcome: "passed" } }));
    state = applyPanelEvent(state, ev("check.started", { kind: "test" }, undefined, "2026-11-18T12:00:27.000Z"));
    state = applyPanelEvent(state, ev("claude.tool_use", {}, "Bash: npm test", "2026-11-18T12:00:26.000Z"));
    const lines = renderPanel(state, { now: NOW, color: false, unicode: true });
    assert.equal(lines.length, 4);
    assert.match(lines[0]!, /^── live ─+$/);
    assert.equal(lines[1], "daemon   ● running, pid 42, up 1h 0m · claude ● working: Bash: npm test (4.0s)");
    assert.equal(lines[2], "checks   build ✓ · running test 3.0s");
    assert.equal(lines[3], "problems none");
});

test("panel: stopped daemon, problems, findings and alert; ASCII glyphs", () => {
    const state: PanelState = {
        ...base(),
        daemon: { running: false, pid: null, startedAt: null, crashed: false },
        checks: [{ kind: "test", outcome: "failed" }],
        problems: [{ kind: "test", regression: false }],
        findings: { total: 3, serious: 1 },
        alert: { title: "Tyr: test failing", severity: "warning", at: "2026-11-18T11:58:30.000Z" },
    };
    const lines = renderPanel(state, { now: NOW, color: false, unicode: false });
    assert.equal(lines[1], "daemon   o not running (tyr start)");
    assert.equal(lines[2], "checks   test X");
    assert.equal(lines[3], "problems 1: test failing | findings 3 (1 serious) | alert: Tyr: test failing (2m 00s ago)");
});

test("panel: lines are cut to the terminal width, colour codes kept intact", () => {
    const state: PanelState = { ...base(), problems: [{ kind: "test", regression: true }, { kind: "lint", regression: false }] };
    for (const color of [false, true]) {
        const lines = renderPanel(state, { now: NOW, color, unicode: true, width: 30 });
        for (const line of lines) {
             
            assert.ok(Array.from(line.replace(/\x1b\[[0-9;]*m/g, "")).length <= 29, `fits: ${JSON.stringify(line)}`);
        }
    }
    assert.equal(fitLine("abcdef", 4, true), "abc…");
    assert.equal(fitLine("abc", 4, true), "abc");
    assert.equal(fitLine("\x1b[31mabcdef\x1b[0m", 4, false), "\x1b[31ma\x1b[0m...\x1b[0m");
});

/* ---- watch panel: drawing ------------------------------------------------ */

test("LivePanel: prints above the panel, redraws it, and removes it on close", () => {
    const { stream, output } = fakeStream(true);
    let n = 0;
    const panel = new LivePanel({ out: stream, render: () => [`panel ${n}`, "second"], intervalMs: 0 });
    panel.start();
    assert.equal(output(), "panel 0\nsecond\n");
    n = 1;
    panel.print("event A\n");
    assert.equal(output(), "panel 0\nsecond\n" + "\x1b[2A\r\x1b[J" + "event A\n" + "panel 1\nsecond\n");
    panel.refresh();
    assert.ok(output().endsWith("\x1b[2A\r\x1b[Jpanel 1\nsecond\n"));
    panel.close();
    assert.ok(output().endsWith("\x1b[2A\r\x1b[J"));
    const length = output().length;
    panel.print("after\n");
    panel.refresh();
    assert.equal(output().slice(length), "after\n", "closed: plain writes, no panel");
});

test("LivePanel: a throwing renderer draws nothing instead of crashing", () => {
    const { stream, output } = fakeStream(true);
    const panel = new LivePanel({
        out: stream,
        render: () => {
            throw new Error("bad state");
        },
        intervalMs: 0,
    });
    panel.start();
    panel.print("line\n");
    assert.equal(output(), "line\n");
});
