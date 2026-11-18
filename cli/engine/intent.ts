// Prompt routing for `tyr run "<prompt>"` (PLANNING.md 2.13): decide what a
// plain-language request means before anything runs.
//
//   checks  run some or all of the configured checks (build, typecheck,
//           lint, test, format) in the foreground: "run the tests",
//           "check everything", "lint"
//   review  review a diff with the diff rules and, when an API key is set,
//           the model: "review my changes", "review the last commit"
//   ask     anything else, including questions about checks ("why is the
//           build failing?"): answered by the model with the repository
//           context Tyr has in .tyr/
//   agent   a tool-using agent (cli/agents/): only by `tyr run --agent
//           <role>`, never guessed. Agent runs take many model turns and the
//           fixer can edit files, so they are always an explicit choice.
//
// Routing is deterministic keyword matching, not a model call: it is free,
// instant, testable, and `--mode` overrides it when it guesses wrong.
// Questions win over keywords, so "why do the tests fail?" is asked, not run.

import { CHECK_KINDS, type CheckKind } from "./model.js";

export type RunMode = "checks" | "review" | "ask";

export const RUN_MODES: readonly RunMode[] = ["checks", "review", "ask"];

/** What a review covers. */
export type ReviewScope = "working-tree" | "last-commit";

export type RunIntent =
    | {
          mode: "checks";
          /** Checks to run, in CHECK_KINDS order; every check when `all`. */
          checks: CheckKind[];
          all: boolean;
      }
    | { mode: "review"; scope: ReviewScope }
    | { mode: "ask"; question: string }
    /** Only from `--agent`; routePrompt never returns it. `role` is an agent role id (cli/agents/roles.ts). */
    | { mode: "agent"; role: string; task: string };

/** Words that name each check. Matched as whole words on the lowercased prompt. */
const CHECK_WORDS: Record<CheckKind, readonly string[]> = {
    build: ["build", "builds", "compile", "compiles", "compiling", "compilation"],
    typecheck: ["typecheck", "typechecks", "type-check", "type check", "types", "typing", "tsc", "mypy"],
    lint: ["lint", "linter", "linting", "eslint", "ruff", "clippy"],
    test: ["test", "tests", "testing", "specs", "unit tests", "test suite"],
    format: ["format", "formatting", "formatter", "prettier", "fmt"],
};

/** "Run every check" phrasings. */
const ALL_CHECKS = /\b(all|every|the)\s+checks?\b|\bcheck\s+(everything|it all|all)\b|\b(run|rerun|re-run)\s+checks?\b|^\s*(checks?|verify|ci)\s*$/;

const REVIEW = /\b(review|reviews|reviewing|audit|look over|look at my (changes|diff)|go over|critique)\b/;
const LAST_COMMIT = /\b(last|latest|previous|most recent|head|my)\s+commit\b|\bhead\b|\bcommitted\b/;

/** Questions go to the model even when they mention a check. */
const QUESTION = /^\s*(why|what|whats|what's|how|where|when|which|who|is|are|does|do|did|can|could|should|would|explain|describe|summari[sz]e|tell me|help me understand)\b/;

const RUN_VERB = /^\s*(please\s+)?(run|rerun|re-run|execute|start|kick off|check|verify|try)\b/;

function hasWord(text: string, word: string): boolean {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
    return new RegExp(`(^|[^a-z0-9-])${escaped}($|[^a-z0-9-])`).test(text);
}

/** Checks the prompt names, in CHECK_KINDS order. */
export function mentionedChecks(prompt: string): CheckKind[] {
    const text = prompt.toLowerCase();
    return CHECK_KINDS.filter((kind) => CHECK_WORDS[kind].some((word) => hasWord(text, word)));
}

/**
 * Route a prompt. `mode` forces the route (from `--mode`); a forced
 * `checks` with no check named runs every check, and a forced `review`
 * still reads the scope from the prompt.
 */
export function routePrompt(prompt: string, mode?: RunMode): RunIntent {
    const text = prompt.trim().toLowerCase();
    const question = prompt.trim();

    if (mode === "ask") return { mode: "ask", question };
    if (mode === "review") return { mode: "review", scope: LAST_COMMIT.test(text) ? "last-commit" : "working-tree" };
    if (mode === "checks") {
        const checks = mentionedChecks(text);
        return checks.length === 0 ? { mode: "checks", checks: [...CHECK_KINDS], all: true } : { mode: "checks", checks, all: false };
    }

    const asking = QUESTION.test(text) || text.endsWith("?");
    if (!asking && REVIEW.test(text)) {
        return { mode: "review", scope: LAST_COMMIT.test(text) ? "last-commit" : "working-tree" };
    }
    if (!asking) {
        if (ALL_CHECKS.test(text)) return { mode: "checks", checks: [...CHECK_KINDS], all: true };
        const checks = mentionedChecks(text);
        // "run the tests", "lint", "typecheck and lint": a run verb, or a
        // prompt made of little more than check names.
        const short = text.split(/\s+/).filter(Boolean).length <= 4;
        if (checks.length > 0 && (RUN_VERB.test(text) || short)) {
            return { mode: "checks", checks, all: false };
        }
    }
    return { mode: "ask", question };
}

/** One line for progress output: "run build, test", "review the last commit". */
export function describeIntent(intent: RunIntent): string {
    switch (intent.mode) {
        case "checks":
            return intent.all ? "run every check" : `run ${intent.checks.join(", ")}`;
        case "review":
            return intent.scope === "last-commit" ? "review the last commit" : "review uncommitted changes";
        case "ask":
            return "answer a question about the repository";
        case "agent":
            return `run the ${intent.role} agent`;
    }
}
