import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import { resolveTyrPaths } from "../cli/core/scaffold.js";

test("resolveTyrPaths puts tyr.json under .tyr/", () => {
    const root = path.resolve("/tmp/project");
    const paths = resolveTyrPaths(root);
    assert.equal(paths.configFile, path.join(root, ".tyr", "tyr.json"));
});
