import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { verifyCommands, type SpawnResult, type Spawner } from "../cli/core/verify-commands.js";
import type { CommandKind, ProjectCommand, ProjectProfile } from "../cli/core/types.js";
import { makeProject, removeProject } from "./helpers.js";

type Commands = Pick<ProjectProfile, CommandKind>;

function cmd(command: string, tool = "tool"): ProjectCommand {
    return { tool, command, evidence: "package.json" };
}

function profile(partial: Partial<Commands>): Commands {
    return { build: null, test: null, lint: null, format: null, typecheck: null, ...partial };
}

/** Make `relative` under root an executable file. */
async function makeExecutable(root: string, relative: string, body = "#!/bin/sh\nexit 0\n"): Promise<string> {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body, "utf8");
    await fs.chmod(file, 0o755);
    return file;
}

interface SpawnCall {
    file: string;
    args: readonly string[];
    cwd: string;
}

/** A spawner that records calls and answers with `result` (or a function of the call). */
function fakeSpawn(result: Partial<SpawnResult> | ((call: SpawnCall) => Partial<SpawnResult>) = {}) {
    const calls: SpawnCall[] = [];
    const spawn: Spawner = async (file, args, { cwd }) => {
        const call = { file, args, cwd };
        calls.push(call);
        const partial = typeof result === "function" ? result(call) : result;
        return { code: 0, stdout: "", stderr: "", timedOut: false, ...partial };
    };
    return { spawn, calls };
}

async function withProject(
    files: Record<string, string>,
    body: (root: string) => Promise<void>,
): Promise<void> {
    const root = await makeProject(files);
    try {
        await body(root);
    } finally {
        await removeProject(root);
    }
}

const PKG = JSON.stringify({ scripts: { build: "tsc", test: "jest" } });

/* -------------------------------------------------------------------------
 * npm scripts
 * ---------------------------------------------------------------------- */

test("script present and package manager on PATH is ok, without spawning", async () => {
    await withProject({ "package.json": PKG }, async (root) => {
        await makeExecutable(root, "fakebin/npm");
        const { spawn, calls } = fakeSpawn();
        const result = await verifyCommands(
            root,
            profile({ build: cmd("npm run build"), test: cmd("npm test") }),
            { path: path.join(root, "fakebin"), spawn },
        );
        assert.equal(result.build?.status, "ok");
        assert.equal(result.test?.status, "ok");
        assert.match(result.build!.detail, /"build"/);
        assert.equal(result.lint, null);
        assert.equal(calls.length, 0);
    });
});

test("missing script is reported as missing", async () => {
    await withProject({ "package.json": PKG }, async (root) => {
        await makeExecutable(root, "fakebin/pnpm");
        const result = await verifyCommands(root, profile({ lint: cmd("pnpm run lint") }), {
            path: path.join(root, "fakebin"),
        });
        assert.equal(result.lint?.status, "missing");
        assert.match(result.lint!.detail, /script "lint" not found/);
    });
});

test("package manager absent from PATH is reported as missing", async () => {
    await withProject({ "package.json": PKG }, async (root) => {
        const result = await verifyCommands(root, profile({ build: cmd("yarn run build") }), {
            path: path.join(root, "empty"),
        });
        assert.equal(result.build?.status, "missing");
        assert.match(result.build!.detail, /yarn not found on PATH/);
    });
});

test("no package.json makes a script command missing", async () => {
    await withProject({}, async (root) => {
        await makeExecutable(root, "fakebin/npm");
        const result = await verifyCommands(root, profile({ build: cmd("npm run build") }), {
            path: path.join(root, "fakebin"),
        });
        assert.equal(result.build?.status, "missing");
    });
});

/* -------------------------------------------------------------------------
 * Tool resolution
 * ---------------------------------------------------------------------- */

