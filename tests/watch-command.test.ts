// `tyr watch` (cli/commands/watch.ts). runWatch() is driven directly against a
// temp project with captured streams and an AbortSignal; one test spawns the
// compiled CLI to check the real wiring (--json NDJSON, exit code).

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appendEvent, type TyrEvent, type TyrEventInput } from "../cli/core/events.js";
import { EXIT_CODES, TyrError } from "../cli/core/errors.js";
import { parseSources, runWatch, type WatchContext, type WatchOptions } from "../cli/commands/watch.js";
import type { DaemonStatus } from "../cli/core/daemon.js";
import { makeProject, removeProject } from "./helpers.js";

const CLI = fileURLToPath(new URL("../cli/index.js", import.meta.url));
const STOPPED: DaemonStatus = { running: false, pid: null, startedAt: null, stale: false };

function capture(): { stream: { write(chunk: string): boolean }; text: () => string } {
    const chunks: string[] = [];
    return { stream: { write: (chunk: string) => (chunks.push(chunk), true) }, text: () => chunks.join("") };
}

async function withProject(fn: (root: string) => Promise<void>, initialized = true): Promise<void> {
    const files: Record<string, string> = { "package.json": "{}\n" };
    if (initialized) files[".tyr/tyr.json"] = "{}\n";
    const root = await makeProject(files);
    try {
        await fn(root);
    } finally {
        await removeProject(root);
    }
}

/** Append `count` numbered action.taken events, a millisecond apart, ending a minute ago. */
async function seed(root: string, count: number, extra: Partial<TyrEventInput> = {}): Promise<void> {
    const base = Date.now() - 60_000 - count;
    for (let i = 1; i <= count; i++) {
        await appendEvent(root, { source: "tyr", kind: "action.taken", message: `event ${i}`, ts: new Date(base + i), ...extra });
    }
}

interface Run {
    stdout: () => string;
    stderr: () => string;
    lines: () => string[];
    done: Promise<void>;
    abort: () => Promise<void>;
}

/** Start runWatch with test-friendly defaults; `abort()` stops a follow and waits for it. */
function start(root: string, options: Partial<WatchOptions> = {}, context: Partial<WatchContext> = {}): Run {
    const out = capture();
    const err = capture();
    const controller = new AbortController();
    const done = runWatch(
        { lines: 20, follow: false, color: false, unicode: true, ping: false, ...options },
        {
            root,
            stdout: out.stream,
            stderr: err.stream,
            signal: controller.signal,
            pollIntervalMs: 20,
            forcePolling: true,
            persistent: false,
            daemonStatus: async () => STOPPED,
            ...context,
        },
    );
    return {
        stdout: out.text,
        stderr: err.text,
        lines: () => out.text().split("\n").filter((line) => line !== ""),
        done,
        abort: async () => {
            controller.abort();
            await done;
        },
    };
}

