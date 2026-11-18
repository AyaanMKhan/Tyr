# Tyr's agents

Tyr's agents are tool-using model runs with a narrow job: review a change,
run and diagnose the checks, or make the smallest fix. They run when you
ask for them (`tyr run --agent <role> "<task>"`). Every file they read and
every change they make goes through a permission gate. The code lives in
`cli/agents/`. This directory holds only this document.

Separately, Tyr can **correct a live Claude Code session**. Problems found
by its checks and reviews are fed back to Claude through the hooks Tyr
already installs, under the `agents.correct` setting.

## Running an agent

```bash
tyr run --agent reviewer "review my changes"
tyr run --agent test-runner "why does the test check fail?"
tyr run --agent fixer "fix the failing typecheck"                 # dry run
tyr run --agent fixer --apply "fix the failing typecheck"         # asks before each change
tyr run --agent fixer --apply --isolate "fix the failing tests"   # on a new tyr/ branch
```

The prompt is the agent's task. Agents need an API key (`ai.apiKey`,
`TYR_API_KEY` or `ANTHROPIC_API_KEY`) and use `ai.model`. Without a key the
run is skipped and exits 1. Keyword routing never picks an agent: an agent
run makes many model calls and the fixer can edit files, so you always ask
for one explicitly with `--agent`.

Progress shows one line per tool call. The agent's final message prints
like an answer. After it come the changes it proposed or made, the worktree
if there is one, and anything the safety gate refused. Like every
`tyr run`, the run is journaled (`run.started` / `run.completed`),
counted in `state.json` and saved as a `run` report. With `--json`, the
`RunResult` has `intent: { mode: "agent", role, task }` and an `agent`
field holding the full `AgentRunResult`.

## Roles

| Role | Permission | Tools | Turn cap | What it does |
|---|---|---|---:|---|
| `reviewer` | read | `read_file`, `list_files`, `search`, `git_diff` | 12 | Reviews the change against the project's documented conventions. Reports one finding per line as `<severity> path:line - <problem>`. Tyr turns those lines into findings, so an `error` or `critical` one makes the run fail (exit 1). It never edits. |
| `test-runner` | execute | the read tools plus `run_check` | 20 | Runs the configured checks, finds the first real error, and reports the root cause per failing check. It never edits. A check reported as failed makes the run fail. |
| `fixer` | write | the above plus `edit_file`, `write_file` | 30 | Makes the smallest change that fixes the failing checks or findings, re-runs the checks to verify it, and explains what it changed. It must not weaken checks (skip tests, add `any`, loosen lint). |

`reviewer` is also the tool-using counterpart of `tyr run`'s `ask` route.
`ask` answers from a snapshot in one call. `reviewer` opens and searches
files itself, so use it when the snapshot isn't enough.

Each role's instructions are fixed text. The system prompt adds the
repository context in a fixed order, most stable first, so prompt caching
works across turns and runs:

1. The `tyr.json` profile: languages, frameworks and the check commands.
2. `CLAUDE.md` and README excerpts.
3. The working-tree diff against HEAD. `.tyr/` is excluded, untracked files
   are folded in, secrets are masked, and it is trimmed to about 60 KB one
   whole file at a time.
4. Failing checks with output excerpts (from `.tyr/state/engine.json`) and
   open findings (from `.tyr/state/findings.json`).

The context is presented as material to work with, never as instructions.

### Tools

| Tool | Permission | Notes |
|---|---|---|
| `read_file` | read | Optionally a line range. Capped at 2 MB per file and about 60k characters of output. |
| `list_files` | read | Honours `.gitignore` (via git) and Tyr's ignore list. Optional glob. |
| `search` | read | Regular expression over file contents, with bounded matches. |
| `git_diff` | read | Working tree against HEAD, optionally for one path. |
| `run_check` | execute | Only a check configured in `tyr.json` and enabled in settings (`build`, `typecheck`, `lint`, `test`, `format`). Never an arbitrary command. |
| `edit_file` | write | Replaces one exact, unique occurrence of a string. |
| `write_file` | write | Creates or overwrites a file (at most 1 MB). |

Every path is confined to the agent's workspace. A path outside it is
refused, and so is any path under `.git/` or `.tyr/`.

## Safety

### Permission gate

Every tool call is checked against two things:

- **The role's permission ceiling.** Read is below execute, and execute is
  below write. A role is only given tools at or below its ceiling, and the
  gate refuses anything above it even if a tool were somehow offered.
- **The path policy.** Paths outside the workspace are refused, including
  `..`, other drives, UNC paths and symlinks that point out. `.git/` is
  refused for reading too. Likely secrets (`.env`, `.env.*`, `*.pem`,
  `*.key`, `*.p12`, `*.pfx`, SSH keys, `.npmrc`, `.pypirc`, `.netrc`) can't
  be read or written. Tool configuration and lockfiles (`.claude/settings*.json`,
  `.gitmodules`, `package-lock.json`, `yarn.lock`, `Cargo.lock`, `go.sum`,
  and others) can be read but not written, and neither can anything under
  `.tyr/`.

Every decision is recorded. The run record's `safety` field counts the
checks, approvals and refusals, and lists what was refused and why.

### Dry run, approval and isolation

`resolveRunSafety()` (`cli/agents/safety.ts`) turns the flags into the run's
policy. The first matching row wins:

