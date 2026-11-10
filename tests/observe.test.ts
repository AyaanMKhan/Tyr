// observe.ts: attributing git-driven working-tree writes to their git event.
// Everything runs on a fake clock, so the timing rules are tested exactly.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { createObserver, mergeBatches, type Observer, type ObserverClock } from "../cli/core/observe.js";
import type { TyrEventInput } from "../cli/core/events.js";
import type { FileChangeBatch } from "../cli/core/fs-watch.js";
import type { GitHeadState, GitOperationState, GitWatchEvent } from "../cli/core/git-watch.js";

/** A manual clock: time only moves through advance(). */
class FakeClock implements ObserverClock {
    private time = 1_000_000;
    private timers = new Map<number, { at: number; callback: () => void }>();
    private nextHandle = 1;

    now(): number {
        return this.time;
    }

    setTimer(callback: () => void, ms: number): unknown {
        const handle = this.nextHandle++;
        this.timers.set(handle, { at: this.time + ms, callback });
        return handle;
    }

    clearTimer(handle: unknown): void {
        this.timers.delete(handle as number);
    }

    advance(ms: number): void {
        const end = this.time + ms;
        for (;;) {
            let next: [number, { at: number; callback: () => void }] | null = null;
            for (const entry of this.timers) {
                if (entry[1].at <= end && (next === null || entry[1].at < next[1].at)) next = entry;
            }
            if (next === null) break;
            this.timers.delete(next[0]);
            this.time = next[1].at;
            next[1].callback();
        }
        this.time = end;
    }
}

function setup(options: { windowMs?: number; idleHoldMs?: number; maxHoldMs?: number } = {}): {
    clock: FakeClock;
    observer: Observer;
    events: TyrEventInput[];
} {
    const clock = new FakeClock();
    const events: TyrEventInput[] = [];
    let id = 0;
    const observer = createObserver({
        emit: (event) => events.push(event),
        clock,
        newId: () => `git-${++id}`,
        windowMs: 2500,
        ...options,
    });
    return { clock, observer, events };
}

const batch = (partial: Partial<FileChangeBatch>): FileChangeBatch => {
    const added = partial.added ?? [];
    const modified = partial.modified ?? [];
    const removed = partial.removed ?? [];
    return { added, modified, removed, total: added.length + modified.length + removed.length, truncated: false, ...partial };
};

const head = (from: string | null, to: string | null, commit = "b".repeat(40)): GitWatchEvent => {
    const state = (branch: string | null, hash: string): GitHeadState => ({ commit: hash, branch, detached: branch === null });
    return {
        kind: "head",
        previous: state(from, "a".repeat(40)),
        current: state(to, commit),
        commitChanged: true,
        branchChanged: from !== to,
    };
};

const idle: GitOperationState = { merging: false, rebasing: false, cherryPicking: false, reverting: false, bisecting: false };

test("a batch with no git activity around it is a hand edit, journaled at once", () => {
    const { observer, events } = setup();
    observer.fsBatch(batch({ modified: ["a.ts"] }));
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "fs.changed");
    assert.equal(events[0].message, "1 file changed: a.ts");
    assert.equal(events[0].data?.cause, undefined);
});

test("a checkout: hint, files, git event -> one git event and one attributed fs.changed", () => {
    const { clock, observer, events } = setup();
    observer.gitActivity(); // index.lock appears
    clock.advance(200);
    observer.fsBatch(batch({ added: ["new.ts"], modified: ["a.ts"] }));
    clock.advance(100);
    observer.gitEvent(head("main", "feature"));
    observer.gitEvent({ kind: "index", staged: [] });
    clock.advance(1500);
    observer.fsBatch(batch({ modified: ["b.ts"], removed: ["old.ts"] }));
    assert.deepEqual(events.map((e) => e.kind), ["git.head", "git.index"], "fs held while git is busy");

    clock.advance(2499);
    assert.equal(events.length, 2);
    clock.advance(1);
    assert.equal(events.length, 3);
    const fsEvent = events[2];
    assert.equal(fsEvent.kind, "fs.changed");
    assert.equal(fsEvent.message, "4 files changed by switching to feature");
    assert.deepEqual(fsEvent.data, {
        added: ["new.ts"],
        modified: ["a.ts", "b.ts"],
        removed: ["old.ts"],
        total: 4,
        truncated: false,
        cause: "git",
        gitKind: "git.head",
        gitEventId: "git-1",
        batches: 2,
    });
    assert.equal(events[0].id, "git-1", "git events carry the id the link points at");
});

test("files that arrive after the git event, within the window, are still attributed", () => {
    const { clock, observer, events } = setup();
    observer.gitEvent(head("main", "main"));
    clock.advance(2400);
    observer.fsBatch(batch({ modified: ["a.ts"] }));
    clock.advance(5000);
    assert.equal(events[1].message, "1 file changed by moving main to bbbbbbb");
    assert.equal(events[1].data?.gitEventId, "git-1");
});

test("an edit after the window is a hand edit again", () => {
    const { clock, observer, events } = setup();
    observer.gitEvent(head("main", "feature"));
    clock.advance(2501);
    observer.fsBatch(batch({ modified: ["a.ts"] }));
    assert.equal(events.length, 2);
    assert.equal(events[1].data?.cause, undefined);
});

