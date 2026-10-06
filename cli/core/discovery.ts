// Project discovery: locate the root, decide whether Tyr already lives there,
// and walk the tree once to produce the file list every other detector reuses.
//
// This module is deliberately silent — it returns data and never prints.
// The reporter owns all user-facing output.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DiscoveryResult } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Directories we never walk into when scanning a project. Matched by bare
 * name at any depth, so only names that are never real source belong here.
 * `bin` and `obj` are deliberately absent: `bin/` holds Node CLI entry
 * scripts and Rust `src/bin` binaries, and `obj` is a plausible source folder
 * name too. .NET build output in those folders is mostly .dll/.exe, which
 * IGNORED_EXTENSIONS already drops.
 */
export const IGNORED_DIRS: ReadonlySet<string> = new Set([
    // VCS / tooling
    ".git",
    ".idea",
    ".vscode",
    ".turbo",
    ".cache",
    ".parcel-cache",
    ".pnpm-store",
    ".terraform",
    // JS/TS
    "node_modules",
    "bower_components",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".svelte-kit",
    "coverage",
    // Python
    "__pycache__",
    ".venv",
    "venv",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".tox",
    // Compiled / vendored output from other ecosystems
    "target",
    "vendor",
    ".gradle",
    "Pods",
]);

/** OS-generated junk files, matched by exact file name. */
export const IGNORED_FILES: ReadonlySet<string> = new Set([
    ".DS_Store", // macOS Finder metadata
    "Thumbs.db", // Windows thumbnail cache
    "desktop.ini", // Windows folder settings
]);

/** File extensions with no textual content worth indexing. */
export const IGNORED_EXTENSIONS: ReadonlySet<string> = new Set([
    // Binaries and objects
    ".exe",
    ".dll",
    ".so",
    ".dylib",
    ".bin",
    ".o",
    ".a",
    ".obj",
    ".class",
    ".jar",
    ".war",
    ".pyc",
    ".pyo",
    ".wasm",
    ".pack",
    ".idx",
    // Archives and disk images
    ".zip",
    ".tar",
    ".gz",
    ".7z",
    ".rar",
    ".iso",
    ".dmg",
    ".pkg",
    ".deb",
    ".rpm",
    // Data / model blobs
    ".db",
    ".sqlite",
    ".sqlite3",
    ".pt",
    ".pth",
    ".onnx",
    // Images
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".svgz",
    ".bmp",
    ".tiff",
    // Fonts
    ".woff",
    ".woff2",
    ".ttf",
    ".otf",
    ".eot",
    // Media
    ".mp4",
    ".mov",
    ".avi",
    ".mkv",
    ".mp3",
    ".wav",
    ".flac",
    ".ogg",
    // Documents
    ".pdf",
]);

/**
 * Files that mark the top of a project when git is unavailable. Ordered by
 * nothing in particular — the first *directory* going up that holds any of
 * them wins.
 */
const ROOT_MARKERS: readonly string[] = [
    "package.json",
    "pyproject.toml",
    "go.mod",
    "Cargo.toml",
    "pom.xml",
    "build.gradle",
    "Gemfile",
    "composer.json",
    ".git",
];

/** Directory Tyr writes its state into; never scanned, never a marker. */
const TYR_DIR = ".tyr";

/** Depth cap so a symlink-free but pathologically nested repo still finishes. */
const MAX_DEPTH = 25;

/**
 * Upper bound on `fs.readdir` calls in flight across the whole walk. Each one
 * holds a directory handle open, and an unbounded fan-out over a wide tree can
 * exhaust the per-process descriptor limit (EMFILE) — macOS defaults to a soft
 * limit of 256. 32 keeps us far below that while still overlapping enough I/O
 * to keep libuv's thread pool (4 threads by default) saturated; going higher
 * buys nothing but more open handles.
 */
const MAX_CONCURRENT_READDIRS = 32;

/** Pause before the single retry of a readdir that failed with EMFILE/ENFILE. */
const FD_EXHAUSTED_RETRY_MS = 50;

/**
 * Resolve the project root. Git is authoritative when present; otherwise we
 * climb toward the filesystem root looking for a manifest. Always resolves to
 * an absolute path and never throws — the caller decides what to say about it.
 */
export async function findProjectRoot(startDir: string = process.cwd()): Promise<string> {
    const start = path.resolve(startDir);

    try {
        const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
            cwd: start,
            timeout: 5000,
        });
        const root = stdout.trim();
        if (root.length > 0) {
            return path.resolve(root);
        }
    } catch {
        // Not a repo, git missing, or the call timed out — fall through to markers.
    }

    let dir = start;
    // `path.dirname` of the filesystem root returns itself, which ends the climb.
    while (true) {
        for (const marker of ROOT_MARKERS) {
            if (await pathExists(path.join(dir, marker))) {
                return dir;
            }
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }

    return start;
}

