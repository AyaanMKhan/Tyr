// Notifications (PLANNING.md 2.15): target parsing, delivery, the daemon's
// dedupe/rate limit, desktop commands per platform, the per-pass alert and
// how `tyr watch` renders a notification. No real toast is ever shown: the
// desktop sender and journal are fakes.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import type { TyrEvent, TyrEventInput } from "../cli/core/events.js";
import { desktopCommand, showDesktopNotification, WINDOWS_TOAST_APP_ID, type SpawnSpec } from "../cli/integrations/desktop.js";
import { createNotifier, deliverNotification, parseTargets, type TyrNotification } from "../cli/integrations/notify.js";
import { passNotification } from "../cli/engine/alerts.js";
import type { EngineFinding } from "../cli/engine/findings.js";
import type { EngineState, Problem } from "../cli/engine/model.js";
import { emptyEngineState } from "../cli/engine/repo-state.js";
import type { ReviewPassResult } from "../cli/engine/review.js";
import { formatEvent, wantsBell } from "../cli/ui/event-view.js";

function fakeJournal() {
    const events: TyrEventInput[] = [];
    const journal = async (_root: string, input: TyrEventInput): Promise<TyrEvent> => {
        events.push(input);
        return {
            v: 1,
            id: `e${events.length}`,
            ts: new Date(0).toISOString(),
            source: input.source,
            kind: input.kind,
            message: input.message,
            data: input.data,
        };
    };
    return { events, journal };
}

const NOTE: TyrNotification = { title: "Tyr: test regressed", message: "test regressed: 2 failing", severity: "error", key: "k1" };

/* parseTargets */

test("parseTargets keeps known targets once, case-insensitively, and lists the rest", () => {
    assert.deepEqual(parseTargets(["Desktop", "terminal", "desktop", " ", "slack", "webhook:https://x"]), {
        targets: ["desktop", "terminal"],
        unsupported: ["slack", "webhook:https://x"],
    });
    assert.deepEqual(parseTargets([]), { targets: [], unsupported: [] });
});

/* deliverNotification */

test("deliver: desktop and terminal both succeed; the event records targets and delivery", async () => {
    const { events, journal } = fakeJournal();
    const shown: { title: string; urgency?: string }[] = [];
    const result = await deliverNotification("/r", NOTE, ["terminal", "desktop"], {
        journal,
        desktop: async (note) => {
            shown.push(note);
            return { ok: true };
        },
    });
    assert.equal(result.sent, true);
    assert.deepEqual(result.results, [
        { target: "desktop", ok: true },
        { target: "terminal", ok: true },
    ]);
    assert.equal(shown.length, 1);
    assert.equal(shown[0]!.urgency, "critical", "an error is urgent");
    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, "notification");
    assert.deepEqual(events[0]!.data!.targets, ["terminal", "desktop"]);
    assert.deepEqual(events[0]!.data!.delivered, ["desktop", "terminal"]);
});

test("deliver: a failing desktop and unsupported targets are reported, still journaled", async () => {
    const { events, journal } = fakeJournal();
    const result = await deliverNotification("/r", { ...NOTE, severity: "info" }, ["desktop", "slack"], {
        journal,
        desktop: async () => ({ ok: false, reason: "notify-send not found" }),
    });
    assert.deepEqual(result.results, [
        { target: "desktop", ok: false, reason: "notify-send not found" },
        { target: "slack", ok: false, reason: "not supported yet (terminal and desktop are)" },
    ]);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]!.data!.targets, ["desktop"]);
    assert.equal(wantsBell(result.event!), false, "no terminal target, no bell");
});

test("deliver: a desktop sender that throws becomes a failed result", async () => {
    const { journal } = fakeJournal();
    const result = await deliverNotification("/r", NOTE, ["desktop"], {
        journal,
        desktop: async () => {
            throw new Error("boom");
        },
    });
    assert.deepEqual(result.results, [{ target: "desktop", ok: false, reason: "boom" }]);
});

test("deliver: terminal fails when the journal cannot be written", async () => {
    const result = await deliverNotification("/r", NOTE, ["terminal"], { journal: async () => null });
    assert.deepEqual(result.results, [{ target: "terminal", ok: false, reason: "could not write the event journal" }]);
});

/* createNotifier */

test("notifier: the same key is dropped within the cooldown and sent again after it", async () => {
    const { events, journal } = fakeJournal();
    let now = 0;
    const notifier = createNotifier("/r", { targets: async () => ["terminal"], journal, now: () => now, cooldownMs: 1000 });
    assert.equal((await notifier.notify(NOTE)).sent, true);
    assert.equal((await notifier.notify(NOTE)).dropped, "duplicate");
    assert.equal((await notifier.notify({ ...NOTE, key: "k2" })).sent, true, "other news still goes out");
    now = 1000;
    assert.equal((await notifier.notify(NOTE)).sent, true);
    assert.equal(events.length, 3);
});

