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

/** Directories we never walk into when scanning a project. */
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
    ".DS_Store",
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
    "bin",
    "obj",
    "Pods",
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

    async function walk(dir: string, depth: number): Promise<void> {
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
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
                if (!IGNORED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
                    files.push(fullPath);
                }
            }
        }

        // Fan out across siblings; the shared arrays are safe because Node runs
        // these callbacks on a single thread.
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

async function pathExists(target: string): Promise<boolean> {
    try {
        await fs.access(target);
        return true;
    } catch {
        return false;
    }
}
