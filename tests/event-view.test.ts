// ui/event-view.ts: one-line rendering of journal events for `tyr watch`.
// Pure, so every case pins colour, Unicode, width and "now".

import { test } from "node:test";
import * as assert from "node:assert/strict";
import type { TyrEvent } from "../cli/core/events.js";
import {
    createEventFormatter,
    formatClock,
    formatDuration,
    formatEvent,
    formatUptime,
    parseSince,
    type EventViewOptions,
} from "../cli/ui/event-view.js";

const NOW = new Date(2026, 10, 10, 15, 0, 0);
/** A timestamp on NOW's local day, so no date prefix is added. */
const TS = new Date(2026, 10, 10, 14, 22, 33).toISOString();

const PLAIN: EventViewOptions = { color: false, unicode: true, verbose: false, now: NOW };

function event(partial: Partial<TyrEvent> & Pick<TyrEvent, "source" | "kind">): TyrEvent {
    return { v: 1, id: "id-1", ts: TS, ...partial };
}

function line(partial: Partial<TyrEvent> & Pick<TyrEvent, "source" | "kind">, options: Partial<EventViewOptions> = {}): string {
    return formatEvent(event(partial), { ...PLAIN, ...options });
}

/** The summary after "HH:MM:SS g source  ". */
function summary(partial: Partial<TyrEvent> & Pick<TyrEvent, "source" | "kind">, options: Partial<EventViewOptions> = {}): string {
    return line(partial, options).slice("14:22:33 g source  ".length);
}

const SESSION = "3f2a9c1d-aaaa-bbbb-cccc-1234567890ab";

test("layout: local time, source glyph, padded source, summary", () => {
    assert.equal(line({ source: "git", kind: "git.index", data: { staged: [] } }), "14:22:33 ⎇ git     index cleared: nothing staged");
    assert.equal(line({ source: "fs", kind: "fs.changed", data: { modified: ["a"], total: 1 } }).slice(0, 18), "14:22:33 ✎ fs     ");
    assert.equal(line({ source: "claude", kind: "claude.stop", data: {} }), "14:22:33 ◆ claude  finished responding");
    assert.equal(line({ source: "tyr", kind: "action.taken", message: "Ran lint" }), "14:22:33 ● tyr     Ran lint");
});

test("daemon lifecycle kinds", () => {
    assert.equal(
        summary({ source: "tyr", kind: "daemon.started", data: { pid: 42, gitWatch: "watch", fsWatch: "poll" } }),
        "daemon started (pid 42, git: watch, files: poll)",
    );
    assert.equal(summary({ source: "tyr", kind: "daemon.started", data: { pid: 42, gitWatch: null } }), "daemon started (pid 42, no git)");
    assert.equal(
        summary({ source: "tyr", kind: "daemon.stopped", message: "Background process stopped (SIGTERM)", data: { pid: 42 } }),
        "daemon stopped (pid 42, SIGTERM)",
    );
    assert.equal(
        summary({ source: "tyr", kind: "daemon.crashed", message: "Background process crashed: Error: boom\n    at x.js:1", data: { pid: 42 } }),
        "daemon crashed (pid 42): Error: boom",
    );
    assert.equal(summary({ source: "tyr", kind: "daemon.pong", data: { pid: 42 } }), "daemon answered a ping (pid 42)");
    assert.equal(summary({ source: "tyr", kind: "daemon.warning", message: "inotify limit hit" }), "daemon warning: inotify limit hit");
});

