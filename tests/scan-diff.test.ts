// scan-diff.ts: saving the scan baseline under the `.tyr/` lock.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { LockTimeoutError, readLock, resolveLockFile, withTyrLock } from "../cli/core/lock.js";
import { resolveTyrPaths } from "../cli/core/scaffold.js";
import { buildScanManifest, loadScanManifest, saveScanManifest } from "../cli/core/scan-diff.js";
import { makeProject, removeProject } from "./helpers.js";

async function exists(file: string): Promise<boolean> {
    return fs.access(file).then(
        () => true,
        () => false,
    );
}

test("saveScanManifest: writes scan.json and releases the lock", async () => {
    const root = await makeProject({ "a.txt": "a", ".tyr/logs/tyr.log": "" });
    try {
        const manifest = await buildScanManifest(root, [path.join(root, "a.txt")]);
        await saveScanManifest(root, manifest);
        assert.deepEqual((await loadScanManifest(root))?.files, manifest.files);
        assert.equal(await exists(resolveLockFile(root)), false);
    } finally {
        await removeProject(root);
    }
});

test("saveScanManifest: does not write while another live holder has the lock", async () => {
    const root = await makeProject({ "a.txt": "a", ".tyr/state/.keep": "", ".tyr/logs/tyr.log": "" });
    try {
        await fs.writeFile(resolveLockFile(root), JSON.stringify({ pid: process.pid, owner: "other", acquiredAt: new Date().toISOString() }));
        const manifest = await buildScanManifest(root, [path.join(root, "a.txt")]);
        await assert.rejects(saveScanManifest(root, manifest, "test", { timeoutMs: 150 }), LockTimeoutError);
        assert.equal(await exists(resolveTyrPaths(root).scanFile), false);
        assert.equal((await readLock(root))?.owner, "other");
    } finally {
        await removeProject(root);
    }
});

test("saveScanManifest: nested inside withTyrLock (as init does) does not deadlock", async () => {
    const root = await makeProject({ "a.txt": "a", ".tyr/logs/tyr.log": "" });
    try {
        const manifest = await buildScanManifest(root, [path.join(root, "a.txt")]);
        const owner = await withTyrLock(root, "tyr init", async () => {
            await saveScanManifest(root, manifest, "tyr init", { timeoutMs: 200 });
            assert.equal(await exists(resolveLockFile(root)), true, "the nested save must not drop the outer lock");
            return (await readLock(root))?.owner;
        });
        assert.equal(owner, "tyr init");
        assert.equal((await loadScanManifest(root))?.fileCount, 1);
        assert.equal(await exists(resolveLockFile(root)), false);
    } finally {
        await removeProject(root);
    }
});
