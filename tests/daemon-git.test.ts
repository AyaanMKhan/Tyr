// End to end: a real daemon in a real git repository, observed through the
// journal exactly as `tyr watch` will (followEvents). Proves that git events
// reach the journal, that a branch switch's working-tree writes are
// attributed to it instead of reported as hand edits, that hand edits still
// read as hand edits, that a write racing the startup scan is not lost, and
// that the daemon stops cleanly.
//
// Timeouts are generous on purpose: either watcher may be polling on a slow
// or unusual filesystem (git every 2s, files every 5s), and the observer
// holds git-driven batches until git has been quiet for its window.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isProcessAlive, startDaemon, stopDaemon } from "../cli/core/daemon.js";
import { followEvents } from "../cli/core/event-stream.js";
import type { TyrEvent } from "../cli/core/events.js";
import type { TyrState } from "../cli/core/types.js";
import { makeProject, removeProject } from "./helpers.js";

const WAIT_MS = 20_000;

function gitAvailable(): boolean {
    try {
        execFileSync("git", ["--version"], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

function git(root: string, ...args: string[]): void {
    execFileSync(
        "git",
        ["-c", "user.name=Tyr", "-c", "user.email=tyr@example.com", "-c", "commit.gpgsign=false", ...args],
        { cwd: root, stdio: "ignore" },
    );
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Every path an fs.changed event lists. */
function pathsOf(event: TyrEvent): string[] {
    const data = (event.data ?? {}) as { added?: string[]; modified?: string[]; removed?: string[] };
    return [...(data.added ?? []), ...(data.modified ?? []), ...(data.removed ?? [])];
}

test(
    "daemon + git: commits, branch switches attributed to git, hand edits, clean stop",
    { timeout: 120_000, skip: gitAvailable() ? false : "git is not installed" },
    async () => {
        const now = new Date().toISOString();
        const state: TyrState = {
            version: 1,
            status: "initialized",
            createdAt: now,
            updatedAt: now,
            lastIndexedCommit: null,
            lastScanFileCount: 0,
            runCount: 0,
            lastRunAt: null,
        };
        const root = await makeProject({
            ".gitignore": ".tyr/\n",
            "a.txt": "a on main\n",
            "b.txt": "b on main\n",
            "src/shared.txt": "shared\n",
            ".tyr/tyr.json": "{}\n",
            ".tyr/state/state.json": JSON.stringify(state),
            ".tyr/logs/tyr.log": "",
        });
        let pid: number | null = null;
        const events: TyrEvent[] = [];
        const follower = await followEvents(root, {
            pollIntervalMs: 50,
            persistent: false,
            onEvent: (event) => events.push(event),
        });

        const waitFor = async (what: string, predicate: (event: TyrEvent) => boolean, from = 0): Promise<TyrEvent> => {
            const deadline = Date.now() + WAIT_MS;
            for (;;) {
                const match = events.slice(from).find(predicate);
                if (match !== undefined) return match;
                if (Date.now() > deadline) {
                    assert.fail(`timed out waiting for ${what}; journal:\n${events.map((e) => `  ${e.kind}: ${e.message}`).join("\n")}`);
                }
                await delay(50);
            }
        };
        const fsChanged = (rel: string) => (event: TyrEvent): boolean =>
            event.kind === "fs.changed" && pathsOf(event).includes(rel);

        try {
            // A second branch whose files differ from main's: one modified,
            // one only there, one only on main.
            git(root, "init", "-q", "-b", "main");
            git(root, "add", ".");
            git(root, "commit", "-q", "-m", "base");
            git(root, "checkout", "-q", "-b", "other");
            await fs.writeFile(path.join(root, "a.txt"), "a on other, longer\n");
            await fs.writeFile(path.join(root, "only-other.txt"), "o\n");
            await fs.rm(path.join(root, "b.txt"));
            git(root, "add", "-A");
            git(root, "commit", "-q", "-m", "other");
            git(root, "checkout", "-q", "main");

            const started = await startDaemon(root, { readyTimeoutMs: 10_000 });
            pid = started.pid;
            assert.equal(started.ready, true);

            // 0. Written while the daemon is still taking its baseline: must
            //    be reported, not folded silently into the baseline.
            await fs.writeFile(path.join(root, "early.txt"), "written right after tyr start\n");
            const startedEvent = await waitFor("daemon.started", (e) => e.kind === "daemon.started");
            const early = await waitFor("the early write", fsChanged("early.txt"));
            assert.equal(early.data?.cause, undefined);
            await delay(500);

            // 1. A hand edit, then a commit: git.head with the new commit.
            await fs.writeFile(path.join(root, "c.txt"), "c\n");
            const edit = await waitFor("fs.changed for c.txt", fsChanged("c.txt"));
            assert.equal(edit.data?.cause, undefined, "an edit before any git command is a hand edit");
            git(root, "add", "c.txt", "early.txt");
            git(root, "commit", "-q", "-m", "add c");
            const commit = await waitFor(
                "git.head for the commit",
                (e) => e.kind === "git.head" && e.data?.commitChanged === true && e.data?.branchChanged === false,
            );
            assert.match(commit.message ?? "", /^HEAD on main moved /);

            // 2. A new branch at the same commit: a branch switch, no files.
            git(root, "checkout", "-q", "-b", "x");
            await waitFor(
                "git.head switching to x",
                (e) => e.kind === "git.head" && (e.data?.current as { branch?: string } | undefined)?.branch === "x",
            );

            // 3. Switching to a branch with different files: one git event,
            //    and the rewritten files arrive as ONE fs.changed attributed to it.
            const beforeSwitch = events.length;
            git(root, "checkout", "-q", "other");
            const head = await waitFor(
                "git.head switching to other",
                (e) => e.kind === "git.head" && (e.data?.current as { branch?: string } | undefined)?.branch === "other",
                beforeSwitch,
            );
            const attributed = await waitFor("the attributed fs.changed", fsChanged("only-other.txt"), beforeSwitch);
            assert.equal(attributed.data?.cause, "git");
            assert.equal(attributed.data?.gitKind, "git.head");
            assert.equal(attributed.data?.gitEventId, head.id, "linked to the git event's journal id");
            assert.match(attributed.message ?? "", /^\d+ files? changed by switching to other$/);
            const paths = pathsOf(attributed);
            for (const rel of ["a.txt", "only-other.txt", "b.txt", "c.txt", "early.txt"]) {
                assert.ok(paths.includes(rel), `${rel} in ${JSON.stringify(attributed.data)}`);
            }

            // 4. Once git has been quiet past the window, a plain edit is a
            //    plain edit again.
            await delay(4000);
            const beforeEdit = events.length;
            await fs.writeFile(path.join(root, "src/shared.txt"), "edited by hand on other\n");
            const handEdit = await waitFor("the hand edit", fsChanged("src/shared.txt"), beforeEdit);
            assert.equal(handEdit.data?.cause, undefined);
            assert.equal(handEdit.message, "1 file changed: src/shared.txt");

            // Nothing about the switch was ever reported as a hand edit.
            const switchEvents = events.slice(beforeSwitch, beforeEdit).filter((e) => e.kind === "fs.changed");
            assert.deepEqual(
                switchEvents.map((e) => e.data?.cause),
                ["git"],
                `fs.changed during the switch: ${JSON.stringify(switchEvents)}`,
            );

            // 5. A clean stop, seen through the journal too.
            const stopped = await stopDaemon(root, { timeoutMs: 10_000 });
            assert.equal(stopped.graceful, true);
            assert.equal(isProcessAlive(started.pid), false);
            pid = null;
            await waitFor("daemon.stopped", (e) => e.kind === "daemon.stopped");
            assert.equal(events.some((e) => e.kind === "daemon.crashed"), false);

            if (process.env.TYR_E2E_DUMP === "1") {
                // For eyeballing the journal: TYR_E2E_DUMP=1 npm test
                process.stdout.write(`# watchers: ${JSON.stringify(startedEvent.data)}\n`);
                for (const event of events) process.stdout.write(`# ${JSON.stringify(event)}\n`);
            }
        } finally {
            follower.close();
            await follower.done;
            if (pid !== null && isProcessAlive(pid)) {
                await stopDaemon(root, { timeoutMs: 5000 }).catch(() => undefined);
            }
            await removeProject(root);
        }
    },
);