test("git kinds", () => {
    const head = (branchChanged: boolean, commitChanged: boolean) =>
        summary({
            source: "git",
            kind: "git.head",
            message: "fallback",
            data: {
                previous: { branch: "feat", commit: "9f8e7d6aaaaaa" },
                current: { branch: "main", commit: "1a2b3c4dddddd" },
                branchChanged,
                commitChanged,
            },
        });
    assert.equal(head(true, true), "switched to main at 1a2b3c4");
    assert.equal(head(false, true), "main moved 9f8e7d6 → 1a2b3c4");
    assert.equal(head(false, false), "fallback");
    assert.equal(summary({ source: "git", kind: "git.index", data: { staged: ["a", "b"] } }), "2 paths staged: a, b");
    assert.equal(
        summary({
            source: "git",
            kind: "git.refs",
            data: {
                changes: [
                    { ref: "refs/heads/feat", previous: null, current: "abcdef123" },
                    { ref: "refs/tags/v1", previous: "abcdef123", current: null },
                    { ref: "refs/remotes/origin/main", previous: "1111111aa", current: "2222222bb" },
                    { ref: "refs/heads/x", previous: null, current: "3" },
                ],
            },
        }),
        "feat created at abcdef1, tag v1 deleted, origin/main 1111111 → 2222222 (+1 more)",
    );
    assert.equal(summary({ source: "git", kind: "git.merge-state", data: { started: ["rebase"], finished: [] } }), "rebase in progress");
    assert.equal(summary({ source: "git", kind: "git.merge-state", data: { started: [], finished: ["merge"] } }), "merge finished");
});

test("fs.changed: path list, git cause, and a cause the view does not know", () => {
    assert.equal(
        summary({ source: "fs", kind: "fs.changed", data: { added: ["n.ts"], modified: ["a.ts", "b.ts"], removed: ["c.ts"], total: 4 } }),
        "4 files changed: n.ts, a.ts, b.ts, … (+1 more)",
    );
    assert.equal(summary({ source: "fs", kind: "fs.changed", data: { modified: ["a.ts"], total: 1 } }), "1 file changed: a.ts");
    assert.equal(
        summary({ source: "fs", kind: "fs.changed", data: { added: ["x"], total: 14, cause: "git", gitKind: "head" } }),
        "14 files changed by checkout",
    );
    assert.equal(summary({ source: "fs", kind: "fs.changed", data: { total: 3, cause: "git" } }), "3 files changed by git");
    assert.equal(summary({ source: "fs", kind: "fs.changed", data: { total: 3, cause: "git", gitKind: "stash" } }), "3 files changed by stash");
    // observe.ts records the full kind; it must read the same as the bare one.
    assert.equal(summary({ source: "fs", kind: "fs.changed", data: { total: 5, cause: "git", gitKind: "git.head" } }), "5 files changed by checkout");
    assert.equal(summary({ source: "fs", kind: "fs.changed", data: { total: 2, cause: "git", gitKind: "git.refs" } }), "2 files changed by stash");
});

test("claude kinds", () => {
    const data = { sessionId: SESSION };
    assert.equal(
        summary({ source: "claude", kind: "claude.session_start", data: { ...data, source: "startup", model: "opus" } }),
        "session 3f2a9c1d started (startup, opus)",
    );
    assert.equal(summary({ source: "claude", kind: "claude.session_end", data: { ...data, reason: "exit" } }), "session 3f2a9c1d ended (exit)");
    assert.equal(
        summary({ source: "claude", kind: "claude.prompt", data: { ...data, prompt: "fix the tests", promptLength: 200 } }),
        'prompt: "fix the tests…"',
    );
    assert.equal(
        summary({ source: "claude", kind: "claude.tool_use", data: { ...data, tool: "Edit", input: "src/a.ts", file: "src/a.ts" } }),
        "Edit src/a.ts",
    );
    assert.equal(summary({ source: "claude", kind: "claude.tool_use", data: { ...data, tool: "Bash", input: "npm test" } }), "Bash: npm test");
    assert.equal(
        summary({ source: "claude", kind: "claude.tool_use", data: { ...data, tool: "Grep", input: "TODO", agentType: "Explore" } }),
        "[Explore] Grep: TODO",
    );
    assert.equal(
        summary({ source: "claude", kind: "claude.tool_result", data: { ...data, tool: "Bash", input: "npm test", success: false, error: "Exit code 1" } }),
        "Bash: npm test  ✗ Exit code 1",
    );
    assert.equal(
        summary({ source: "claude", kind: "claude.tool_result", data: { ...data, tool: "Bash", input: "sleep", success: false, interrupted: true } }),
        "Bash: sleep  ✗ interrupted",
    );
    assert.equal(
        summary({ source: "claude", kind: "claude.tool_result", data: { ...data, tool: "Edit", input: "a.ts", file: "a.ts", success: true, durationMs: 1250 } }),
        "Edit a.ts  ✓ 1.3s",
    );
    assert.equal(summary({ source: "claude", kind: "claude.subagent_stop", data: { ...data, agentType: "Explore" } }), "subagent Explore finished");
    assert.equal(
        summary({ source: "claude", kind: "claude.notification", data: { ...data, message: "Claude needs your permission" } }),
        "notification: Claude needs your permission",
    );
    assert.equal(summary({ source: "claude", kind: "claude.compact", data: { ...data, trigger: "auto" } }), "compacting context (auto)");
    assert.equal(summary({ source: "claude", kind: "claude.hook", data: { ...data, hookEvent: "Elicitation" } }), "Elicitation hook");
});

