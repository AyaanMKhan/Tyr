# cli/engine — orchestration, repository state and check execution

The engine is the daemon's brain: it turns what Tyr observes (file changes,
commits, Claude Code activity) into decisions about when to run the project's
checks, runs them, and keeps a model of the repository's health.

## Layout

`cli/engine/` sits next to `cli/core/` on purpose:

- `cli/core/` is **infrastructure**: storage under `.tyr/`, git, watchers, the
  event journal, settings. Modules there know nothing about the engine.
- `cli/engine/` is **policy**: it consumes `cli/core/` and decides what to do.
  It may import from `cli/core/`; `cli/core/` never imports from `cli/engine/`,
  with one exception: `cli/core/daemon.ts` hosts the engine (`startEngine`) for
  the lifetime of the background process.

- `cli/agents/` is **agents** (see `agents/AGENTS.md`): tool-using model
  runs, their safety gate and worktree isolation, and the corrections fed
  back to a live Claude Code session. It sits on top of both: it may import
  `cli/core/` and `cli/engine/`, and neither imports it. Where the engine
  has to record an agent run (`tyr run --agent`), the command passes a
  `RunAgentDelegate` into `executeRun` (`run.ts`) instead, so the engine
  only sees the outcome. `cli/commands/` wires the layers together.

All three are inside `tsconfig.include` (`cli/**/*.ts`). The old top-level
`core/` placeholder directory is gone.

## Modules

| Module            | Role |
| ----------------- | ---- |
| `model.ts`        | Shared contract: engine events, check runs, repository state. Pure types and constants. |
| `bus.ts`          | Event bus: normalizes journal `TyrEvent`s into typed `EngineEvent`s and fans them out to subscribers. |
| `executor.ts`     | Execution engine: runs a configured command with a timeout, captures bounded output, classifies the outcome. |
| `repo-state.ts`   | Repository state model: current diff, last result and last good run per check, open problems. Persisted to `.tyr/state/engine.json`. |
| `scheduler.ts`    | Decides when checks run: on idle after edits, on commit, on Claude Code `Stop`. |
| `findings.ts`     | Findings contract for problem detection: `EngineFinding`, fingerprints, ordering. |
| `check-parsers.ts` | Parses check output (tsc, ESLint, node:test, Jest/Vitest, pytest, cargo, Go, ruff/flake8/mypy, generic) into findings. |
| `diff-review.ts`  | Heuristic diff review: secrets, deleted or skipped tests, risky patterns, oversized changes. Pure, rule registry. |
| `llm-review.ts`   | Model review of a diff against CLAUDE.md, README and the tyr.json profile (`@anthropic-ai/sdk`, injectable client); never throws, skips without a key. |
| `review.ts`       | Review pass: merges detector findings, marks regressions/new/resolved against the last pass (`.tyr/state/findings.json`), applies the severity threshold, writes a `review` report and journals `review.completed`. |
| `engine.ts`       | Wires bus + scheduler + executor + repo state together; started by the daemon. |

## Conventions

Same as `cli/core/`: modules never print, never throw for normal conditions,
and take injectable clocks/spawners so tests stay deterministic.

Check results are journaled as `check.started`, `check.passed` and
`check.failed` events (source `"check"`), so `tyr watch` shows them live.
