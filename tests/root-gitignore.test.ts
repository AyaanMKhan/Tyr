import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PassThrough } from "node:stream";

import {
    appendTyrEntry,
    applyGitignorePolicy,
    ensureTyrIgnored,
    GITIGNORE_MESSAGES,
    isTyrIgnored,
    readRootGitignore,
    type GitignorePolicy,
} from "../cli/core/root-gitignore.js";
import { confirm } from "../cli/ui/prompt.js";
import { makeProject, removeProject } from "./helpers.js";

async function readGitignore(root: string): Promise<string> {
    return fs.readFile(path.join(root, ".gitignore"), "utf8");
}

function policy(partial: Partial<GitignorePolicy>): GitignorePolicy {
    return {
        flag: undefined,
        isRepo: true,
        interactive: true,
        ask: async () => {
            throw new Error("ask should not be called");
        },
        ...partial,
    };
}

test("isTyrIgnored accepts the common spellings", () => {
    for (const line of ["/.tyr/", ".tyr/", ".tyr", "/.tyr", ".tyr/*", "/.tyr/**"]) {
        assert.equal(isTyrIgnored(`node_modules/\n${line}\n`), true, line);
    }
});

test("isTyrIgnored tolerates CRLF and trailing whitespace", () => {
    assert.equal(isTyrIgnored("dist/\r\n.tyr/\r\n"), true);
    assert.equal(isTyrIgnored("dist/\n/.tyr/   \t\n"), true);
    assert.equal(isTyrIgnored("/.tyr/"), true);
});

test("isTyrIgnored rejects partial, commented and negated entries", () => {
    assert.equal(isTyrIgnored(null), false);
    assert.equal(isTyrIgnored(""), false);
    assert.equal(isTyrIgnored("# .tyr/\n"), false);
    assert.equal(isTyrIgnored("!.tyr/\n"), false);
    assert.equal(isTyrIgnored(".tyr/logs/\n.tyr/state/\n"), false);
    assert.equal(isTyrIgnored("src/.tyr/\n"), false);
    assert.equal(isTyrIgnored(".tyrignore\n"), false);
});

test("appendTyrEntry builds a fresh file", () => {
    assert.equal(appendTyrEntry(null), "# Tyr\n/.tyr/\n");
    assert.equal(appendTyrEntry(""), "# Tyr\n/.tyr/\n");
});

test("appendTyrEntry adds a missing trailing newline and a blank separator", () => {
    assert.equal(appendTyrEntry("dist/"), "dist/\n\n# Tyr\n/.tyr/\n");
    assert.equal(appendTyrEntry("dist/\n"), "dist/\n\n# Tyr\n/.tyr/\n");
    assert.equal(appendTyrEntry("dist/\n\n"), "dist/\n\n# Tyr\n/.tyr/\n");
});

test("appendTyrEntry preserves CRLF line endings", () => {
    assert.equal(appendTyrEntry("dist/\r\nnode_modules/"), "dist/\r\nnode_modules/\r\n\r\n# Tyr\r\n/.tyr/\r\n");
    assert.equal(appendTyrEntry("dist/\r\n"), "dist/\r\n\r\n# Tyr\r\n/.tyr/\r\n");
});

test("ensureTyrIgnored creates a missing .gitignore", async () => {
    const root = await makeProject({});
    try {
        assert.equal(await readRootGitignore(root), null);
        assert.equal(await ensureTyrIgnored(root), "added");
        assert.equal(await readGitignore(root), "# Tyr\n/.tyr/\n");
    } finally {
        await removeProject(root);
    }
});

test("ensureTyrIgnored leaves an already-covered file untouched", async () => {
    for (const contents of ["/.tyr/\n", ".tyr\r\n", "dist/\n.tyr/  "]) {
        const root = await makeProject({ ".gitignore": contents });
        try {
            assert.equal(await ensureTyrIgnored(root), "present");
            assert.equal(await readGitignore(root), contents);
        } finally {
            await removeProject(root);
        }
    }
});

test("ensureTyrIgnored appends to a CRLF file without a trailing newline", async () => {
    const root = await makeProject({ ".gitignore": "node_modules/\r\ndist/" });
    try {
        assert.equal(await ensureTyrIgnored(root), "added");
        assert.equal(await readGitignore(root), "node_modules/\r\ndist/\r\n\r\n# Tyr\r\n/.tyr/\r\n");
    } finally {
        await removeProject(root);
    }
});