test("init, checks, actions and unknown kinds", () => {
    assert.equal(
        summary({ source: "tyr", kind: "init.completed", message: "Initialized", data: { fileCount: 12, primaryLanguage: "TypeScript" } }),
        "Initialized (12 files, TypeScript)",
    );
    assert.equal(summary({ source: "check", kind: "check.failed", message: "lint failed" }), "lint failed  ✗");
    assert.equal(summary({ source: "check", kind: "check.passed", data: { name: "test" } }), "passed test  ✓");
    assert.equal(summary({ source: "user", kind: "action.taken", message: "Reverted src/a.ts" }), "Reverted src/a.ts");
    // Unknown kinds (and unknown sources) render from their message, or the kind itself.
    assert.equal(summary({ source: "user", kind: "brand.new", message: "line one\nline two" }), "line one");
    assert.equal(line({ source: "martian" as TyrEvent["source"], kind: "x.y" }), "14:22:33 · martian  x.y");
});

test("colour: off emits no escapes; on paints time, source and tone", () => {
    const plain = line({ source: "tyr", kind: "daemon.crashed", data: { pid: 1 } });
    assert.doesNotMatch(plain, /\x1b\[/);
    const colored = line({ source: "tyr", kind: "daemon.crashed", data: { pid: 1 } }, { color: true });
    assert.match(colored, /\x1b\[2m14:22:33\x1b\[0m/);
    assert.match(colored, /\x1b\[31mdaemon crashed \(pid 1\)\x1b\[0m/);
    // Read-only tool calls are dimmed, edits are not.
    assert.match(line({ source: "claude", kind: "claude.tool_use", data: { tool: "Read", input: "a" } }, { color: true }), /\x1b\[2mRead/);
    assert.doesNotMatch(line({ source: "claude", kind: "claude.tool_use", data: { tool: "Edit", input: "a", file: "a" } }, { color: true }), /\x1b\[2mEdit/);
    // The colourless text is identical once escapes are stripped.
    assert.equal(colored.replace(/\x1b\[\d+m/g, ""), plain);
});

test("ASCII fallback replaces every glyph", () => {
    const ascii = { unicode: false };
    assert.equal(line({ source: "git", kind: "git.index", data: { staged: [] } }, ascii).slice(9, 10), "^");
    assert.equal(line({ source: "claude", kind: "claude.stop" }, ascii).slice(9, 10), "@");
    assert.equal(line({ source: "fs", kind: "fs.changed", data: { total: 1, modified: ["a"] } }, ascii).slice(9, 10), "+");
    assert.equal(line({ source: "tyr", kind: "init.completed" }, ascii).slice(9, 10), "*");
    assert.equal(
        summary({ source: "claude", kind: "claude.tool_result", data: { tool: "Bash", input: "x", success: false } }, ascii),
        "Bash: x  x failed",
    );
    assert.equal(
        summary({ source: "git", kind: "git.head", data: { previous: { commit: "aaaaaaa1" }, current: { branch: "m", commit: "bbbbbbb2" }, commitChanged: true } }, ascii),
        "m moved aaaaaaa -> bbbbbbb",
    );
    const long = line({ source: "tyr", kind: "x", message: "y".repeat(200) }, { ...ascii, width: 40 });
    assert.ok(long.endsWith("..."));
    assert.doesNotMatch(long, /[^\x00-\x7f]/);
});

test("width truncates the summary but keeps the outcome", () => {
    const text = line(
        { source: "claude", kind: "claude.tool_result", data: { tool: "Bash", input: "x".repeat(200), success: true, durationMs: 5 } },
        { width: 60 },
    );
    assert.equal(Array.from(text).length, 60);
    assert.match(text, /…  ✓ 5ms$/);
});

test("verbose adds the kind, id and details on indented lines", () => {
    const text = line(
        { source: "fs", kind: "fs.changed", data: { added: ["n.ts"], modified: ["a.ts"], removed: [], total: 2 } },
        { verbose: true },
    );
    assert.deepEqual(text.split("\n"), [
        "14:22:33 ✎ fs      2 files changed: n.ts, a.ts",
        "           fs.changed  id-1",
        "           1 added, 1 modified",
        "           + n.ts",
        "           ~ a.ts",
    ]);
    assert.match(line({ source: "claude", kind: "claude.stop", data: { sessionId: SESSION } }, { verbose: true }), new RegExp(`session ${SESSION}`));
});

test("history from another day gets a date prefix", () => {
    const yesterday = new Date(2026, 10, 9, 23, 59, 59).toISOString();
    assert.equal(formatClock(yesterday, NOW), "11-09 23:59:59");
    assert.equal(formatClock(TS, NOW), "14:22:33");
});

test("createEventFormatter pairs tool_use and tool_result for a duration", () => {
    const format = createEventFormatter({ color: false, unicode: true, verbose: false, now: NOW });
    const start = new Date(2026, 10, 10, 14, 22, 30).toISOString();
    format(event({ source: "claude", kind: "claude.tool_use", ts: start, data: { tool: "Bash", input: "npm test", toolUseId: "t1" } }));
    const result = format(event({ source: "claude", kind: "claude.tool_result", data: { tool: "Bash", input: "npm test", toolUseId: "t1", success: true } }));
    assert.match(result, /Bash: npm test  ✓ 3\.0s$/);
    // Unpaired: no duration rather than a wrong one.
    const lone = format(event({ source: "claude", kind: "claude.tool_result", data: { tool: "Bash", input: "ls", toolUseId: "t9", success: true } }));
    assert.match(lone, /Bash: ls  ✓$/);
});

test("parseSince: relative ages, ISO dates, and garbage", () => {
    const now = new Date("2026-11-10T12:00:00Z");
    assert.equal(parseSince("10m", now)?.toISOString(), "2026-11-10T11:50:00.000Z");
    assert.equal(parseSince("2h", now)?.toISOString(), "2026-11-10T10:00:00.000Z");
    assert.equal(parseSince("1d", now)?.toISOString(), "2026-11-09T12:00:00.000Z");
    assert.equal(parseSince("1h30m", now)?.toISOString(), "2026-11-10T10:30:00.000Z");
    assert.equal(parseSince("45s", now)?.toISOString(), "2026-11-10T11:59:15.000Z");
    assert.equal(parseSince("2026-11-01T08:00:00Z", now)?.toISOString(), "2026-11-01T08:00:00.000Z");
    assert.equal(parseSince("5x", now), null);
    assert.equal(parseSince("10", now), null);
    assert.equal(parseSince("yesterday-ish", now), null);
});

test("duration and uptime formatting", () => {
    assert.equal(formatDuration(84), "84ms");
    assert.equal(formatDuration(1250), "1.3s");
    assert.equal(formatDuration(125_000), "2m 05s");
    assert.equal(formatUptime(30_000), "30s");
    assert.equal(formatUptime(12 * 60_000), "12m");
    assert.equal(formatUptime((2 * 60 + 13) * 60_000), "2h 13m");
    assert.equal(formatUptime((3 * 24 + 4) * 3_600_000), "3d 4h");
});
