// lock.ts: the short-lived `.tyr/state/tyr.lock` around critical sections.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { LockTimeoutError, isProcessAlive, readLock, resolveLockFile, withTyrLock } from "../cli/core/lock.js";
import { resolveTyrPaths } from "../cli/core/scaffold.js";
import { makeProject, removeProject } from "./helpers.js";

async function makeTyrProject(): Promise<string> {
    return makeProject({ ".tyr/state/.keep": "", ".tyr/logs/tyr.log": "" });
}

async function exists(file: string): Promise<boolean> {
    return fs.access(file).then(() => true, () => false);
}

async function deadPid(): Promise<number> {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise((resolve) => child.once("exit", resolve));
    assert.ok(child.pid !== undefined);
    return child.pid;
}

async function writeForeignLock(root: string, holder: { pid: number; owner: string; acquiredAt: string }): Promise<void> {
    await fs.writeFile(resolveLockFile(root), JSON.stringify(holder));
}

test("isProcessAlive is exported from lock.ts", () => {
    assert.equal(isProcessAlive(process.pid), true);
});

test("withTyrLock: holds the lock during fn and releases it after", async () => {
    const root = await makeTyrProject();
    const lockFile = resolveLockFile(root);
    try {
        const result = await withTyrLock(root, "test", async () => {
            const holder = await readLock(root);
            assert.equal(holder?.pid, process.pid);
            assert.equal(holder?.owner, "test");
            return 42;
        });
        assert.equal(result, 42);
        assert.equal(await exists(lockFile), false);
    } finally {
        await removeProject(root);
    }
});

test("withTyrLock: releases when fn throws, and rethrows", async () => {
    const root = await makeTyrProject();
    try {
        await assert.rejects(
            withTyrLock(root, "test", async () => {
                throw new Error("boom");
            }),
            /boom/,
        );
        assert.equal(await exists(resolveLockFile(root)), false);
    } finally {
        await removeProject(root);
    }
});

test("withTyrLock: creates .tyr/state when it does not exist yet", async () => {
    const root = await makeProject({});
    try {
        await withTyrLock(root, "test", async () => undefined);
        assert.equal(await exists(resolveTyrPaths(root).stateDir), true);
    } finally {
        await removeProject(root);
    }
});

test("withTyrLock: concurrent callers in one process never overlap", async () => {
    const root = await makeTyrProject();
    try {
        let active = 0;
        let maxActive = 0;
        const order: number[] = [];
        await Promise.all(
            Array.from({ length: 8 }, (_, i) =>
                withTyrLock(root, `caller ${i}`, async () => {
                    active++;
                    maxActive = Math.max(maxActive, active);
                    await new Promise((resolve) => setTimeout(resolve, 5));
                    order.push(i);
                    active--;
                }),
            ),
        );
        assert.equal(maxActive, 1);
        assert.equal(order.length, 8);
    } finally {
        await removeProject(root);
    }
});

test("withTyrLock: waits for a lock held by another process", async () => {
    const root = await makeTyrProject();
    const lockUrl = new URL("../cli/core/lock.js", import.meta.url).href;
    const script = `
        const { withTyrLock } = await import(${JSON.stringify(lockUrl)});
        await withTyrLock(process.argv[1], "child", async () => {
            process.stdout.write("held\\n");
            await new Promise((r) => setTimeout(r, 400));
        });
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, root], { stdio: ["ignore", "pipe", "inherit"] });
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    try {
        await new Promise<void>((resolve, reject) => {
            child.stdout.on("data", (chunk: Buffer) => {
                if (chunk.toString().includes("held")) resolve();
            });
            child.once("exit", () => reject(new Error("child exited before taking the lock")));
        });
        const started = Date.now();
        await withTyrLock(root, "parent", async () => {
            // The child must be done (it releases before exiting).
            assert.equal((await readLock(root))?.owner, "parent");
        });
        assert.ok(Date.now() - started >= 200, `waited only ${Date.now() - started}ms`);
        assert.equal(await exited, 0);
    } finally {
        child.kill();
        await exited;
        await removeProject(root);
    }
});

test("withTyrLock: times out with LockTimeoutError naming a live holder", async () => {
    const root = await makeTyrProject();
    try {
        await writeForeignLock(root, { pid: process.pid, owner: "tyr init", acquiredAt: new Date().toISOString() });
        let ran = false;
        await assert.rejects(
            withTyrLock(root, "test", async () => {
                ran = true;
            }, { timeoutMs: 150 }),
            (error: unknown) => {
                assert.ok(error instanceof LockTimeoutError);
                assert.equal(error.holder?.pid, process.pid);
                assert.match(error.message, new RegExp(`pid ${process.pid}, \`tyr init\``));
                assert.match(error.message, /Another Tyr command is updating \.tyr\//);
                return true;
            },
        );
        assert.equal(ran, false);
        // The foreign lock is left alone.
        assert.equal((await readLock(root))?.owner, "tyr init");
    } finally {
        await removeProject(root);
    }
});

test("withTyrLock: breaks a lock whose process is dead, and logs it", async () => {
    const root = await makeTyrProject();
    try {
        const pid = await deadPid();
        await writeForeignLock(root, { pid, owner: "crashed", acquiredAt: new Date().toISOString() });
        const result = await withTyrLock(root, "test", async () => (await readLock(root))?.owner, { timeoutMs: 1000 });
        assert.equal(result, "test");
        const log = await fs.readFile(resolveTyrPaths(root).logFile, "utf8");
        assert.match(log, new RegExp(`WARN Broke stale .tyr lock held by pid ${pid}`));
    } finally {
        await removeProject(root);
    }
});

test("withTyrLock: breaks a lock held longer than staleMs even if its process lives", async () => {
    const root = await makeTyrProject();
    try {
        const old = new Date(Date.now() - 60_000).toISOString();
        await writeForeignLock(root, { pid: process.pid, owner: "hung", acquiredAt: old });
        const result = await withTyrLock(root, "test", async () => "ok", { timeoutMs: 1000, staleMs: 5000 });
        assert.equal(result, "ok");
    } finally {
        await removeProject(root);
    }
});

test("withTyrLock: only releases a lock it still owns", async () => {
    const root = await makeTyrProject();
    try {
        await withTyrLock(root, "test", async () => {
            // Simulate our lock being broken and taken over by someone else.
            await writeForeignLock(root, { pid: process.pid, owner: "usurper", acquiredAt: new Date().toISOString() });
        });
        assert.equal((await readLock(root))?.owner, "usurper");
    } finally {
        await removeProject(root);
    }
});

test("withTyrLock: nested calls for the same root do not deadlock", async () => {
    const root = await makeTyrProject();
    try {
        const result = await withTyrLock(root, "outer", async () => {
            const inner = await withTyrLock(root, "inner", async () => {
                // Still the outer holder: nesting does not re-acquire.
                return (await readLock(root))?.owner;
            }, { timeoutMs: 200 });
            assert.equal(await exists(resolveLockFile(root)), true, "inner release must not drop the outer lock");
            return inner;
        });
        assert.equal(result, "outer");
        assert.equal(await exists(resolveLockFile(root)), false);
    } finally {
        await removeProject(root);
    }
});

test("withTyrLock: different roots do not block each other", async () => {
    const a = await makeTyrProject();
    const b = await makeTyrProject();
    try {
        await withTyrLock(a, "a", () => withTyrLock(b, "b", async () => "ok", { timeoutMs: 200 }));
    } finally {
        await removeProject(a);
        await removeProject(b);
    }
});
