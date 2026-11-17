# cli/engine — orchestration, repository state and check execution

The engine is the daemon's brain: it turns what Tyr observes (file changes,
commits, Claude Code activity) into decisions about when to run the project's
checks, runs them, and keeps a model of the repository's health.

## Layout

`cli/engine/` sits next to `cli/core/` on purpose:

- `cli/core/` is **infrastructure**: storage under `.tyr/`, git, watchers, the
  event journal, settings. Modules there know nothing about the engine.
- `cli/engine/` is **policy**: it consumes `cli/core/` and decides what to do.
  It may import from `cli/core/`; `cli/core/` never imports from `cli/engine/`.

Both are inside `tsconfig.include` (`cli/**/*.ts`). The old top-level `core/`
placeholder directory is gone.

## Modules

| Module            | Role |
| ----------------- | ---- |
| `model.ts`        | Shared contract: engine events, check runs, repository state. Pure types and constants. |
| `bus.ts`          | Event bus: normalizes journal `TyrEvent`s into typed `EngineEvent`s and fans them out to subscribers. |
| `executor.ts`     | Execution engine: runs a configured command with a timeout, captures bounded output, classifies the outcome. |
| `repo-state.ts`   | Repository state model: current diff, last result and last good run per check, open problems. Persisted to `.tyr/state/engine.json`. |
| `scheduler.ts`    | Decides when checks run: on idle after edits, on commit, on Claude Code `Stop`. |
| `engine.ts`       | Wires bus + scheduler + executor + repo state together; started by the daemon. |

## Conventions

Same as `cli/core/`: modules never print, never throw for normal conditions,
and take injectable clocks/spawners so tests stay deterministic.

Check results are journaled as `check.started`, `check.passed` and
`check.failed` events (source `"check"`), so `tyr watch` shows them live.
