import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import { detectWorkspaces } from "../cli/core/workspaces.js";
import { profileProject } from "../cli/core/project.js";
import type { WorkspaceInfo } from "../cli/core/types.js";
import { makeProject, removeProject } from "./helpers.js";

/**
 * Build a fixture, then run detection with the absolute file list discovery
 * would hand over — every fixture file counts as scanned.
 */
async function detect(files: Record<string, string>): Promise<WorkspaceInfo | null> {
    const root = await makeProject(files);
    try {
        const scanned = Object.keys(files).map((file) => path.join(root, file));
        return await detectWorkspaces(root, scanned);
    } finally {
        await removeProject(root);
    }
}

function paths(info: WorkspaceInfo | null): string[] {
    return info === null ? [] : info.packages.map((pkg) => pkg.path);
}

const pkg = (name: string): string => JSON.stringify({ name });

/* -------------------------------------------------------------------------
 * npm / yarn
 * ---------------------------------------------------------------------- */

test("npm workspaces array form resolves globs to packages", async () => {
    const info = await detect({
        "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*", "apps/web"] }),
        "packages/a/package.json": pkg("@x/a"),
        "packages/b/package.json": pkg("@x/b"),
        "apps/web/package.json": pkg("web"),
        "apps/docs/package.json": pkg("docs"),
    });
    assert.equal(info?.tool, "npm");
    assert.equal(info?.evidence, "package.json");
    assert.deepEqual(info?.packages, [
        { name: "web", path: "apps/web", manifest: "apps/web/package.json" },
        { name: "@x/a", path: "packages/a", manifest: "packages/a/package.json" },
        { name: "@x/b", path: "packages/b", manifest: "packages/b/package.json" },
    ]);
});

test("npm workspaces object form and ** globs", async () => {
    const info = await detect({
        "package.json": JSON.stringify({ workspaces: { packages: ["apps/**"] } }),
        "apps/one/package.json": pkg("one"),
        "apps/group/two/package.json": pkg("two"),
    });
    assert.equal(info?.tool, "npm");
    assert.deepEqual(paths(info), ["apps/group/two", "apps/one"]);
});

test("yarn is reported when a yarn.lock sits beside the workspaces", async () => {
    const info = await detect({
        "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
        "yarn.lock": "",
        "packages/a/package.json": pkg("a"),
    });
    assert.equal(info?.tool, "yarn");
    assert.deepEqual(paths(info), ["packages/a"]);
});

test("yarn is reported from the packageManager field", async () => {
    const info = await detect({
        "package.json": JSON.stringify({ packageManager: "yarn@4.1.0", workspaces: ["packages/*"] }),
        "packages/a/package.json": pkg("a"),
    });
    assert.equal(info?.tool, "yarn");
});

test("globs only match directories that hold a manifest", async () => {
    const info = await detect({
        "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
        "packages/real/package.json": pkg("real"),
        "packages/empty/README.md": "# nothing here",
        "packages/rusty/Cargo.toml": '[package]\nname = "rusty"\n',
    });
    assert.deepEqual(paths(info), ["packages/real"]);
});

test("negated patterns remove members", async () => {
    const info = await detect({
        "package.json": JSON.stringify({ workspaces: ["packages/*", "!packages/legacy"] }),
        "packages/a/package.json": pkg("a"),
        "packages/legacy/package.json": pkg("legacy"),
    });
    assert.deepEqual(paths(info), ["packages/a"]);
});

/* -------------------------------------------------------------------------
 * pnpm
 * ---------------------------------------------------------------------- */

test("pnpm-workspace.yaml with quotes, comments and negation", async () => {
    const info = await detect({
        "package.json": pkg("root"),
        "pnpm-workspace.yaml": [
            "# workspace layout",
            "packages:",
            "  # the libraries",
            "  - 'packages/*'",
            '  - "apps/*" # deployables',
            "  - tools/cli",
            "  - '!packages/internal'",
            "",
            "catalog:",
            "  react: ^18.0.0",
            "",
        ].join("\n"),
        "packages/ui/package.json": pkg("@x/ui"),
        "packages/internal/package.json": pkg("@x/internal"),
        "apps/site/package.json": pkg("site"),
        "tools/cli/package.json": pkg("cli"),
    });
    assert.equal(info?.tool, "pnpm");
    assert.equal(info?.evidence, "pnpm-workspace.yaml");
    assert.deepEqual(paths(info), ["apps/site", "packages/ui", "tools/cli"]);
});

test("pnpm flow-style list", async () => {
    const info = await detect({
        "pnpm-workspace.yaml": "packages: ['packages/*', \"libs/*\"]\n",
        "packages/a/package.json": pkg("a"),
        "libs/b/package.json": pkg("b"),
    });
    assert.equal(info?.tool, "pnpm");
    assert.deepEqual(paths(info), ["libs/b", "packages/a"]);
});

test("pnpm declaration outranks package.json workspaces", async () => {
    const info = await detect({
        "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
        "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
        "packages/a/package.json": pkg("a"),
    });
    assert.equal(info?.tool, "pnpm");
});

/* -------------------------------------------------------------------------
 * Cargo
 * ---------------------------------------------------------------------- */

