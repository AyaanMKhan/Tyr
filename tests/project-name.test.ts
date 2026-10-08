// Project name detection (project.ts) and its use in tyr.json (scaffold.ts).

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import { detectProjectName, profileProject } from "../cli/core/project.js";
import { buildConfig } from "../cli/core/scaffold.js";
import { InitSnapshot, ProjectProfile } from "../cli/core/types.js";
import { makeProject, removeProject } from "./helpers.js";

/** Detect the name of a throwaway project built from `files`. */
async function nameOf(files: Record<string, string>) {
    const root = await makeProject(files);
    try {
        return await detectProjectName(root);
    } finally {
        await removeProject(root);
    }
}

const NONE = { name: null, nameSource: null };

/* -------------------------------------------------------------------------
 * detectProjectName
 * ---------------------------------------------------------------------- */

test("package.json name wins over other manifests", async () => {
    const result = await nameOf({
        "package.json": JSON.stringify({ name: "web-app" }),
        "pyproject.toml": '[project]\nname = "py-app"\n',
        "Cargo.toml": '[package]\nname = "rs-app"\n',
    });
    assert.deepEqual(result, { name: "web-app", nameSource: "package.json" });
});

test("pyproject [project] name", async () => {
    const result = await nameOf({
        "pyproject.toml": [
            "[build-system]",
            'requires = ["hatchling"]',
            "",
            "[project]",
            'name = "py-app"  # PEP 621',
            'version = "0.1.0"',
            "",
            "[project.urls]",
            'name = "not-this"',
        ].join("\n"),
    });
    assert.deepEqual(result, { name: "py-app", nameSource: "pyproject.toml" });
});

test("pyproject [tool.poetry] name when [project] has none", async () => {
    const result = await nameOf({
        "pyproject.toml": "[project]\ndynamic = [\"version\"]\n\n[tool.poetry]\nname = 'poetry-app'\n",
    });
    assert.deepEqual(result, { name: "poetry-app", nameSource: "pyproject.toml" });
});

test("Cargo.toml [package] name", async () => {
    const result = await nameOf({
        "Cargo.toml": '[package]\nname = "rs-app"\nversion = "0.1.0"\n\n[[bin]]\nname = "other"\n',
    });
    assert.deepEqual(result, { name: "rs-app", nameSource: "Cargo.toml" });
});

test("Cargo workspace-inherited name is not a usable name", async () => {
    assert.deepEqual(await nameOf({ "Cargo.toml": "[package]\nname.workspace = true\n" }), NONE);
});

test("malformed package.json falls through to the next manifest", async () => {
    const result = await nameOf({
        "package.json": "{ not json",
        "Cargo.toml": '[package]\nname = "rs-app"\n',
    });
    assert.deepEqual(result, { name: "rs-app", nameSource: "Cargo.toml" });
});

test("empty and non-string names are ignored", async () => {
    assert.deepEqual(await nameOf({ "package.json": JSON.stringify({ name: "  " }) }), NONE);
    assert.deepEqual(
        await nameOf({
            "package.json": JSON.stringify({ name: 42 }),
            "pyproject.toml": '[project]\nname = ""\n',
        }),
        NONE,
    );
});

test("no manifest yields null", async () => {
    assert.deepEqual(await nameOf({ "main.go": "package main\n" }), NONE);
});

test("profileProject carries the name through", async () => {
    const root = await makeProject({ "package.json": JSON.stringify({ name: "web-app" }) });
    try {
        const profile = await profileProject(root, [path.join(root, "package.json")]);
        assert.equal(profile.name, "web-app");
        assert.equal(profile.nameSource, "package.json");
    } finally {
        await removeProject(root);
    }
});

/* -------------------------------------------------------------------------
 * buildConfig
 * ---------------------------------------------------------------------- */

function snapshotWith(root: string, project: Partial<ProjectProfile>): InitSnapshot {
    return {
        discovery: { root, alreadyInitialized: false, files: [], fileCount: 0, skippedDirs: [] },
        git: {
            isRepo: false,
            branch: null,
            detached: false,
            headCommit: null,
            status: null,
            remotes: [],
            defaultRemote: null,
        },
        project: {
            name: null,
            nameSource: null,
            languages: [],
            primaryLanguage: null,
            frameworks: [],
            packageManager: null,
            build: null,
            test: null,
            lint: null,
            format: null,
            typecheck: null,
            readme: null,
            claudeMd: null,
            ...project,
        },
    };
}

test("buildConfig uses the manifest name", () => {
    const root = path.resolve("/tmp/some-dir");
    const config = buildConfig(snapshotWith(root, { name: "web-app", nameSource: "package.json" }), "1.0.0");
    assert.equal(config.project.name, "web-app");
});

test("buildConfig falls back to the directory basename", () => {
    const config = buildConfig(snapshotWith(path.resolve("/tmp/some-dir"), {}), "1.0.0");
    assert.equal(config.project.name, "some-dir");
});