async function waitFor(predicate: () => boolean, ms = 5000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error("timed out waiting");
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

test("not initialized: a NOT_INITIALIZED TyrError with a hint", async () => {
    await withProject(async (root) => {
        await assert.rejects(start(root).done, (error: unknown) => {
            assert.ok(error instanceof TyrError);
            assert.equal(error.exitCode, EXIT_CODES.NOT_INITIALIZED);
            assert.match(error.hint ?? "", /tyr init/);
            return true;
        });
    }, false);
});

test("--no-follow replays the last N events and returns", async () => {
    await withProject(async (root) => {
        await seed(root, 30);
        const run = start(root, { lines: 5 });
        await run.done;
        const lines = run.lines();
        assert.equal(lines.length, 5);
        assert.match(lines[0], /tyr {5}event 26$/);
        assert.match(lines[4], /event 30$/);

        const none = start(root, { lines: 0 });
        await none.done;
        assert.deepEqual(none.lines(), ["- No matching events."]);
    });
});

test("--since replays everything since then unless --lines is explicit", async () => {
    await withProject(async (root) => {
        await appendEvent(root, { source: "tyr", kind: "action.taken", message: "old", ts: new Date(Date.now() - 3 * 3_600_000) });
        await seed(root, 25);
        const since = new Date(Date.now() - 3_600_000);
        const all = start(root, { since });
        await all.done;
        assert.equal(all.lines().length, 25);
        assert.doesNotMatch(all.stdout(), /old/);

        const capped = start(root, { since, lines: 3, linesExplicit: true });
        await capped.done;
        assert.equal(capped.lines().length, 3);
    });
});

test("filters: --source, --kind and --session; pongs hidden unless verbose", async () => {
    await withProject(async (root) => {
        await appendEvent(root, { source: "git", kind: "git.index", data: { staged: [] } });
        await appendEvent(root, { source: "fs", kind: "fs.changed", data: { modified: ["a.ts"], total: 1 } });
        await appendEvent(root, { source: "claude", kind: "claude.stop", data: { sessionId: "aaaa1111-x" } });
        await appendEvent(root, { source: "claude", kind: "claude.stop", data: { sessionId: "bbbb2222-y" } });
        await appendEvent(root, { source: "tyr", kind: "daemon.pong", data: { pid: 1 } });
        await appendEvent(root, { source: "tyr", kind: "daemon.started", data: { pid: 1 } });

        const sources = start(root, { sources: ["git", "fs"] });
        await sources.done;
        assert.equal(sources.lines().length, 2);

        const kinds = start(root, { kinds: ["daemon"] });
        await kinds.done;
        // An explicit --kind that matches pongs shows them.
        assert.equal(kinds.lines().length, 2);

        const session = start(root, { sessions: ["bbbb"] });
        await session.done;
        assert.equal(session.lines().length, 1);

        const everything = start(root);
        await everything.done;
        assert.equal(everything.lines().length, 5);
        assert.doesNotMatch(everything.stdout(), /ping/);

        const verbose = start(root, { verbose: true, lines: 1 });
        await verbose.done;
        assert.match(verbose.stdout(), /daemon\.started/);
    });
});

test("--session counts only matching events toward --lines", async () => {
    await withProject(async (root) => {
        await appendEvent(root, { source: "claude", kind: "claude.stop", data: { sessionId: "wanted-1" } });
        await appendEvent(root, { source: "claude", kind: "claude.stop", data: { sessionId: "wanted-1" } });
        await seed(root, 10);
        const run = start(root, { sessions: ["wanted"], lines: 2 });
        await run.done;
        assert.equal(run.lines().length, 2);
    });
});

test("--json writes one raw event per line and nothing else to stdout", async () => {
    await withProject(async (root) => {
        await seed(root, 3);
        const run = start(root, { json: true, follow: true, color: true }, { daemonStatus: async () => STOPPED });
        await waitFor(() => run.lines().length === 3);
        await appendEvent(root, { source: "git", kind: "git.index", data: { staged: ["a"] } });
        await waitFor(() => run.lines().length === 4);
        await run.abort();
        const events = run.lines().map((line) => JSON.parse(line) as TyrEvent);
        assert.deepEqual(
            events.map((event) => event.kind),
            ["action.taken", "action.taken", "action.taken", "git.index"],
        );
        assert.deepEqual(events[3].data, { staged: ["a"] });
        assert.doesNotMatch(run.stdout(), /\x1b\[/);
        // The daemon warning still reaches a person, on stderr.
        assert.match(run.stderr(), /Background process is not running/);
    });
});

test("following: header, history, live separator, then live events with lifecycle hints", async () => {
    await withProject(async (root) => {
        await seed(root, 2);
        const run = start(root, { follow: true });
        await waitFor(() => /following live/.test(run.stdout()));
        await appendEvent(root, { source: "claude", kind: "claude.tool_use", data: { tool: "Bash", input: "npm test", toolUseId: "t1" } });
        await appendEvent(root, { source: "tyr", kind: "daemon.crashed", message: "Background process crashed: boom", data: { pid: 7 } });
        await waitFor(() => /restart it with "tyr start"/.test(run.stdout()));
        await run.abort();

        const text = run.stdout();
        assert.match(text, /^Watching /);
        assert.match(text, /! Background process is not running/);
        assert.match(text, /tyr start/);
        const order = ["event 1", "event 2", "following live", "Bash: npm test", "daemon crashed (pid 7): boom"].map((needle) => text.indexOf(needle));
        assert.ok(order.every((index) => index >= 0), text);
        assert.deepEqual([...order].sort((a, b) => a - b), order);
    });
});

test("following with a running daemon shows pid, uptime and ping; --quiet drops the decoration", async () => {
    await withProject(async (root) => {
        const running: DaemonStatus = { running: true, pid: 4242, startedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), stale: false };
        const run = start(root, { follow: true, ping: true }, { daemonStatus: async () => running, ping: async () => 12.4 });
        await waitFor(() => /following live/.test(run.stdout()));
        await run.abort();
        assert.match(run.stdout(), /✓ Background process running \(pid 4242, up 2h 0m, ping 12ms\)/);

        await seed(root, 1);
        const quiet = start(root, { follow: true, quiet: true }, { daemonStatus: async () => running });
        await waitFor(() => quiet.lines().length === 1);
        await quiet.abort();
        assert.deepEqual(quiet.lines().length, 1);
        assert.match(quiet.stdout(), /event 1/);
    });
});

test("parseSources rejects unknown sources", () => {
    assert.deepEqual(parseSources("git, claude"), ["git", "claude"]);
    assert.throws(() => parseSources("git,mars"), /unknown source "mars"/);
});

test("the CLI: watch --no-follow --json prints NDJSON and exits 0; uninitialized exits 3", async () => {
    await withProject(async (root) => {
        await seed(root, 3);
        const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
        for (const name of Object.keys(env)) if (name.startsWith("TYR_")) delete env[name];
        const result = spawnSync(process.execPath, [CLI, "watch", "--no-follow", "--json", "-n", "2"], {
            cwd: root,
            encoding: "utf8",
            env,
            timeout: 20_000,
        });
        assert.equal(result.status, 0, result.stderr);
        const lines = result.stdout.trim().split("\n");
        assert.equal(lines.length, 2);
        assert.deepEqual(lines.map((line) => (JSON.parse(line) as TyrEvent).message), ["event 2", "event 3"]);

        const bad = spawnSync(process.execPath, [CLI, "watch", "--since", "soon"], { cwd: root, encoding: "utf8", env, timeout: 20_000 });
        assert.equal(bad.status, EXIT_CODES.USAGE);
    });
    await withProject(async (root) => {
        const result = spawnSync(process.execPath, [CLI, "watch", "--no-follow"], { cwd: root, encoding: "utf8", timeout: 20_000 });
        assert.equal(result.status, EXIT_CODES.NOT_INITIALIZED);
        assert.match(result.stderr, /not initialized/);
    }, false);
});
