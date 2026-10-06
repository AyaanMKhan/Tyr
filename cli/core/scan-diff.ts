// Incremental re-scan: fingerprint the files a scan found, persist that as a
// manifest in `.tyr/state/scan.json`, and diff two manifests to learn what
// was added, removed, or modified in between.
//
// The intended loop for `tyr status` / `tyr watch` is:
//
//     const prev = await loadScanManifest(root);
//     const { files } = await scanProject(root);
//     const next = await buildScanManifest(root, files);
//     const diff = diffManifests(prev, next);
//     await saveScanManifest(root, next);   // only when the new scan becomes the baseline
//
// Fingerprints are size + mtime, not content hashes: a stat per file is cheap
// enough to run on every status call, whereas hashing would read the whole
// tree. The trade-off is that an edit preserving both size and mtime (a tool
// that restores mtime, or two same-size writes inside the filesystem's mtime
// granularity) goes unnoticed. A touch with no content change is reported as
// modified, which errs on the safe side.
//
// This module is deliberately silent — it returns data and never prints.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readJsonObject, resolveTyrPaths, toJsonDocument, writeFileAtomic } from "./scaffold.js";
import { FileFingerprint, ScanDiff, ScanManifest } from "./types.js";

/** Bump when the on-disk manifest shape changes; older files are then ignored. */
export const SCAN_MANIFEST_VERSION = 1;

/**
 * How many `stat` calls may be in flight at once. Firing one per file at the
 * same time can exhaust file descriptors (EMFILE) or the libuv thread pool on
 * large trees; a small fixed pool is just as fast in practice.
 */
const STAT_CONCURRENCY = 64;

/* -------------------------------------------------------------------------
 * Building
 * ---------------------------------------------------------------------- */

/** Root-relative path with `/` separators, so manifests compare across platforms. */
export function toManifestPath(root: string, file: string): string {
    return path.relative(root, file).split(path.sep).join("/");
}

/**
 * Stat every file and build a manifest. `files` is the absolute list from
 * `scanProject()`. Files that vanished (or stopped being regular files)
 * between the scan and the stat are left out rather than failing the build —
 * the next scan will simply report them as removed.
 */
export async function buildScanManifest(root: string, files: readonly string[]): Promise<ScanManifest> {
    const absRoot = path.resolve(root);
    // Indexed by position so the pool can fill slots in any order and the
    // result still follows the (already sorted) input order.
    const results: Array<[string, FileFingerprint] | null> = new Array(files.length).fill(null);
    let next = 0;

    async function worker(): Promise<void> {
        // `next++` is safe: workers only interleave at the `await`.
        while (next < files.length) {
            const index = next++;
            const file = path.resolve(absRoot, files[index]);
            try {
                // lstat to match the scanner, which never follows symlinks.
                const stats = await fs.lstat(file);
                if (stats.isFile()) {
                    results[index] = [
                        toManifestPath(absRoot, file),
                        { size: stats.size, mtimeMs: stats.mtimeMs },
                    ];
                }
            } catch {
                // ENOENT after a race, EACCES, ...: skip the file.
            }
        }
    }

    const poolSize = Math.min(STAT_CONCURRENCY, files.length);
    await Promise.all(Array.from({ length: poolSize }, () => worker()));

    const entries = results
        .filter((entry): entry is [string, FileFingerprint] => entry !== null)
        .sort(([a], [b]) => compareStrings(a, b));

    return {
        version: SCAN_MANIFEST_VERSION,
        scannedAt: new Date().toISOString(),
        fileCount: entries.length,
        // fromEntries defines own properties, so a file literally named
        // `__proto__` becomes a key instead of rewriting the prototype.
        files: Object.fromEntries(entries),
    };
}

/* -------------------------------------------------------------------------
 * Persistence
 * ---------------------------------------------------------------------- */

/**
 * Load `.tyr/state/scan.json`, or null when it is missing, malformed, or from
 * another schema version. Null means "no baseline": callers should treat every
 * file as new (which `diffManifests(null, next)` does).
 */
export async function loadScanManifest(root: string): Promise<ScanManifest | null> {
    const raw = await readJsonObject<Record<string, unknown>>(resolveTyrPaths(root).scanFile);
    if (raw === null || raw.version !== SCAN_MANIFEST_VERSION) {
        return null;
    }

    const files = raw.files;
    if (files === null || typeof files !== "object" || Array.isArray(files)) {
        return null;
    }

    // A baseline with a corrupt entry cannot be trusted to diff against, so
    // reject the whole file rather than silently reporting phantom changes.
    for (const value of Object.values(files)) {
        if (!isFingerprint(value)) {
            return null;
        }
    }

    const fileMap = files as Record<string, FileFingerprint>;
    return {
        version: SCAN_MANIFEST_VERSION,
        scannedAt: typeof raw.scannedAt === "string" ? raw.scannedAt : "",
        fileCount: Object.keys(fileMap).length,
        files: fileMap,
    };
}

/** Atomically replace `.tyr/state/scan.json` with `manifest`. */
export async function saveScanManifest(root: string, manifest: ScanManifest): Promise<void> {
    const paths = resolveTyrPaths(root);
    await fs.mkdir(paths.stateDir, { recursive: true });
    await writeFileAtomic(paths.scanFile, toJsonDocument(manifest));
}

/* -------------------------------------------------------------------------
 * Diffing
 * ---------------------------------------------------------------------- */

/**
 * Compare a previous manifest with a fresh one. A null `prev` (no baseline
 * yet) reports every file as added. Pure: no I/O, inputs are not mutated.
 */
export function diffManifests(prev: ScanManifest | null, next: ScanManifest): ScanDiff {
    const before = prev === null ? {} : prev.files;
    const after = next.files;

    const added: string[] = [];
    const removed: string[] = [];
    const modified: string[] = [];
    let unchanged = 0;

    for (const file of Object.keys(after)) {
        if (!Object.hasOwn(before, file)) {
            added.push(file);
        } else if (sameFingerprint(before[file], after[file])) {
            unchanged++;
        } else {
            modified.push(file);
        }
    }

    for (const file of Object.keys(before)) {
        if (!Object.hasOwn(after, file)) {
            removed.push(file);
        }
    }

    // Object key order is not guaranteed sorted (integer-like keys jump to
    // the front), so sort explicitly for deterministic output.
    added.sort(compareStrings);
    removed.sort(compareStrings);
    modified.sort(compareStrings);

    return { added, removed, modified, unchanged };
}

/** True when the diff found nothing added, removed, or modified. */
export function isEmptyDiff(diff: ScanDiff): boolean {
    return diff.added.length === 0 && diff.removed.length === 0 && diff.modified.length === 0;
}

/* -------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------- */

function sameFingerprint(a: FileFingerprint, b: FileFingerprint): boolean {
    return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function isFingerprint(value: unknown): value is FileFingerprint {
    if (value === null || typeof value !== "object") {
        return false;
    }
    const { size, mtimeMs } = value as Record<string, unknown>;
    return Number.isFinite(size) && Number.isFinite(mtimeMs);
}

/** Plain code-unit order, the same order `Array.prototype.sort()` uses by default. */
function compareStrings(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}
