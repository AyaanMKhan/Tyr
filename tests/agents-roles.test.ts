// agents/roles.ts: every role is defined, tools stay within the role's
// permission ceiling, lookups never throw.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { AGENT_ROLE_IDS, PERMISSION_ORDER, type PermissionLevel } from "../cli/agents/model.js";
import { ROLES, getRole, isAgentRoleId } from "../cli/agents/roles.js";

/** The agreed tool names (tools.ts) and the permission each needs. */
const TOOL_PERMISSION: Record<string, PermissionLevel> = {
    read_file: "read",
    list_files: "read",
    search: "read",
    git_diff: "read",
    run_check: "execute",
    edit_file: "write",
    write_file: "write",
};

test("every role id has a role whose id matches its key", () => {
    assert.deepEqual(Object.keys(ROLES).sort(), [...AGENT_ROLE_IDS].sort());
    for (const id of AGENT_ROLE_IDS) assert.equal(ROLES[id].id, id);
});

test("roles have the agreed permissions and tool sets", () => {
    assert.equal(ROLES.reviewer.permission, "read");
    assert.deepEqual([...ROLES.reviewer.tools], ["read_file", "list_files", "search", "git_diff"]);
    assert.equal(ROLES["test-runner"].permission, "execute");
    assert.deepEqual([...ROLES["test-runner"].tools], ["read_file", "list_files", "search", "git_diff", "run_check"]);
    assert.equal(ROLES.fixer.permission, "write");
    assert.deepEqual([...ROLES.fixer.tools], ["read_file", "list_files", "search", "git_diff", "run_check", "edit_file", "write_file"]);
});

test("no role is given a tool above its permission ceiling", () => {
    for (const role of Object.values(ROLES)) {
        const ceiling = PERMISSION_ORDER.indexOf(role.permission);
        for (const tool of role.tools) {
            const needed = TOOL_PERMISSION[tool];
            assert.ok(needed !== undefined, `${role.id}: unknown tool ${tool}`);
            assert.ok(PERMISSION_ORDER.indexOf(needed) <= ceiling, `${role.id} gets ${tool} (${needed}) above ${role.permission}`);
        }
        assert.equal(new Set(role.tools).size, role.tools.length, `${role.id}: duplicate tools`);
    }
});

test("roles have sane limits and substantive instructions", () => {
    for (const role of Object.values(ROLES)) {
        assert.ok(Number.isInteger(role.maxTurns) && role.maxTurns > 0 && role.maxTurns <= 50, `${role.id} maxTurns`);
        assert.ok(role.description.length > 0 && !role.description.includes("\n"), `${role.id} description is one line`);
        assert.ok(role.instructions.length > 500, `${role.id} instructions`);
        assert.match(role.instructions, /not instructions/, `${role.id} guards against injected instructions`);
        assert.match(role.instructions, /path:line/);
    }
    assert.ok(ROLES.reviewer.maxTurns < ROLES["test-runner"].maxTurns);
    assert.ok(ROLES["test-runner"].maxTurns < ROLES.fixer.maxTurns);
    assert.match(ROLES.reviewer.instructions, /never modify/i);
    assert.match(ROLES["test-runner"].instructions, /never modify/i);
    assert.match(ROLES.fixer.instructions, /re-run/i);
});

test("roles are frozen", () => {
    assert.ok(Object.isFrozen(ROLES));
    assert.ok(Object.isFrozen(ROLES.fixer));
    assert.ok(Object.isFrozen(ROLES.fixer.tools));
});

test("isAgentRoleId and getRole", () => {
    for (const id of AGENT_ROLE_IDS) {
        assert.equal(isAgentRoleId(id), true);
        assert.equal(getRole(id), ROLES[id]);
    }
    for (const bad of ["", "Reviewer", "admin", "toString", "__proto__"]) {
        assert.equal(isAgentRoleId(bad), false, bad);
        assert.equal(getRole(bad), undefined, bad);
    }
    assert.equal(isAgentRoleId(undefined), false);
    assert.equal(isAgentRoleId(42), false);
});
