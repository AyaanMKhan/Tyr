// Shared fixtures for the node:test suites. Tests are compiled with
// tsconfig.test.json into .test-build/ and run by `npm test`.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

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