test("hints alone delay a batch but never attribute it", () => {
    const { clock, observer, events } = setup();
    observer.gitActivity(); // an editor's background `git status`
    clock.advance(100);
    observer.fsBatch(batch({ modified: ["a.ts"] }));
    observer.fsBatch(batch({ added: ["b.ts"] }));
    assert.equal(events.length, 0);
    clock.advance(2500);
    assert.deepEqual(
        events.map((e) => [e.message, e.data?.cause]),
        [["1 file changed: a.ts", undefined], ["1 file changed: b.ts", undefined]],
    );
});

test("refs updates other than the stash never attribute; the stash does", () => {
    const { clock, observer, events } = setup();
    observer.gitEvent({ kind: "refs", changes: [{ ref: "refs/remotes/origin/main", previous: "a", current: "b" }] });
    observer.fsBatch(batch({ modified: ["a.ts"] }));
    assert.equal(events[1].data?.cause, undefined, "a fetch does not hold edits");

    clock.advance(10_000);
    observer.gitEvent({ kind: "refs", changes: [{ ref: "refs/stash", previous: null, current: "c" }] });
    observer.fsBatch(batch({ modified: ["a.ts"] }));
    clock.advance(3000);
    assert.equal(events[3].message, "1 file changed by git stash");
    assert.equal(events[3].data?.gitKind, "git.refs");
});

test("merge-state outranks head; the latest of equal events wins", () => {
    const { clock, observer, events } = setup();
    observer.gitEvent({ kind: "merge-state", previous: idle, current: { ...idle, rebasing: true } });
    observer.fsBatch(batch({ modified: ["a.ts"] }));
    observer.gitEvent(head(null, null));
    clock.advance(1000);
    observer.gitEvent({ kind: "merge-state", previous: { ...idle, rebasing: true }, current: idle });
    clock.advance(3000);
    const fsEvent = events.find((e) => e.kind === "fs.changed");
    assert.equal(fsEvent?.message, "1 file changed by git rebase");
    assert.equal(fsEvent?.data?.gitEventId, "git-3");
});

test("an in-progress operation alone does not attribute: conflict fixes are hand edits", () => {
    const { clock, observer, events } = setup();
    observer.gitEvent({ kind: "merge-state", previous: idle, current: { ...idle, merging: true } });
    clock.advance(60_000);
    observer.fsBatch(batch({ modified: ["conflicted.ts"] }));
    assert.equal(events.length, 2);
    assert.equal(events[1].data?.cause, undefined);
});

test("a long operation is cut at maxHoldMs", () => {
    const { clock, observer, events } = setup({ maxHoldMs: 5000 });
    observer.gitEvent(head("main", "main"));
    for (let i = 0; i < 8; i++) {
        observer.fsBatch(batch({ added: [`f${i}.ts`] }));
        observer.gitActivity();
        clock.advance(1000);
    }
    const fsEvents = events.filter((e) => e.kind === "fs.changed");
    assert.ok(fsEvents.length >= 1, "something was reported before the operation ended");
    assert.equal(fsEvents[0].data?.cause, "git");
});

test("idleHoldMs (git watcher polling) lets a late git event claim a batch", () => {
    const { clock, observer, events } = setup({ idleHoldMs: 3000 });
    observer.fsBatch(batch({ modified: ["a.ts"] }));
    clock.advance(2000);
    observer.gitEvent(head("main", "feature"));
    clock.advance(5000);
    assert.equal(events[1].message, "1 file changed by switching to feature");
});

test("configure() retunes the window at runtime", () => {
    const { clock, observer, events } = setup();
    observer.configure({ windowMs: 6000 });
    observer.gitEvent(head("main", "feature"));
    clock.advance(5000);
    observer.fsBatch(batch({ modified: ["a.ts"] }));
    clock.advance(6000);
    assert.equal(events[1].data?.cause, "git");
});

test("flush() and close() journal held batches; nothing after close", () => {
    const { observer, events } = setup();
    observer.gitEvent(head("main", "feature"));
    observer.fsBatch(batch({ modified: ["a.ts"] }));
    observer.close();
    assert.equal(events.length, 2);
    assert.equal(events[1].data?.cause, "git");
    observer.fsBatch(batch({ modified: ["b.ts"] }));
    observer.gitEvent(head("feature", "main"));
    observer.close();
    assert.equal(events.length, 2);
});

test("a throwing sink does not break the observer", () => {
    let calls = 0;
    const observer = createObserver({
        emit: () => {
            calls++;
            throw new Error("sink bug");
        },
        clock: new FakeClock(),
    });
    observer.fsBatch(batch({ modified: ["a.ts"] }));
    observer.fsBatch(batch({ modified: ["b.ts"] }));
    assert.equal(calls, 2);
});

test("mergeBatches folds successive batches into their net effect", () => {
    const merged = mergeBatches([
        batch({ added: ["tmp.ts", "new.ts"], modified: ["a.ts"], removed: ["gone.ts"] }),
        batch({ removed: ["tmp.ts", "a.ts"], added: ["gone.ts"], modified: ["new.ts"] }),
    ]);
    assert.deepEqual(merged, { added: ["new.ts"], modified: ["gone.ts"], removed: ["a.ts"], total: 3, truncated: false });

    const capped = mergeBatches([batch({ added: ["x.ts"], total: 900, truncated: true }), batch({ added: ["y.ts"] })]);
    assert.equal(capped.truncated, true);
    assert.equal(capped.total, 901);
});