/**
 * True only for a real `.tyr` directory; a stray file by that name means the
 * project is not initialized (and the scaffolder should complain about it).
 */
export async function isAlreadyInitialized(root: string): Promise<boolean> {
    try {
        const stats = await fs.stat(path.join(root, TYR_DIR));
        return stats.isDirectory();
    } catch {
        return false;
    }
}

/**
 * Walk the project, collecting absolute file paths. Symlinks are skipped
 * outright so the walk cannot loop or wander outside `root`.
 */
export async function scanProject(root: string): Promise<{ files: string[]; skippedDirs: string[] }> {
    const absRoot = path.resolve(root);
    const files: string[] = [];
    const skippedDirs: string[] = [];

    const recordSkip = (dir: string): void => {
        skippedDirs.push(path.relative(absRoot, dir));
    };

    // One limiter for the entire walk, not one per level: per-level limits
    // multiply with depth and would not actually bound open handles.
    const limit = createLimiter(MAX_CONCURRENT_READDIRS);

    async function walk(dir: string, depth: number): Promise<void> {
        let entries;
        try {
            // Only the readdir itself holds a slot. It is released before we
            // recurse, so a parent never waits on children while blocking them —
            // that is what keeps the recursion deadlock-free at any limit.
            entries = await limit(() => readdirWithRetry(dir));
        } catch {
            // Unreadable directory (EACCES, ENOENT after a race, ...): note it and move on.
            recordSkip(dir);
            return;
        }

        const subdirs: string[] = [];

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            // Checked before isDirectory()/isFile(), both of which are false for links.
            if (entry.isSymbolicLink()) {
                continue;
            }

            if (entry.isDirectory()) {
                if (IGNORED_DIRS.has(entry.name) || entry.name === TYR_DIR) {
                    recordSkip(fullPath);
                    continue;
                }
                if (depth + 1 > MAX_DEPTH) {
                    recordSkip(fullPath);
                    continue;
                }
                subdirs.push(fullPath);
            } else if (entry.isFile()) {
                if (
                    !IGNORED_FILES.has(entry.name) &&
                    !IGNORED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
                ) {
                    files.push(fullPath);
                }
            }
        }

        // Fan out across siblings; the shared arrays are safe because Node runs
        // these callbacks on a single thread. Pending walks cost only memory —
        // the limiter decides how many of them are touching the disk at once.
        await Promise.all(subdirs.map((sub) => walk(sub, depth + 1)));
    }

    await walk(absRoot, 0);

    // Sorted so repeated scans of an unchanged tree produce identical output.
    files.sort();
    skippedDirs.sort();

    return { files, skippedDirs };
}

/** Everything the discovery phase knows, in one pass. */
export async function discoverProject(startDir?: string): Promise<DiscoveryResult> {
    const root = await findProjectRoot(startDir);
    const alreadyInitialized = await isAlreadyInitialized(root);
    const { files, skippedDirs } = await scanProject(root);

    return {
        root,
        alreadyInitialized,
        files,
        fileCount: files.length,
        skippedDirs,
    };
}

/**
 * Read a directory, retrying once if the process (EMFILE) or system (ENFILE)
 * is out of descriptors. Our own readdirs are bounded, so hitting either means
 * something else briefly holds handles; a short pause usually clears it, and
 * one retry is cheap insurance against reporting a readable directory as
 * skipped. Any other error, or a second failure, propagates to the caller.
 */
async function readdirWithRetry(dir: string) {
    try {
        return await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EMFILE" && code !== "ENFILE") {
            throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, FD_EXHAUSTED_RETRY_MS));
        return await fs.readdir(dir, { withFileTypes: true });
    }
}

/**
 * Minimal counting semaphore: `limit(task)` runs `task` once fewer than `max`
 * tasks are active, queueing it otherwise. Waiters are served FIFO, and a slot
 * is handed straight to the next waiter on release so it cannot be stolen.
 */
function createLimiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
    let active = 0;
    const waiting: Array<() => void> = [];

    const release = (): void => {
        const next = waiting.shift();
        if (next) {
            // Transfer the slot directly; `active` stays the same.
            next();
        } else {
            active--;
        }
    };

    return async <T>(task: () => Promise<T>): Promise<T> => {
        if (active < max) {
            active++;
        } else {
            await new Promise<void>((resolve) => waiting.push(resolve));
        }
        try {
            return await task();
        } finally {
            release();
        }
    };
}

async function pathExists(target: string): Promise<boolean> {
    try {
        await fs.access(target);
        return true;
    } catch {
        return false;
    }
}