test("notifier: at most maxPerWindow per window", async () => {
    const { journal } = fakeJournal();
    let now = 0;
    const notifier = createNotifier("/r", { targets: async () => ["terminal"], journal, now: () => now, maxPerWindow: 2, windowMs: 100 });
    assert.equal((await notifier.notify({ ...NOTE, key: "a" })).sent, true);
    assert.equal((await notifier.notify({ ...NOTE, key: "b" })).sent, true);
    assert.equal((await notifier.notify({ ...NOTE, key: "c" })).dropped, "rate-limited");
    now = 100;
    assert.equal((await notifier.notify({ ...NOTE, key: "c" })).sent, true);
});

test("notifier: empty or unreadable targets send nothing", async () => {
    const { events, journal } = fakeJournal();
    const empty = createNotifier("/r", { targets: async () => [], journal });
    assert.equal((await empty.notify(NOTE)).dropped, "no-targets");
    const broken = createNotifier("/r", {
        targets: async () => {
            throw new Error("bad settings");
        },
        journal,
    });
    assert.equal((await broken.notify(NOTE)).dropped, "no-targets");
    assert.equal(events.length, 0);
});

test("notifier: a broken target is reported once until it works again", async () => {
    const { journal } = fakeJournal();
    const failures: string[] = [];
    let works = false;
    const notifier = createNotifier("/r", {
        targets: async () => ["desktop"],
        journal,
        desktop: async () => (works ? { ok: true } : { ok: false, reason: "no display" }),
        onFailure: (failure) => failures.push(failure.reason),
    });
    await notifier.notify({ ...NOTE, key: "1" });
    await notifier.notify({ ...NOTE, key: "2" });
    assert.deepEqual(failures, ["no display"]);
    works = true;
    await notifier.notify({ ...NOTE, key: "3" });
    works = false;
    await notifier.notify({ ...NOTE, key: "4" });
    assert.deepEqual(failures, ["no display", "no display"]);
});

/* desktop commands */

test("desktopCommand: Windows passes text in env vars, never in the script", () => {
    const spec = desktopCommand({ title: "a<b>'$(x)", message: "line1\nline2\u0007", urgency: "critical" }, "win32")!;
    assert.equal(spec.command, "powershell.exe");
    const script = Buffer.from(spec.args[spec.args.indexOf("-EncodedCommand") + 1]!, "base64").toString("utf16le");
    assert.ok(script.includes("SecurityElement]::Escape($env:TYR_NOTIFY_TITLE)"));
    assert.ok(!script.includes("$(x)"), "the title is not in the script");
    assert.deepEqual(spec.env, {
        TYR_NOTIFY_TITLE: "a<b>'$(x)",
        TYR_NOTIFY_MESSAGE: "line1 line2",
        TYR_NOTIFY_URGENT: "1",
        TYR_NOTIFY_APP_ID: WINDOWS_TOAST_APP_ID,
    });
});

test("desktopCommand: macOS uses argv, Linux uses notify-send after --", () => {
    const mac = desktopCommand({ title: 'say "hi"', message: "m" }, "darwin")!;
    assert.equal(mac.command, "osascript");
    assert.deepEqual(mac.args.slice(-2), ['say "hi"', "m"]);
    assert.ok(mac.args.includes("display notification (item 2 of argv) with title (item 1 of argv)"));
    const linux = desktopCommand({ title: "-t", message: "--help" }, "linux")!;
    assert.deepEqual(linux, { command: "notify-send", args: ["--app-name=Tyr", "--urgency=normal", "--", "-t", "--help"] });
    assert.equal(desktopCommand({ title: "t", message: "m" }, "cygwin"), null);
});

test("desktopCommand: long text is clipped", () => {
    const spec = desktopCommand({ title: "t".repeat(500), message: "m".repeat(2000) }, "linux")!;
    assert.equal(Array.from(spec.args[3]!).length, 120);
    assert.equal(Array.from(spec.args[4]!).length, 400);
});