test("npx tool resolves from local node_modules/.bin before PATH", async () => {
    await withProject({}, async (root) => {
        const local = await makeExecutable(root, "node_modules/.bin/eslint");
        await makeExecutable(root, "fakebin/eslint");
        const { spawn, calls } = fakeSpawn({ stdout: "v9.1.0\n" });
        const result = await verifyCommands(root, profile({ lint: cmd("npx eslint .") }), {
            path: path.join(root, "fakebin"),
            spawn,
        });
        assert.equal(result.lint?.status, "ok");
        assert.equal(result.lint?.detail, "v9.1.0 (node_modules/.bin)");
        assert.deepEqual(calls, [{ file: local, args: ["--version"], cwd: root }]);
    });
});

test("bare tool resolves from PATH", async () => {
    await withProject({}, async (root) => {
        const binDir = path.join(root, "fakebin");
        const pytest = await makeExecutable(root, "fakebin/pytest");
        const { spawn, calls } = fakeSpawn({ stdout: "pytest 8.2.0" });
        const result = await verifyCommands(root, profile({ test: cmd("pytest") }), {
            path: [path.join(root, "nothing-here"), binDir].join(":"),
            spawn,
        });
        assert.equal(result.test?.status, "ok");
        assert.match(result.test!.detail, /pytest 8\.2\.0 \(PATH\)/);
        assert.equal(calls[0].file, pytest);
    });
});

test("non-executable files on PATH are not matches", async () => {
    await withProject({ "fakebin/ruff": "not executable" }, async (root) => {
        const result = await verifyCommands(root, profile({ lint: cmd("ruff check .") }), {
            path: path.join(root, "fakebin"),
            spawn: fakeSpawn().spawn,
        });
        assert.equal(result.lint?.status, "missing");
    });
});

test("Windows lookup applies PATHEXT", async () => {
    await withProject({}, async (root) => {
        await makeExecutable(root, "fakebin/cargo.EXE");
        const { spawn, calls } = fakeSpawn({ stdout: "cargo 1.80.0" });
        const result = await verifyCommands(root, profile({ test: cmd("cargo test") }), {
            path: path.join(root, "fakebin"),
            pathExt: ".COM;.EXE",
            platform: "win32",
            spawn,
        });
        assert.equal(result.test?.status, "ok");
        assert.equal(path.basename(calls[0].file), "cargo.EXE");
    });
});

test("missing executable is reported as missing without spawning", async () => {
    await withProject({}, async (root) => {
        const { spawn, calls } = fakeSpawn();
        const result = await verifyCommands(
            root,
            profile({ lint: cmd("npx eslint ."), typecheck: cmd("mypy .") }),
            { path: path.join(root, "empty"), spawn },
        );
        assert.equal(result.lint?.status, "missing");
        assert.match(result.lint!.detail, /eslint not installed/);
        assert.equal(result.typecheck?.status, "missing");
        assert.match(result.typecheck!.detail, /mypy not found on PATH/);
        assert.equal(calls.length, 0);
    });
});

/* -------------------------------------------------------------------------
 * Probe outcomes
 * ---------------------------------------------------------------------- */

test("non-zero probe exit is reported as failed with the reason", async () => {
    await withProject({}, async (root) => {
        await makeExecutable(root, "fakebin/black");
        const { spawn } = fakeSpawn({ code: 1, stderr: "\nImportError: broken venv\n" });
        const result = await verifyCommands(root, profile({ format: cmd("black .") }), {
            path: path.join(root, "fakebin"),
            spawn,
        });
        assert.equal(result.format?.status, "failed");
        assert.match(result.format!.detail, /exited with code 1: ImportError: broken venv/);
    });
});

test("probe timeout is reported as failed", async () => {
    await withProject({}, async (root) => {
        await makeExecutable(root, "fakebin/mvn");
        const { spawn } = fakeSpawn({ code: null, timedOut: true });
        const result = await verifyCommands(root, profile({ build: cmd("mvn package") }), {
            path: path.join(root, "fakebin"),
            spawn,
            timeoutMs: 250,
        });
        assert.equal(result.build?.status, "failed");
        assert.match(result.build!.detail, /timed out after 250ms/);
    });
});

