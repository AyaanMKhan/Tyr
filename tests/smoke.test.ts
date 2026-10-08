import { test } from "node:test";
import * as assert from "node:assert/strict";
import { resolveTyrPaths } from "../cli/core/scaffold.js";

test("resolveTyrPaths puts tyr.json under .tyr/", () => {
    const paths = resolveTyrPaths("/tmp/project");
    assert.equal(paths.configFile, "/tmp/project/.tyr/tyr.json");
});