test("cargo workspace with multi-line members, comments and exclude", async () => {
    const info = await detect({
        "Cargo.toml": [
            "[workspace]",
            "resolver = \"2\"",
            "members = [",
            '    "crates/*", # every crate',
            "    # the binary",
            '    "bin/tool",',
            "]",
            'exclude = ["crates/scratch"]',
            "",
            "[workspace.dependencies]",
            'serde = "1"',
            "",
        ].join("\n"),
        "crates/core/Cargo.toml": '[package]\nname = "core"\nversion = "0.1.0"\n',
        "crates/macros/Cargo.toml": "[package]\nname = 'macros'\n",
        "crates/scratch/Cargo.toml": '[package]\nname = "scratch"\n',
        "bin/tool/Cargo.toml": '[package]\nname = "tool"\n',
    });
    assert.equal(info?.tool, "cargo");
    assert.equal(info?.evidence, "Cargo.toml");
    assert.deepEqual(info?.packages, [
        { name: "tool", path: "bin/tool", manifest: "bin/tool/Cargo.toml" },
        { name: "core", path: "crates/core", manifest: "crates/core/Cargo.toml" },
        { name: "macros", path: "crates/macros", manifest: "crates/macros/Cargo.toml" },
    ]);
});

test("cargo root package is a member of its own workspace", async () => {
    const info = await detect({
        "Cargo.toml": '[package]\nname = "app"\n\n[workspace]\nmembers = ["crates/*"]\n',
        "crates/util/Cargo.toml": '[package]\nname = "util"\n',
    });
    assert.deepEqual(info?.packages, [
        { name: "app", path: ".", manifest: "Cargo.toml" },
        { name: "util", path: "crates/util", manifest: "crates/util/Cargo.toml" },
    ]);
});

/* -------------------------------------------------------------------------
 * Nested packages
 * ---------------------------------------------------------------------- */

test("nested manifests without a declaration are reported as nested", async () => {
    const info = await detect({
        "README.md": "# polyglot",
        "frontend/package.json": pkg("frontend"),
        "backend/pyproject.toml": '[project]\nname = "backend"\n',
        "services/api/go.mod": "module example.com/api\n\ngo 1.22\n",
        "services/api/main.go": "package main\n",
        "tests/fixtures/sample/package.json": pkg("fixture"),
    });
    assert.equal(info?.tool, "nested");
    assert.deepEqual(info?.packages, [
        { name: "backend", path: "backend", manifest: "backend/pyproject.toml" },
        { name: "frontend", path: "frontend", manifest: "frontend/package.json" },
        { name: "example.com/api", path: "services/api", manifest: "services/api/go.mod" },
    ]);
});

test("nested scan only sees files discovery handed over", async () => {
    const root = await makeProject({
        "package.json": pkg("root"),
        "node_modules/dep/package.json": pkg("dep"),
    });
    try {
        // Discovery filtered node_modules out, so it is not in the list.
        const info = await detectWorkspaces(root, [path.join(root, "package.json")]);
        assert.equal(info, null);
    } finally {
        await removeProject(root);
    }
});

/* -------------------------------------------------------------------------
 * Negative cases
 * ---------------------------------------------------------------------- */

test("plain single-package repo is not a workspace", async () => {
    const info = await detect({
        "package.json": pkg("solo"),
        "src/index.ts": "export {};\n",
    });
    assert.equal(info, null);
});

test("malformed manifests degrade to null without throwing", async () => {
    assert.equal(await detect({ "package.json": "{ not json" }), null);
    assert.equal(await detect({ "package.json": JSON.stringify({ workspaces: "packages/*" }) }), null);
    assert.equal(await detect({ "package.json": "[1, 2]" }), null);
    assert.equal(await detect({ "pnpm-workspace.yaml": "packages: nope\n" }), null);
    assert.equal(await detect({ "pnpm-workspace.yaml": "packages: ['unterminated\n" }), null);
    assert.equal(await detect({ "Cargo.toml": "[workspace\nmembers = [\n" }), null);
    assert.equal(await detect({ "Cargo.toml": '[workspace]\nmembers = ["../outside", "/abs"]\n' }), null);
});

test("malformed member manifest keeps the package with a null name", async () => {
    const info = await detect({
        "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
        "packages/broken/package.json": "{",
    });
    assert.deepEqual(info?.packages, [
        { name: null, path: "packages/broken", manifest: "packages/broken/package.json" },
    ]);
});

test("declaration that matches nothing is not a workspace", async () => {
    const info = await detect({
        "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
    });
    assert.equal(info, null);
});

/* -------------------------------------------------------------------------
 * Profile wiring
 * ---------------------------------------------------------------------- */

test("profileProject carries the workspace", async () => {
    const files = {
        "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
        "packages/a/package.json": pkg("a"),
    };
    const root = await makeProject(files);
    try {
        const profile = await profileProject(
            root,
            Object.keys(files).map((file) => path.join(root, file)),
        );
        assert.equal(profile.workspace?.tool, "npm");
        assert.deepEqual(paths(profile.workspace), ["packages/a"]);
    } finally {
        await removeProject(root);
    }
});
