// tyr.json `commands` section (scaffold.ts buildConfig).

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import { buildConfig } from "../cli/core/scaffold.js";
import { InitSnapshot, ProjectProfile } from "../cli/core/types.js";

function snapshotWith(project: Partial<ProjectProfile>): InitSnapshot {
    return {
        discovery: {
            root: path.resolve("/tmp/app"),
            alreadyInitialized: false,
            files: [],
            fileCount: 0,
            skippedDirs: [],
        },
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

test("buildConfig keeps command, tool and evidence for every kind", () => {
    const commands = {
        build: { tool: "tsc", command: "npm run build", evidence: "package.json" },
        test: { tool: "Jest", command: "npm run test", evidence: "jest.config.js" },
        lint: { tool: "ESLint", command: "npx eslint .", evidence: ".eslintrc.json" },
        format: { tool: "Prettier", command: "npx prettier --check .", evidence: ".prettierrc" },
        typecheck: { tool: "tsc", command: "npx tsc --noEmit", evidence: "tsconfig.json" },
    };
    const config = buildConfig(snapshotWith(commands), "1.0.0");

    for (const kind of ["build", "test", "lint", "format", "typecheck"] as const) {
        assert.deepEqual(config.commands[kind], {
            command: commands[kind].command,
            tool: commands[kind].tool,
            evidence: commands[kind].evidence,
        });
    }
});

test("buildConfig records undetected commands as null", () => {
    const config = buildConfig(
        snapshotWith({ test: { tool: "pytest", command: "pytest", evidence: "pyproject.toml" } }),
        "1.0.0",
    );
    assert.equal(config.commands.build, null);
    assert.equal(config.commands.lint, null);
    assert.equal(config.commands.format, null);
    assert.equal(config.commands.typecheck, null);
    assert.deepEqual(config.commands.test, { command: "pytest", tool: "pytest", evidence: "pyproject.toml" });
});

test("command entries carry no extra keys into tyr.json", () => {
    const extra = { tool: "Vitest", command: "npm test", evidence: "package.json", internal: true };
    const config = buildConfig(snapshotWith({ test: extra }), "1.0.0");
    assert.deepEqual(Object.keys(config.commands.test ?? {}).sort(), ["command", "evidence", "tool"]);
});
