// Shared fixtures for the node:test suites. Tests are compiled with
// tsconfig.test.json into .test-build/ and run by `npm test`.

import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Fixtures live under os.tmpdir(). If a directory above it is itself a git
// repository (a home directory under version control, say), git would
// discover it and "not a repository" fixtures would silently become repos.
// The ceiling stops git's upward search at the temp dir; repos created
// inside a fixture are below it and still found. Inherited by spawned git.
process.env.GIT_CEILING_DIRECTORIES = realpathSync.native(os.tmpdir());

// Fixture repos must behave the same on every machine. Git for Windows
// installs with core.autocrlf=true, which rewrites "a\n" as "a\r\n" on
// checkout and breaks byte-for-byte assertions. GIT_CONFIG_COUNT entries
// override every config file (git >= 2.31) without touching the user's own
// config, and are inherited by every git (and tyr) process the tests spawn.
// A fixed identity and no signing let fixtures commit on a bare CI runner
// (no user.name) and on machines that sign every commit.
const GIT_TEST_CONFIG: [string, string][] = [
    ["core.autocrlf", "false"],
    ["user.name", "Tyr Tests"],
    ["user.email", "tests@tyr.invalid"],
    ["commit.gpgsign", "false"],
];
process.env.GIT_CONFIG_COUNT = String(GIT_TEST_CONFIG.length);
GIT_TEST_CONFIG.forEach(([key, value], index) => {
    process.env[`GIT_CONFIG_KEY_${index}`] = key;
    process.env[`GIT_CONFIG_VALUE_${index}`] = value;
});

/**
 * Create a throwaway project directory populated with `files`
 * (root-relative path -> contents). Returns its absolute, real path.
 */
export async function makeProject(files: Record<string, string>): Promise<string> {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tyr-test-")));
    for (const [relative, contents] of Object.entries(files)) {
        const target = path.join(root, relative);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, contents, "utf8");
    }
    return root;
}

/**
 * Delete a fixture. On Windows a directory cannot be removed while any
 * handle inside it is open, and a watcher or child process that was just
 * closed or killed can hold one for a moment longer: retry for a few
 * seconds (fs.rm backs off linearly). If it is still busy after that, leave
 * the temp dir behind rather than fail a test that passed: a stray folder
 * under %TEMP% is not a bug in the code under test.
 */
export async function removeProject(root: string): Promise<void> {
    try {
        await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (process.platform === "win32" && (code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY")) return;
        throw error;
    }
}
