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

// `git ls-files` on a very large work tree can take a while and print a lot;
// both caps are generous so only a genuinely wedged git trips them, and a trip
// just means the scan falls back to the hard-coded rules alone.
const GIT_LS_FILES_TIMEOUT_MS = 15000;
const GIT_LS_FILES_MAX_BUFFER = 256 * 1024 * 1024;

/** Knobs for `scanProject`; every field is optional. */
export interface ScanOptions {
    /**
     * Drop files git would ignore (.gitignore, .git/info/exclude, the global
     * excludes file) when `root` sits inside a git work tree. Default: true.
     * Has no effect outside a repo.
     */
    respectGitignore?: boolean;
}

/**
 * What git considers part of the project below the scan root, as POSIX-style
 * paths relative to that root (NFC-normalized, see `toGitKey`).
 */
interface GitFileFilter {
    /** Tracked files plus untracked-but-not-ignored files. */
    files: Set<string>;
    /** Every ancestor directory of an entry in `files`, for pruning the walk. */
    dirs: Set<string>;
    /**
     * Directories git reports as a single opaque entry — submodules and nested,
     * untracked repositories. The outer repo's ignore rules say nothing about
     * their contents, so they are walked with the hard-coded rules only.
     */
    opaqueDirs: Set<string>;
}

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
 * Ask git which files under `absRoot` belong to the project: tracked files
 * (`--cached`) plus untracked files no ignore rule matches (`--others
 * --exclude-standard`). Run from `absRoot`, so a root nested inside a repo
 * gets paths relative to itself and nothing from outside it. `-z` turns off
 * git's C-quoting, so spaces and non-ASCII names arrive verbatim.
 *
 * Returns null — meaning "no git filtering" — outside a work tree, when git
 * is missing, or when it fails or times out.
 */
async function loadGitFileFilter(absRoot: string): Promise<GitFileFilter | null> {
    let stdout: string;
    try {
        const result = await execFileAsync(
            "git",
            ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
            {
                cwd: absRoot,
                timeout: GIT_LS_FILES_TIMEOUT_MS,
                maxBuffer: GIT_LS_FILES_MAX_BUFFER,
                encoding: "utf8",
                windowsHide: true,
            },
        );
        stdout = result.stdout;
    } catch {
        // Not a repo (or a bare one), git missing, or the call timed out.
        return null;
    }

    const files = new Set<string>();
    const dirs = new Set<string>();
    const opaqueDirs = new Set<string>();

    for (const raw of stdout.split("\0")) {
        if (raw.length === 0) {
            continue;
        }
        // A trailing slash marks an untracked nested repository, which git
        // reports as one entry instead of descending into it.
        const isOpaque = raw.endsWith("/");
        const key = toGitKey(isOpaque ? raw.slice(0, -1) : raw);
        if (key.length === 0) {
            continue;
        }

        if (isOpaque) {
            opaqueDirs.add(key);
        } else {
            // Submodules show up as a plain entry too; the walk recognizes
            // them by finding a directory where `files` expects a file.
            files.add(key);
        }

        let slash = key.lastIndexOf("/");
        while (slash > 0) {
            const parent = key.slice(0, slash);
            if (dirs.has(parent)) {
                break; // Its ancestors were recorded by an earlier entry.
            }
            dirs.add(parent);
            slash = parent.lastIndexOf("/");
        }
    }

    return { files, dirs, opaqueDirs };
}

/**
 * Normalize a root-relative path into the form git prints: forward slashes,
 * and NFC so a decomposed name from the filesystem (macOS can hand back
 * either form) still matches git's precomposed output.
 */
function toGitKey(relPath: string): string {
    return relPath.split(path.sep).join("/").normalize("NFC");
}

/**
 * Walk the project, collecting absolute file paths. Symlinks are skipped
 * outright so the walk cannot loop or wander outside `root`.
 *
 * Inside a git work tree the project's ignore rules are applied on top of the
 * hard-coded ones (see `ScanOptions.respectGitignore`): a file must survive
 * both to be listed. Files are still only ever taken from the walk, so a
 * tracked file that has been deleted from disk never appears.
 */
export async function scanProject(
    root: string,
    options: ScanOptions = {},
): Promise<{ files: string[]; skippedDirs: string[] }> {
    const absRoot = path.resolve(root);
    const files: string[] = [];
    const skippedDirs: string[] = [];

    const gitFilter = options.respectGitignore === false ? null : await loadGitFileFilter(absRoot);

    const recordSkip = (dir: string): void => {
        skippedDirs.push(path.relative(absRoot, dir));
    };

    // One limiter for the entire walk, not one per level: per-level limits
    // multiply with depth and would not actually bound open handles.
    const limit = createLimiter(MAX_CONCURRENT_READDIRS);

    // `filtered` is false outside a repo and below an opaque directory, where
    // only the hard-coded rules apply.
    async function walk(dir: string, depth: number, filtered: boolean): Promise<void> {
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

        const subdirs: { path: string; filtered: boolean }[] = [];

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const gitKey = filtered ? toGitKey(path.relative(absRoot, fullPath)) : "";

            // Checked before isDirectory()/isFile(), both of which are false for links.
            if (entry.isSymbolicLink()) {
                continue;
            }

            if (entry.isDirectory()) {
                if (IGNORED_DIRS.has(entry.name) || entry.name === TYR_DIR) {
                    recordSkip(fullPath);
                    continue;
                }
                let childFiltered = filtered;
                if (filtered && gitFilter !== null) {
                    if (gitFilter.opaqueDirs.has(gitKey) || gitFilter.files.has(gitKey)) {
                        // Submodule or nested repo: outside the outer repo's say.
                        childFiltered = false;
                    } else if (!gitFilter.dirs.has(gitKey)) {
                        // Git lists nothing below here — the directory is
                        // ignored or empty — so walking it cannot add a file.
                        // Not recorded in skippedDirs, which stays limited to
                        // the hard-coded rules and unreadable directories.
                        continue;
                    }
                }
                if (depth + 1 > MAX_DEPTH) {
                    recordSkip(fullPath);
                    continue;
                }
                subdirs.push({ path: fullPath, filtered: childFiltered });
            } else if (entry.isFile()) {
                if (
                    IGNORED_FILES.has(entry.name) ||
                    IGNORED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
                ) {
                    continue;
                }
                if (filtered && gitFilter !== null && !gitFilter.files.has(gitKey)) {
                    continue; // Ignored by .gitignore / info/exclude / global excludes.
                }
                files.push(fullPath);
            }
        }

        // Fan out across siblings; the shared arrays are safe because Node runs
        // these callbacks on a single thread. Pending walks cost only memory —
        // the limiter decides how many of them are touching the disk at once.
        await Promise.all(subdirs.map((sub) => walk(sub.path, depth + 1, sub.filtered)));
    }

    await walk(absRoot, 0, gitFilter !== null);

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