test("tool-specific probe args, resolve-only tools, and probe: false", async () => {
    await withProject({}, async (root) => {
        await makeExecutable(root, "fakebin/go");
        await makeExecutable(root, "fakebin/gofmt");
        await makeExecutable(root, "fakebin/tsc");
        const { spawn, calls } = fakeSpawn({ stdout: "go version go1.22" });
        const options = { path: path.join(root, "fakebin"), spawn };

        const result = await verifyCommands(
            root,
            profile({ build: cmd("go build ./..."), test: cmd("go test ./..."), format: cmd("gofmt -w .") }),
            options,
        );
        assert.equal(result.build?.status, "ok");
        assert.equal(result.test?.status, "ok");
        assert.equal(result.format?.status, "ok");
        // Both go commands share one `go version` probe; gofmt is never spawned.
        assert.deepEqual(calls.map((call) => call.args), [["version"]]);

        const noProbe = await verifyCommands(root, profile({ typecheck: cmd("tsc --noEmit") }), {
            ...options,
            probe: false,
        });
        assert.equal(noProbe.typecheck?.status, "ok");
        assert.equal(calls.length, 1);
    });
});

test("commands needing a shell or of unknown shape are skipped", async () => {
    await withProject({ "package.json": PKG }, async (root) => {
        const { spawn, calls } = fakeSpawn();
        const result = await verifyCommands(
            root,
            profile({
                build: cmd("make && make install"),
                test: cmd("CI=1 pytest"),
                lint: cmd("npm exec eslint"),
                format: cmd("npx"),
                typecheck: cmd("   "),
            }),
            { path: "", spawn },
        );
        for (const kind of ["build", "test", "lint", "format", "typecheck"] as const) {
            assert.equal(result[kind]?.status, "skipped", kind);
        }
        assert.equal(calls.length, 0);
    });
});

test("never throws, even when the spawner does", async () => {
    await withProject({}, async (root) => {
        await makeExecutable(root, "fakebin/cargo");
        const spawn: Spawner = async () => {
            throw new Error("boom");
        };
        const result = await verifyCommands(root, profile({ build: cmd("cargo build") }), {
            path: path.join(root, "fakebin"),
            spawn,
        });
        assert.equal(result.build?.status, "failed");
        assert.match(result.build!.detail, /boom/);

        // A root that does not exist is just as survivable.
        const gone = await verifyCommands(path.join(root, "does-not-exist"), profile({
            build: cmd("npm run build"),
            test: cmd("pytest"),
        }), { path: "" });
        assert.equal(gone.build?.status, "missing");
        assert.equal(gone.test?.status, "missing");
    });
});

/* -------------------------------------------------------------------------
 * Default spawner (real processes; POSIX shell scripts)
 * ---------------------------------------------------------------------- */

const posixOnly = { skip: process.platform === "win32" ? "needs /bin/sh" : false };

test("real spawner reads the version line", posixOnly, async () => {
    await withProject({}, async (root) => {
        await makeExecutable(root, "fakebin/fmt-tool", "#!/bin/sh\necho \"fmt-tool 1.2.3\"\n");
        const result = await verifyCommands(root, profile({ format: cmd("fmt-tool .") }), {
            path: path.join(root, "fakebin"),
        });
        assert.equal(result.format?.status, "ok");
        assert.equal(result.format?.detail, "fmt-tool 1.2.3 (PATH)");
    });
});

test("real spawner kills a hung probe at the timeout", posixOnly, async () => {
    await withProject({}, async (root) => {
        await makeExecutable(root, "fakebin/slow-tool", "#!/bin/sh\nexec sleep 30\n");
        const started = Date.now();
        const result = await verifyCommands(root, profile({ test: cmd("slow-tool") }), {
            path: path.join(root, "fakebin"),
            timeoutMs: 200,
        });
        assert.equal(result.test?.status, "failed");
        assert.match(result.test!.detail, /timed out after 200ms/);
        assert.ok(Date.now() - started < 5000);
    });
});