test("showDesktopNotification maps spawn outcomes to results", async () => {
    const run = (outcome: Awaited<ReturnType<NonNullable<Parameters<typeof showDesktopNotification>[1]>["spawner"] & {}>>) =>
        showDesktopNotification({ title: "t", message: "m" }, { platform: "linux", spawner: async () => outcome });
    assert.deepEqual(await run({ code: 0, stderr: "" }), { ok: true });
    assert.deepEqual(await run({ code: null, stderr: "", error: "notify-send not found" }), {
        ok: false,
        reason: "notify-send not found (install libnotify / notify-send)",
    });
    assert.deepEqual(await run({ code: null, stderr: "", timedOut: true }), { ok: false, reason: "notify-send timed out" });
    assert.deepEqual(await run({ code: 1, stderr: "  no\n bus " }), { ok: false, reason: "notify-send exited with 1: no bus" });
    const seen: SpawnSpec[] = [];
    await showDesktopNotification({ title: "t", message: "m" }, { platform: "darwin", spawner: async (spec) => (seen.push(spec), { code: 0, stderr: "" }) });
    assert.equal(seen[0]!.command, "osascript");
    assert.deepEqual(await showDesktopNotification({ title: "t", message: "m" }, { platform: "cygwin" }), {
        ok: false,
        reason: "desktop notifications are not supported on cygwin",
    });
});

/* passNotification */

function problem(kind: Problem["kind"], regression: boolean, runId = "r1"): Problem {
    return {
        key: `check:${kind}`,
        kind,
        title: `${kind} failed`,
        detail: "",
        firstSeenRunId: runId,
        lastSeenRunId: runId,
        firstSeenAt: "t",
        lastSeenAt: "t",
        regression,
    };
}

function state(problems: Problem[]): EngineState {
    return { ...emptyEngineState(), problems };
}

function review(added: Partial<EngineFinding>[]): ReviewPassResult {
    const findings = added.map((f, i) => ({ source: "diff", severity: "error", title: `f${i}`, fingerprint: `fp${i}`, ...f }) as EngineFinding);
    return { findings, all: findings, added: findings, resolved: [], regressions: [], report: null, notes: [] };
}

test("alerts: nothing changed, nothing to say", () => {
    assert.equal(passNotification({ before: state([problem("test", true)]), after: state([problem("test", true)]), review: review([]) }), null);
});

test("alerts: a regression is an error naming the check", () => {
    const note = passNotification({ before: state([]), after: state([problem("test", true)]), review: null })!;
    assert.equal(note.severity, "error");
    assert.equal(note.title, "Tyr: test regressed");
    assert.equal(note.message, "test regressed: test failed");
    assert.equal(note.key, "open:check:test:r1");
});

test("alerts: a pre-existing failure is a warning; recovery alone is info", () => {
    assert.equal(passNotification({ before: state([]), after: state([problem("lint", false)]), review: null })!.severity, "warning");
    const fixed = passNotification({ before: state([problem("build", true), problem("test", false)]), after: state([]), review: null })!;
    assert.equal(fixed.severity, "info");
    assert.equal(fixed.title, "Tyr: build and test passing again");
});

test("alerts: a re-opened problem (new first run) counts as new", () => {
    const note = passNotification({ before: state([problem("test", true, "r1")]), after: state([problem("test", true, "r9")]), review: null })!;
    assert.equal(note.key, "open:check:test:r9");
});

test("alerts: serious new diff findings alert; check findings and warnings do not", () => {
    assert.equal(passNotification({ before: state([]), after: state([]), review: review([{ source: "check" }, { severity: "warning" }]) }), null);
    const note = passNotification({ before: state([]), after: state([]), review: review([{ severity: "critical", title: "secret", file: "a.ts", line: 3 }]) })!;
    assert.equal(note.severity, "error");
    assert.equal(note.title, "Tyr: 1 new problem in your changes");
    assert.equal(note.message, "critical: secret (a.ts:3)");
});

test("alerts: long news is cut to three lines plus a count", () => {
    const note = passNotification({
        before: state([]),
        after: state([problem("build", true), problem("test", true), problem("lint", false), problem("typecheck", false)]),
        review: null,
    })!;
    const lines = note.message.split("\n");
    assert.equal(lines.length, 4);
    assert.equal(lines[3], "+1 more (tyr status)");
});

/* tyr watch rendering */

test("event-view renders a notification by severity and bells only for the terminal target", () => {
    const event: TyrEvent = {
        v: 1,
        id: "n1",
        ts: new Date().toISOString(),
        source: "tyr",
        kind: "notification",
        message: "Tyr: test regressed: test regressed: x",
        data: {
            title: "Tyr: test regressed",
            body: "test regressed: x",
            severity: "error",
            targets: ["terminal"],
            delivered: ["terminal"],
            failed: [{ target: "desktop", reason: "no display" }],
        },
    };
    const line = formatEvent(event, { color: false, unicode: true, verbose: true });
    assert.match(line, /Tyr: test regressed - test regressed: x/);
    assert.match(line, /sent to terminal/);
    assert.match(line, /not sent to desktop: no display/);
    assert.equal(wantsBell(event), true);
    assert.equal(wantsBell({ ...event, data: { ...event.data, targets: ["desktop"] } }), false);
    assert.equal(wantsBell({ ...event, kind: "check.failed" }), false);
});
