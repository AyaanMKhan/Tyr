User facing CLI commands are documented in this file. The full pages are
in `docs/cli/`, and settings are in `docs/configuration/settings.mdx`.

| Command | What it does |
|---|---|
| `tyr init` | Profile the repository and write `.tyr/` |
| `tyr start` / `tyr stop` | Start or stop the background process (checks and reviews on change) |
| `tyr watch` | Live view of the event journal |
| `tyr status` | What Tyr knows: profile, background process, checks, findings, drift |
| `tyr run "<prompt>"` | Do something now: run checks, review, answer a question, or run an agent |
| `tyr agents list` / `clean` | Agent roles, and the worktrees of isolated agent runs |
| `tyr config` | View and change settings |
| `tyr hooks install` / `uninstall` / `status` | Connect Tyr to Claude Code |
| `tyr notify [message]` | Send a notification to your targets now, to check they work |

## `tyr run`

```
tyr run <prompt> [--mode checks|review|ask] [--no-llm]
tyr run <prompt> --agent reviewer|test-runner|fixer [--apply] [--isolate] [-y|--yes] [--correct]
```

Without `--agent`, keyword routing picks the route: `checks`, `review` or
`ask`, and `--mode` overrides the guess. Agents are never picked by
keywords.

| Flag | Meaning |
|---|---|
| `--mode <mode>` | Force the route |
| `--no-llm` | Diff rules only during a review |
| `--agent <role>` | Run a tool-using agent on the prompt (see `agents/AGENTS.md`). Can't be combined with `--mode` |
| `--apply` | Fixer: make the changes. Without it the fixer only describes them (dry run) |
| `--isolate` | Work in a new worktree on a `tyr/<role>-<time>` branch under `.tyr/worktrees/` |
| `-y`, `--yes` | With `--apply` in place: don't ask before each change |
| `--correct` | Queue the agent's summary for a live Claude Code session |

`--apply` in place asks before each change. Without a terminal (CI, a pipe,
`--json`) it is refused unless you pass `--yes` or `--isolate`. Using
`--apply`, `--isolate`, `--yes` or `--correct` without `--agent` is a usage
error (exit 2). Every run is journaled and saved as a `run` report. With
`--json`, the RunResult holds the full agent record in its `agent` field.

## `tyr agents`

```
tyr agents list
tyr agents clean [path] [--force] [--keep-branch]
```

`list` (the default) shows the roles and the agent worktrees. `clean`
removes every agent worktree and its `tyr/` branch, or only the one at
`path`. `--force` also removes worktrees with uncommitted changes, and
`--keep-branch` keeps the branches. Both support `--json`.

## Settings used by agents

| Key | Values | Default | Meaning |
|---|---|---|---|
| `agents.correct` (`TYR_AGENTS_CORRECT`) | `off`, `context`, `block` | `context` | How `tyr hook` feeds problems back to Claude Code: `context` adds them to the context on prompt, session start and tool result. `block` also asks Claude to fix `error`/`critical` ones before stopping, at most twice in a row. `off` never answers |
| `ai.apiKey`, `ai.model` | | | Key (global config or env only) and model for agents, reviews and questions |

## `tyr notify`

```
tyr notify [message] [-t|--target terminal|desktop ...] [--title <title>] [--severity info|warning|error]
```

Sends one notification now, to `notifications.targets` or the `--target`
list, and reports each target (`--json` for a machine-readable result).
Exit 1 when no target accepted it, exit 2 when there are no targets. The
background process sends the same kind of notification on its own when a
check regresses, starts failing or recovers, or the diff review finds a new
serious problem; see `integrations/INTEGRATIONS.md`.
