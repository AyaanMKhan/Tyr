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

export async function removeProject(root: string): Promise<void> {
    await fs.rm(root, { recursive: true, force: true });
}