test("ensureTyrIgnored is idempotent", async () => {
    const root = await makeProject({ ".gitignore": "dist/" });
    try {
        assert.equal(await ensureTyrIgnored(root), "added");
        const once = await readGitignore(root);
        assert.equal(await ensureTyrIgnored(root), "present");
        assert.equal(await readGitignore(root), once);
        // No temp files left behind by the atomic write.
        assert.deepEqual(await fs.readdir(root), [".gitignore"]);
    } finally {
        await removeProject(root);
    }
});

test("applyGitignorePolicy: --no-gitignore never writes", async () => {
    const root = await makeProject({});
    try {
        const decision = await applyGitignorePolicy(root, policy({ flag: false }));
        assert.deepEqual(decision, { outcome: "skipped", suggestFlag: false });
        assert.equal(await readRootGitignore(root), null);
    } finally {
        await removeProject(root);
    }
});

test("applyGitignorePolicy: --gitignore adds without asking, even outside git", async () => {
    const root = await makeProject({});
    try {
        const decision = await applyGitignorePolicy(root, policy({ flag: true, isRepo: false, interactive: false }));
        assert.equal(decision.outcome, "added");
        assert.equal(await readGitignore(root), "# Tyr\n/.tyr/\n");
        assert.equal((await applyGitignorePolicy(root, policy({ flag: true }))).outcome, "present");
    } finally {
        await removeProject(root);
    }
});

test("applyGitignorePolicy: asks when interactive, and respects the answer", async () => {
    const root = await makeProject({ ".gitignore": "dist/\n" });
    try {
        let asked = 0;
        const no = await applyGitignorePolicy(root, policy({ ask: async () => (asked++, false) }));
        assert.deepEqual(no, { outcome: "declined", suggestFlag: false });
        assert.equal(await readGitignore(root), "dist/\n");

        const yes = await applyGitignorePolicy(root, policy({ ask: async () => (asked++, true) }));
        assert.equal(yes.outcome, "added");
        assert.equal(asked, 2);

        // Already present: no question at all.
        assert.equal((await applyGitignorePolicy(root, policy({}))).outcome, "present");
    } finally {
        await removeProject(root);
    }
});

test("applyGitignorePolicy: non-interactive or non-repo runs never write", async () => {
    const root = await makeProject({});
    try {
        assert.deepEqual(await applyGitignorePolicy(root, policy({ interactive: false })), {
            outcome: "skipped",
            suggestFlag: true,
        });
        assert.deepEqual(await applyGitignorePolicy(root, policy({ isRepo: false })), {
            outcome: "skipped",
            suggestFlag: false,
        });
        assert.equal(await readRootGitignore(root), null);
    } finally {
        await removeProject(root);
    }
});

test("GITIGNORE_MESSAGES: sharing the config is the default, ignoring .tyr/ is the opt-in", () => {
    assert.equal(GITIGNORE_MESSAGES.defaultYes, false);
    // The question asks about ignoring all of .tyr/, so "yes" means local-only.
    assert.match(GITIGNORE_MESSAGES.question, /Keep all of \.tyr\/ out of git/);
    assert.ok(GITIGNORE_MESSAGES.question.includes("/.tyr/"));
    // The note explains what is committed and what is already ignored.
    for (const file of [".tyr/tyr.json", ".tyr/settings.json"]) {
        assert.ok(GITIGNORE_MESSAGES.note.includes(file), file);
        assert.ok(GITIGNORE_MESSAGES.hint.includes(file), file);
        assert.ok(GITIGNORE_MESSAGES.declined.includes(file), file);
    }
    assert.match(GITIGNORE_MESSAGES.note, /state\/, logs\/ and reports\/ are already ignored by \.tyr\/\.gitignore/);
    assert.match(GITIGNORE_MESSAGES.hint, /--gitignore/);
    // Nothing may still claim tyr.json is machine-specific or must be ignored.
    for (const text of Object.values(GITIGNORE_MESSAGES)) {
        if (typeof text !== "string") continue;
        assert.doesNotMatch(text, /machine-specific|absolute path|does not ignore/);
    }
});

test("GITIGNORE_MESSAGES: pressing Enter at the prompt declines", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const answer = confirm(GITIGNORE_MESSAGES.question, GITIGNORE_MESSAGES.defaultYes, { input, output });
    input.end("\n");
    assert.equal(await answer, false);
});
