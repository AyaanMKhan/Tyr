import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { describeIntent, mentionedChecks, routePrompt } from "../cli/engine/intent.js";
import { CHECK_KINDS } from "../cli/engine/model.js";

describe("routePrompt", () => {
    it("runs named checks", () => {
        assert.deepEqual(routePrompt("run the tests"), { mode: "checks", checks: ["test"], all: false });
        assert.deepEqual(routePrompt("lint"), { mode: "checks", checks: ["lint"], all: false });
        assert.deepEqual(routePrompt("typecheck and lint"), { mode: "checks", checks: ["typecheck", "lint"], all: false });
        assert.deepEqual(routePrompt("please re-run the build and the unit tests"), {
            mode: "checks",
            checks: ["build", "test"],
            all: false,
        });
        assert.deepEqual(routePrompt("Check formatting"), { mode: "checks", checks: ["format"], all: false });
    });

    it("runs every check", () => {
        for (const prompt of ["run all checks", "check everything", "run checks", "verify", "rerun every check"]) {
            assert.deepEqual(routePrompt(prompt), { mode: "checks", checks: [...CHECK_KINDS], all: true }, prompt);
        }
    });

    it("reviews the working tree or the last commit", () => {
        assert.deepEqual(routePrompt("review my changes"), { mode: "review", scope: "working-tree" });
        assert.deepEqual(routePrompt("audit the diff"), { mode: "review", scope: "working-tree" });
        assert.deepEqual(routePrompt("review my last commit"), { mode: "review", scope: "last-commit" });
        assert.deepEqual(routePrompt("Review HEAD"), { mode: "review", scope: "last-commit" });
    });

    it("asks questions, even about checks", () => {
        for (const prompt of [
            "why is the build failing?",
            "what does the scheduler do",
            "how do I add a new check",
            "the tests keep timing out on CI, any idea where to start looking at this?",
            "explain the review rules",
            "is it safe to merge?",
        ]) {
            const intent = routePrompt(prompt);
            assert.equal(intent.mode, "ask", prompt);
            assert.equal(intent.mode === "ask" && intent.question, prompt);
        }
    });

    it("does not treat long statements that mention a check as a run", () => {
        assert.equal(routePrompt("I think the test helper in the fixtures folder is redundant now").mode, "ask");
    });

    it("honors a forced mode", () => {
        assert.deepEqual(routePrompt("run the tests", "ask"), { mode: "ask", question: "run the tests" });
        assert.deepEqual(routePrompt("why is the build failing?", "checks"), { mode: "checks", checks: ["build"], all: false });
        assert.deepEqual(routePrompt("anything", "checks"), { mode: "checks", checks: [...CHECK_KINDS], all: true });
        assert.deepEqual(routePrompt("the last commit please", "review"), { mode: "review", scope: "last-commit" });
        assert.deepEqual(routePrompt("whatever", "review"), { mode: "review", scope: "working-tree" });
    });

    it("trims the question", () => {
        assert.deepEqual(routePrompt("  what changed?  "), { mode: "ask", question: "what changed?" });
    });
});

describe("mentionedChecks", () => {
    it("matches whole words only", () => {
        assert.deepEqual(mentionedChecks("contest attestation"), []);
        assert.deepEqual(mentionedChecks("rebuild"), []);
        assert.deepEqual(mentionedChecks("run eslint then prettier"), ["lint", "format"]);
        assert.deepEqual(mentionedChecks("type check"), ["typecheck"]);
    });
});

describe("describeIntent", () => {
    it("summarizes each route", () => {
        assert.equal(describeIntent(routePrompt("run all checks")), "run every check");
        assert.equal(describeIntent(routePrompt("run the tests and lint")), "run lint, test");
        assert.equal(describeIntent(routePrompt("review my last commit")), "review the last commit");
        assert.equal(describeIntent(routePrompt("review")), "review uncommitted changes");
        assert.equal(describeIntent(routePrompt("why?")), "answer a question about the repository");
    });
});
