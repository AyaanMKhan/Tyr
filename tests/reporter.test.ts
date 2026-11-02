import { test } from "node:test";
import * as assert from "node:assert/strict";
import { createReporter, ReporterOptions } from "../cli/ui/reporter.js";

/**
 * A write-only stand-in for stdout/stderr that records everything written.
 * Only `write` and `isTTY` are touched by the reporter, so the cast is safe.
 */
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

function reporterWith(options: ReporterOptions = {}): { reporter: ReturnType<typeof createReporter>; output: () => string } {
    const { stream, output } = fakeStream(options.animate === true);
    // Colour and glyphs are pinned so assertions do not depend on the host terminal.
    const reporter = createReporter({ color: false, animate: false, unicode: true, ...options, stream });
    return { reporter, output };
}

/** Mirror of runInit's catch block, the path this feature exists for. */
function failLikeInit(reporter: ReturnType<typeof createReporter>): void {
    reporter.failActive();
    reporter.stop();
    reporter.blank();
    reporter.error("Initialization failed: boom");
}

test("failActive marks the in-flight task as failed with its own label", () => {
    const { reporter, output } = reporterWith();
    reporter.task("Scanning project files...");
    failLikeInit(reporter);

    const text = output();
    assert.match(text, /✗ Scanning project files\.\.\.\n/);
    assert.match(text, /✗ Initialization failed: boom\n/);
    // The task line must come before the error so the step reads as the cause.
    assert.ok(text.indexOf("Scanning project files") < text.indexOf("Initialization failed"));
});

test("failActive uses the latest label after update()", () => {
    const { reporter, output } = reporterWith();
    const task = reporter.task("Detecting git...");
    task.update("Reading git history...");
    reporter.failActive();
    reporter.stop();

    assert.match(output(), /✗ Reading git history\.\.\.\n/);
    assert.doesNotMatch(output(), /Detecting git/);
});

test("failActive accepts an override message", () => {
    const { reporter, output } = reporterWith();
    reporter.task("Writing .tyr/...");
    reporter.failActive("Writing .tyr/ (permission denied)");
    reporter.stop();

    assert.equal(output(), "✗ Writing .tyr/ (permission denied)\n");
});

test("failActive is a no-op when no task is in flight", () => {
    const { reporter, output } = reporterWith();
    reporter.task("Scanning project files...").succeed();
    reporter.failActive();
    reporter.stop();

    assert.equal(output(), "✓ Scanning project files...\n");
});

test("a failed task is not resolved twice by a later handle call", () => {
    const { reporter, output } = reporterWith();
    const task = reporter.task("Profiling project...");
    reporter.failActive();
    task.succeed();
    task.fail();

    assert.equal(output(), "✗ Profiling project...\n");
});

test("quiet mode still shows the failed task and the error", () => {
    const { reporter, output } = reporterWith({ verbosity: "quiet" });
    reporter.header("Initializing Tyr...");
    reporter.task("Scanning project files...");
    failLikeInit(reporter);

    assert.equal(output(), "✗ Scanning project files...\n✗ Initialization failed: boom\n");
});

test("ASCII fallback uses the plain failure glyph", () => {
    const { reporter, output } = reporterWith({ unicode: false });
    reporter.task("Scanning project files...");
    failLikeInit(reporter);

    assert.match(output(), /^x Scanning project files\.\.\.\n/);
    assert.doesNotMatch(output(), /✗/);
});

test("colour mode paints the failure glyph red", () => {
    const { reporter, output } = reporterWith({ color: true });
    reporter.task("Scanning project files...");
    reporter.failActive();
    reporter.stop();

    assert.equal(output(), "\x1b[31m✗\x1b[0m Scanning project files...\n");
});

test("animated mode replaces the spinner with the failure line and restores the cursor", () => {
    const { reporter, output } = reporterWith({ animate: true });
    reporter.task("Scanning project files...");
    failLikeInit(reporter);

    const text = output();
    // The spinner row is erased before the final line is written over it.
    assert.match(text, /\r\x1b\[K(\x1b\[\?25h)?✗ Scanning project files\.\.\.\n/);
    assert.ok(text.endsWith("✗ Initialization failed: boom\n"));
    // Cursor hidden for the spinner must be shown again.
    assert.ok(text.lastIndexOf("\x1b[?25h") > text.lastIndexOf("\x1b[?25l"));
});