| Role ceiling | `--apply` | `--isolate` | `--yes` | Terminal | Result |
|---|---|---|---|---|---|
| read / execute | any | any | any | any | Runs in place. Nothing can be written. |
| write | no | any | any | any | **Dry run**: edits are described with a patch, never made. |
| write | yes | yes | any | any | Applied in a new worktree on a `tyr/` branch, without asking. |
| write | yes | no | yes | any | Applied in place without asking. |
| write | yes | no | no | yes | Applied in place, asking `y/N` before each change. |
| write | yes | no | no | no | Refused before any model call: there is nobody to approve. Pass `--yes` or `--isolate`. |

`--json` counts as "no terminal" because its stdout is reserved for the
result. `--apply`, `--isolate`, `--yes` and `--correct` are usage errors
(exit 2) without `--agent`, and `--agent` can't be combined with `--mode`.

### Worktree isolation

With `--isolate`, the agent works in a git worktree:

- The worktree is checked out at `.tyr/worktrees/<role>-<YYYYMMDD-HHMMSS>`
  on a new branch `tyr/<role>-<YYYYMMDD-HHMMSS>` from your HEAD. Your
  branch, index and files are never touched.
- Your uncommitted changes (modified, added, deleted and untracked files)
  are copied in byte for byte and **staged there**. In the worktree,
  `git diff` therefore shows only the agent's changes, and
  `git -C <worktree> diff | git apply` (run from the repository root)
  brings them into your tree.
- `.tyr/worktrees/` keeps itself out of `git status` with its own
  `.gitignore`.
- A worktree is kept only when the agent changed something in it. A dry
  run, a run that changed nothing, or a failed run removes the worktree
  and its branch.

Context (the diff, failing output and findings) and the check commands are
read from your project root, because `.tyr/state/` isn't committed and so
isn't in the worktree. Checks run in the worktree.

`tyr agents list` shows the roles and the agent worktrees. `tyr agents clean`
removes them all, or one when you pass a path. Add `--force` to remove
worktrees that have uncommitted changes, and `--keep-branch` to keep the
`tyr/` branches. It only ever touches worktrees under `.tyr/worktrees/` on
a `tyr/` branch.

## Correcting a live Claude Code session

Once Tyr's hooks are installed (`tyr hooks install`), every hook Claude
Code runs is also a chance for Tyr to answer. Tyr keeps a corrections
queue in `.tyr/state/corrections.json`. It is fed from three places:

- **Checks**: open problems in `engine.json`, such as a failing typecheck,
  with the first few error locations.
- **Reviews**: findings at `error` or `critical` in `findings.json`.
- **Agents and users**: `tyr run --agent ... --correct` queues the agent's
  summary (source `agent`), with severity `error` when the reviewer reported
  an error or the test-runner a failing check.

Each correction has a fingerprint, so the same problem is queued only once.
Corrections derived from checks and reviews are dropped once their problem
is gone, and queued again if it comes back. A problem that stays open is
delivered once and not repeated.

The `agents.correct` setting (env `TYR_AGENTS_CORRECT`) chooses how Tyr
answers:

| Mode | `UserPromptSubmit`, `SessionStart`, `PostToolUse` | `Stop` |
|---|---|---|
| `off` | Nothing | Nothing |
| `context` (default) | Pending corrections are added to Claude's context (`additionalContext`) | Nothing |
| `block` | Same as `context` | For `error` or `critical` corrections, `{"decision":"block"}` asks Claude to fix them before stopping. At most twice in a row per session. A stop that Claude Code reports as already continuing because of a stop hook counts toward that limit |

Replies are bounded to about 4,000 characters. `tyr hook` still always
exits 0, and any failure in the reply path prints nothing.

```bash
tyr config set agents.correct block    # also hold Claude's Stop for serious problems
tyr config set agents.correct off      # record only, never answer
```

## Code layout (`cli/agents/`)

| Module | Role |
|---|---|
| `model.ts` | Shared contract: roles, permission levels, tools, the gate, `AgentRunOptions`, `AgentRunResult`. Pure types. |
| `roles.ts` | The three roles: permission ceiling, tool names, turn cap and instructions. |
| `context.ts` | `buildAgentContext` (profile, conventions, diff, failures, each with its own budget), `buildSystemPrompt`, `buildTaskMessage`. |
| `provider.ts` | `resolveAgentAi` (key and model from settings) and `runToolLoop`, a manual tool-use loop over the Messages API with prompt caching, a turn cap, cancellation and progress events. |
| `tools.ts` | The seven tools, path confinement, bounded output, and dry-run or approved writes with unified diffs. |
| `safety.ts` | `createGate` (ceiling, path policy, approval, audit log), `resolveRunSafety` (the table above), worktree creation, listing and removal, and the terminal prompter. |
| `coordinate.ts` | The corrections queue and the hook replies used by `tyr hook` (`cli/commands/hooks.ts`). |
| `agent.ts` | `runAgent`: one run end to end. Also `agentRouteOutcome`, which turns a result into a `tyr run` outcome, and `parseAgentFindings`. |

Layering: `cli/agents/` may import `cli/core/` and `cli/engine/`, and
neither imports `cli/agents/`. `tyr run` hands the engine a
`RunAgentDelegate`, so `cli/engine/run.ts` records agent runs without
knowing about agents. Like the rest of the codebase, these modules never
print and never throw for normal conditions. The messages client, the
prompter, the clock and the git runner are injectable, so the tests
(`tests/agents-*.test.ts`) never touch the network.

## Limits

- Not yet exercised against the live API. The tests use a scripted client.
- An isolated run leaves the agent's changes uncommitted in its worktree.
  Tyr doesn't commit them on the `tyr/` branch or open a PR.
- The background process doesn't start agents on its own yet. Agents only
  run from `tyr run --agent`.
