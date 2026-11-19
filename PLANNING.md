# Tyr: Planning and Status

_Last assessed: 2026-10-04, at commit `9fe8758` ("feat: implement scaffolding for Tyr project initialization")._

## 1. Goal and overall completion

**What Tyr is meant to be** (from `README.md`, `cli/engine/ENGINE.md`, `agents/AGENTS.md`, `integrations/INTEGRATIONS.md` and the CLI command descriptions):

> A background engineering manager and reviewer. It watches what Claude Code is doing, understands the repository's state, detects problems (failing builds, tests, lint, risky changes), and eventually coordinates corrective agents.

The intended user flow is:

1. `tyr init` inspects the repo and writes `.tyr/`.
2. `tyr start` launches a background process.
3. `tyr watch` shows live progress.
4. `tyr status` reports what Tyr knows and is doing.
5. `tyr run "<prompt>"` asks Tyr to do something explicitly.

It is a TypeScript/Node CLI (`commander`, `figlet`) that builds to `dist/cli/index.js` and installs as the `tyr` binary.

**What works today:** `tyr init` works end to end. It finds the root, takes a git snapshot, scans files, profiles languages, frameworks and toolchain commands, writes `.tyr/` atomically and logs the run. I verified this by building a copy of the repo and running it: `npm ci && npm run build` succeeds, and `tyr init` / `tyr init --force` both produce the full `.tyr/` tree. Every other command is a one-line `console.log` stub. None of the actual product exists yet: the background process, observing Claude Code, the problem detection, the agents and the integrations.

### Overall completion: about 90%

I weighted each component by how much it contributes to an end-to-end working Tyr, multiplied the weight by that component's completion, and added up the results (see the table in section 3). The groundwork is the most polished part: init, discovery, git snapshot and project profiling are high quality. But it carries less than a third of the weight. The core product (daemon, observation, detection, agents, integrations) is about 45% of the weight and is at 0%.

---

## 2. Checklist by component

Legend: `[x]` means the code actually implements it, `[ ]` means it is not implemented or only stubbed.

### 2.1 CLI framework (`cli/index.ts`): 100%, Done
- [x] `commander` program with name and `-v, --version` (`cli/index.ts`)
- [x] All five commands registered (`init`, `start`, `watch`, `status`, `run`)
- [x] `bin` entry `tyr -> dist/cli/index.js` with a `#!/usr/bin/env node` shebang (survives `tsc`)
- [x] ESM (`"type": "module"`, `NodeNext`) and strict TypeScript build that compiles cleanly
- [x] Unknown commands rejected with a non-zero exit (commander default)
- [x] Single source of truth for the version: read from `package.json` by `cli/core/version.ts` (`TYR_VERSION`), used by `cli/index.ts` and `cli/commands/init.ts`
- [x] Show the figlet banner only for interactive or help output (`cli/ui/banner.ts`). Skipped for `--version`, usage errors, piped output and `TERM=dumb`
- [x] Global options: `--verbose`/`--quiet`, `--cwd <dir>` (`-C`), `--json` (`cli/core/globals.ts`). `init` supports all of them. The stub commands honor `--quiet` and `--json`
- [x] Top-level handler for uncaught errors and unhandled rejections, with consistent exit codes (`cli/core/errors.ts`, `cli/core/fatal.ts`): 0 ok, 1 failure, 2 usage, 3 not initialized, 4 config, 130 interrupted; `--json` / `TYR_JSON` always get a JSON error object
- [x] `tyr --help` text and examples for each command

### 2.2 `tyr init` (`cli/commands/init.ts`): 90%, Partial
- [x] Finds the project root, with git toplevel preferred and manifest markers as fallback (`findProjectRoot`, `cli/core/discovery.ts`)
- [x] Puts `.tyr/` at the absolute repo root
- [x] Refuses to re-init when `.tyr/tyr.json` is readable. `--force` re-initializes, `--reset` overwrites (`isInitialized`)
- [x] Treats an empty or corrupt `.tyr/` as not initialized
- [x] Git detection report: branch (including detached), HEAD commit, working-tree summary, remote (`reportGit`, `describeStatus`)
- [x] File scan with directory and extension ignore lists (`scanProject`, `IGNORED_DIRS`, `IGNORED_EXTENSIONS`)
- [x] Project profile report: language, frameworks, package manager, build/test/lint/format/typecheck commands, README, CLAUDE.md (`reportProject`)
- [x] Records the ignore lists in `tyr.json` (`DiscoveryResult.ignoredDirs/ignoredExtensions`)
- [x] Writes `.tyr/` through `scaffold()` and logs completion
- [x] `--no-color` flag. Sets `process.exitCode = 1` on failure
- [x] `--start` really starts the background process, through the same `reportDaemonStart()` as `tyr start`. `--json` reports `daemon: { pid, alreadyRunning }` or null
- [x] Marks the in-flight task as failed (`✗`) when an error occurs (`reporter.failActive()` in `runInit`'s `catch`)
- [x] Offers to add `.tyr/` entries to the project's root `.gitignore`, or documents which parts get committed (`cli/core/root-gitignore.ts`, `--gitignore` / `--no-gitignore`)
- [x] Optional interactive confirmation or editing of detected commands before writing them (`tyr init --interactive`, `cli/core/edit-commands.ts`)
- [x] Preserves user-edited fields and state history on `--force` instead of overwriting everything. Commands are diffed against a `detected` baseline stored in `tyr.json` (or marked `source: "user"`); unknown keys and state history (`createdAt`, `runCount`, `lastRunAt`, `status`, extra fields) survive. `--reset` restores the full overwrite (`cli/core/reinit-merge.ts`)

### 2.3 Discovery / file scanning (`cli/core/discovery.ts`): 85%, Partial
- [x] `findProjectRoot()`: tries git first, then climbs looking for markers, never throws
- [x] `isAlreadyInitialized()`: checks for a real directory, not a stray file
- [x] `scanProject()`: skips symlinks, caps depth at 25, sorts output deterministically, records skipped dirs
- [x] `discoverProject()` convenience wrapper (exported but unused)
- [x] Respect the project's `.gitignore` (for example via `git ls-files -co --exclude-standard` inside a repo). Today only the hard-coded list applies
- [x] Limit concurrency in the walk. `Promise.all` over every subdirectory can hit `EMFILE` on very large trees
- [x] Revisit `bin` in `IGNORED_DIRS`, which skips real source such as Node `bin/` and Rust `src/bin`. `.DS_Store` is a file, not a directory
- [x] User-configurable extra ignore patterns, read from `tyr.json` or a `.tyrignore`
- [x] Incremental re-scan: diff against the last scan to support change detection

### 2.4 Git integration (`cli/core/git*.ts`): 100%, Done
- [x] Repo detection (`isGitRepository`), which correctly reports bare repos as not being a work tree
- [x] Current branch, including unborn and detached HEAD with a tag or short-hash label (`getCurrentBranch`, `describeDetachedHead`)
- [x] HEAD commit with a robust delimiter (`getHeadCommit`)
- [x] Porcelain v1 status parsing: staged, modified, untracked, conflicted, ahead/behind, renames, C-quoted paths (`getStatus`, `unquotePath`)
- [x] Remotes and default remote resolution (`getRemotes`, `resolveDefaultRemote`)
- [x] Every call is argv-only (no shell injection), time-limited and returns a value on every path (`runGit`, shared in `cli/core/git-exec.ts`)
- [x] Change detection: compare HEAD and working tree against `state.lastIndexedCommit`, surviving resets, rebases and missing commits (`cli/core/git-history.ts`, `detectChanges`)
- [x] Diffs: `git diff` / `git diff --stat` for staged, unstaged and since-commit changes, so Tyr can review them. Size-capped, rename-aware, config-proof (`cli/core/git-diff.ts`, `getDiff`, `getDiffStat`)
- [x] Commit log since a reference point (to see what Claude Code committed), with optional per-commit files (`getCommitLog`, `getCommitsSince`)
- [x] Watch for git events (HEAD, index, ref and merge-state changes) via debounced fs watch on `.git/`, with a polling fallback and worktree support (`cli/core/git-watch.ts`, `watchGit`)
- [x] Write operations for corrective agents: create branch or worktree, stash, commit, revert. All guarded: per-repo lock, dry run, protected branches, `Tyr-Agent` trailer, no force/push (`cli/core/git-write.ts`)
- [x] Handle status timeouts on huge repos: retry without untracked files (`untrackedSkipped`), and report `statusTimedOut` instead of a silent null (`getStatusOutcome`)
- [x] Persist the `detached` flag in `tyr.json` and `init --json`

### 2.5 Project profiling (`cli/core/project.ts`): 90%, Partial
- [x] Language histogram from the discovery file list. Docs and data formats never count as the primary language (`buildLanguageStats`, `pickPrimaryLanguage`)
- [x] Package manager detection: Corepack field, then lockfiles, then poetry/uv/pip/cargo/go/bundler/composer (`detectPackageManager`)
- [x] Framework detection for JS, Python, Ruby, PHP and Java (`detectFrameworks`)
- [x] Build/test/lint/format/typecheck command resolution: npm scripts first, then config-file fallbacks (`detectCommands`, `resolveCommand`)
- [x] README and CLAUDE.md detection (`detectDocs`)
- [x] Use the `package.json` / `pyproject.toml` / `Cargo.toml` name for `project.name`, falling back to the directory basename (`detectProjectName`)
- [x] Monorepo and workspace awareness (npm/pnpm/yarn workspaces, Cargo workspaces, nested packages) (`cli/core/workspaces.ts`, `detectWorkspaces`)
- [x] Keep each command's `tool` and `evidence` in `tyr.json` (`ConfigCommand`, `commandOf`)
- [x] Check that detected commands actually run: script lookup or `--version` probe, skippable with `--no-verify` (`cli/core/verify-commands.ts`)

### 2.6 `.tyr/` state and storage (`cli/core/scaffold.ts`, `cli/core/types.ts`): 100%, Done
- [x] Layout `.tyr/{tyr.json, state/state.json, logs/tyr.log, reports/, .gitignore}` (`resolveTyrPaths`, `scaffold`)
- [x] Atomic writes through a temp file and rename in the same directory (`writeFileAtomic`)
- [x] Safe readers that return `null` on missing or malformed JSON (`readConfig`, `readState`)
- [x] `writeState()` stamps `updatedAt`. Best-effort `appendLog()`
- [x] Typed schemas `TyrConfig` (v2) and `TyrState` (v1)
- [x] Validate loaded config and state against the schema (`cli/core/schema.ts`: `validateConfig`, `validateState`; `loadConfig`/`loadState` expose errors and warnings)
- [x] Schema version migration (`cli/core/migrate.ts`: ordered steps, missing version = v1, newer versions refused; config v1 -> v2 makes `project.root` relative)
- [x] Code that updates state: locked, guarded transitions in `cli/core/state-store.ts` (`updateState`, `markRunning`, `markStopped`, `markError`, `recordRun`), used by the daemon
- [x] A lock so commands cannot race on `.tyr/` (`cli/core/lock.ts`: `withTyrLock`, `.tyr/state/tyr.lock`, stale-lock breaking, re-entrant). Daemons stay exclusive via `daemon.pid` (2.8)
- [x] Report writer for `reports/` (`cli/core/reports.ts`: `<yyyyMMdd-HHmmss>-<kind>-<slug>.{json,md}`, retention by count/age, `reports` key in tyr.json)
- [x] Log rotation and `--log-level` (`cli/core/log.ts`: 1 MiB cap, 3 kept; `--log-level`, `TYR_LOG_LEVEL`; daemon inherits the level, `daemon.log` rotated on start)
- [x] Event/history store (`cli/core/events.ts`: `.tyr/state/events.jsonl`, rotated; daemon start/stop/crash, git events and `tyr init` recorded). Claude Code events arrive with 2.9
- [x] Decide what is committed: `tyr.json` (root stored as `"."`) and `.tyr/.gitignore` are committed; `state/`, `logs/`, `reports/` are not. The root `/.tyr/` entry stays an opt-in
- [x] Follow-ups: `saveScanManifest` writes under the `.tyr/` lock, and init saves it in the same (re-entrant) critical section as `scaffold()`; the init gitignore offer now says `tyr.json` / `settings.json` are meant to be committed and asks whether to ignore all of `.tyr/` instead, default no (`GITIGNORE_MESSAGES`); `appendEvent` ends a crash-truncated last line (one-byte read) before appending, and `parseEventLine` salvages an event glued onto a fragment

### 2.7 User configuration: 100%, Done
- [x] `tyr.json` exists and stores detected commands that a user could hand-edit
- [x] Separate the detected snapshot from user preferences (enabled checks, severity thresholds, agent permissions, notification targets). `tyr.json` stays detection-only; preferences live in the committed `.tyr/settings.json` (`cli/core/project-settings.ts`, shared contract in `cli/core/settings-types.ts`)
- [x] `tyr config get/set` or documented hand-editing: `tyr config list|get|set|unset|path [--global]` (`cli/commands/config.ts`) on a layered resolver (`cli/core/settings.ts`: default < global < project < env, with per-key origins); secrets masked and refused in the committed project file
- [x] Global, per-user config (`~/.config/tyr`) for API keys and defaults (`cli/core/global-config.ts`: XDG / `%APPDATA%` / `TYR_CONFIG_HOME` locations, written atomically with mode 600, warns when a file holding the API key is group/world-readable)
- [x] Env var overrides (`cli/core/env-settings.ts`): a `TYR_*` variable per setting, `ANTHROPIC_API_KEY` as the API-key fallback, and `TYR_QUIET` / `TYR_VERBOSE` / `TYR_JSON` for the global flags (flag > env > default). Empty values count as unset; bad values warn and are ignored

### 2.8 Background process: `tyr start` (`cli/commands/start.ts`, `cli/core/daemon.ts`): 100%, Done
- [x] Choose the process model: a detached `node` child running a dedicated entry (`cli/daemon-main.ts`), not a hidden commander command
- [x] Spawn a detached daemon and write a PID file to `.tyr/state/` (`startDaemon`, `daemon.pid` holds `{ pid, startedAt }`; stdout/stderr go to `.tyr/logs/daemon.log`)
- [x] Prevent duplicates (detect a live PID or stale lock). Exclusive-create claim of the PID file, `process.kill(pid, 0)` with EPERM counted as alive, stale files replaced (`readDaemonStatus`)
- [x] `tyr stop` command (`cli/commands/stop.ts`, `stopDaemon`): writes a `daemon.stop` request the daemon polls for, then falls back to a kill plus cleanup after 5s
- [x] Graceful shutdown on SIGINT/SIGTERM (and SIGBREAK on Windows). Persist `status: "stopped"`, remove the PID file
- [x] Windows-compatible daemonizing (`detached`, `windowsHide`, no POSIX-only signals). Stop uses the request file because `SIGTERM` is a hard kill on Windows
- [x] Recover after a crash: `status: "error"` plus a log entry on uncaught errors; `tyr start`/`tyr stop` clear the stale PID file a hard-killed daemon leaves behind
- [x] Real work wired in: the daemon observes git, files and Claude Code (2.9) and runs the engine (2.10), which schedules and runs checks

### 2.9 Observation of Claude Code and the repo: `tyr watch` (`cli/commands/watch.ts`): 100%, Done
- [x] File-system watcher on the project, using the discovery ignore rules and debounced (`cli/core/fs-watch.ts`, wired into `runDaemon`): recursive `fs.watch` with a polling fallback, the same ignore rules as discovery (built-ins, `.tyrignore`, `scan.extraIgnore`, `.gitignore`), one `fs.changed` event per burst, classified by stat against a startup snapshot
- [x] Git event watcher wired end to end: the daemon journals `git.*` events and attributes git-driven file changes (checkout, merge, rebase, stash) to one `fs.changed` with `cause: "git"` linked to the git event (`cli/core/observe.ts`); stop requests are serviced during startup; nested repos/worktrees are skipped; a fallback to polling journals a `daemon.warning`; files written during daemon startup are no longer lost. Proven by `tests/daemon-git.test.ts` against a real daemon
- [x] Claude Code session observation: `tyr hooks install|uninstall|status` installs Claude Code hooks (all 10 events) that run the hidden `tyr hook`, which normalizes the payload into `claude.*` events in `.tyr/state/events.jsonl` (prompt previews truncated, secrets redacted, never blocks Claude: always exit 0, no output). Transcript discovery and summaries in `cli/core/claude-transcripts.ts`
- [x] IPC channel between the daemon and the CLI: the event journal `.tyr/state/events.jsonl` is the daemon → CLI channel, followed live by `followEvents()` (`cli/core/event-stream.ts`: byte-offset tail, partial lines, rotation without loss or duplicates, backlog replay, fs.watch + poll). CLI → daemon requests are atomic files in `.tyr/state/requests/` (`stop`, `ping` answered by a `daemon.pong` event; `pingDaemon()`, `cli/core/daemon-requests.ts`)
- [x] `tyr watch` live view: replays recent history (`-n`, `--since`), then follows the journal live with a daemon status header (pid, uptime, ping); filters by `--source`, `--kind`, `--session`; `--json` streams NDJSON; one formatted line per event kind (`cli/ui/event-view.ts`), pairing Claude tool calls with their results

### 2.10 Core engine / orchestration (`cli/engine/`): 100%, Done
- [x] Event bus and model (file changed, commit made, Claude tool call, check result): `cli/engine/bus.ts` normalizes journal events into the typed `EngineEvent` union (`cli/engine/model.ts`) and fans them out (`EventBus`, `attachJournal`); malformed payloads become `other`, handler errors are isolated. `publish()` appends to the journal only, so every subscriber sees one ordering
- [x] Repository state model: current diff, last good build or test, open problems (`cli/engine/repo-state.ts`, `.tyr/state/engine.json`): working-tree snapshot vs HEAD, last and last-good run per check, a `check:<kind>` problem opened by a failure and closed by a pass, flagged as a regression when the check passed before; updates under `withTyrLock`
- [x] Scheduler for when to run checks (`cli/engine/scheduler.ts`): on idle after edits (5s), on commit (coalesced), on Claude Code `Stop` when files changed; idle runs are held while a Claude session is mid-turn; runs never overlap (one queued trigger, highest priority wins); file changes during and just after a run are treated as the checks' own output unless Claude was editing
- [x] Execution engine: run detected commands from `tyr.json` with timeouts, output capture and exit-code handling (`cli/engine/executor.ts`): shell commands with `CI=1`, 10 min default timeout, process-tree kill (process group on POSIX, `taskkill /T` on Windows), 64 KiB output tails, outcomes passed/failed/timeout/error/cancelled (shell 127/126/9009 = error); only checks enabled in settings run
- [x] Decide on the code layout: the engine lives in `cli/engine/` (policy) on top of `cli/core/` (infrastructure), inside `tsconfig.include`; the top-level `core/` placeholder is gone. Shared contract in `cli/engine/model.ts`, layout in `cli/engine/ENGINE.md`
- [x] Wired into the daemon (`cli/engine/engine.ts`, started by `runDaemon`): runs enabled checks in order (build, typecheck, lint, test, format), skips test when the build fails, journals `check.started`/`check.passed`/`check.failed` (visible in `tyr watch`), cancels a running check on `tyr stop`
- [ ] Follow-ups: findings/report output from check runs (2.11); show `engine.json` in `tyr status` (2.12); a manual `tyr check` trigger; per-check timeouts in settings; Windows tree-kill path untested

### 2.11 Problem detection / review (`cli/engine/`): 100%, Done
- [x] Run build, test, lint and typecheck after changes, then parse the results into findings: the engine runs them (2.10) and `cli/engine/check-parsers.ts` turns output into file/line findings for tsc, ESLint (stylish/unix/compact), node:test (TAP/spec), Jest, Vitest, pytest, cargo/rustc/clippy, Go, ruff/flake8/mypy and a generic `path:l:c: error:` fallback; an unrecognized failure becomes one summary finding with the output tail
- [x] Regression detection (passed before, fails now): per check in `engine.json` (`Problem.regression`) and per finding in `cli/engine/review.ts`, comparing fingerprints (stable across line drift) with the previous pass in `.tyr/state/findings.json`; reports also list new and resolved findings
- [x] Diff review: risky patterns, deleted tests, large unreviewed changes, secrets (`cli/engine/diff-review.ts`, 24 rules, masked secrets, `tyr-ignore[: rule]` line suppression); untracked files are reviewed too. Setting `review.diff` (on)
- [x] LLM-based review of diffs against CLAUDE.md and README conventions (`cli/engine/llm-review.ts`, `@anthropic-ai/sdk`, structured output, prompt caching, findings validated against the diff). Setting `review.llm` (off by default; runs on Claude Code Stop, commit or manual triggers only). Not yet exercised against the live API
- [x] Findings model with severity, persisted to `reports/` (`cli/engine/findings.ts`: `EngineFinding` extends the reports.ts `Finding` with source and fingerprint); a `review` report is written when findings change, filtered by `severity.threshold`; `review.completed` is journaled for `tyr watch`
- [ ] Follow-ups: per-path rule exclusions for diff review (test fixtures trip the risky-pattern rules); show findings in `tyr status` (2.12). Notifying on new regressions is done (2.15, `cli/engine/alerts.ts`)

### 2.12 `tyr status` (`cli/commands/status.ts`): 100%, Done
- [x] Command registered
- [x] Read `tyr.json` and `state.json` and print the project profile, daemon status, last run and open findings: `collectStatus()` in `cli/core/status.ts` (never throws; load problems become `warnings`), also summarizing `engine.json` checks/problems and findings from `.tyr/state/findings.json` (falling back to the newest review report); rendered by `cli/ui/status-view.ts` (compact by default, `--verbose` for more)
- [x] Detect "not initialized" and suggest `tyr init` (exit 3; a corrupt `tyr.json` exits 4)
- [x] Show drift: HEAD and file count against the last index (commits since index, files added/removed; `--no-scan` skips the file scan)
- [x] `--json` output: the versioned `StatusReport` (`statusVersion: 1`)
- [ ] Follow-ups: nothing updates `state.lastIndexedCommit` after `tyr init`, so drift is always against the last init

### 2.13 `tyr run <prompt>` (`cli/commands/run.ts`): 100%, Done
- [x] Command registered with a required `<prompt>` argument
- [x] Route the prompt to the engine or an agent, with repo context from `.tyr/`: keyword routing (`cli/engine/intent.ts`, `--mode` overrides) to `checks` (the engine's check pass, extracted to `cli/engine/pass.ts`; every check includes the review), `review` (diff rules plus the model when a key is set, working tree or last commit, `.tyr/` excluded) or `ask` (`cli/engine/ask.ts`: one streamed model call grounded in the profile, CLAUDE.md/README, `tyr status`, recent commits and the trimmed diff)
- [x] Stream progress, then record the result in state and reports (`cli/engine/run.ts`): per-check progress lines and the streamed answer; `run.started` / `run.completed` journal events, `runCount` / `lastRunAt` in state.json, a `run` report; `--json` prints the versioned RunResult
- [ ] Follow-ups: the ask route sees a snapshot, not the file system (addressed by 2.14: `tyr run --agent reviewer` is the tool-using version, mentioned in `--help` and the docs); Ctrl-C exits 130 via the global handler rather than cancelling checks gracefully

### 2.14 Agents (`cli/agents/`, documented in `agents/AGENTS.md`): 100%, Done
- [x] Define agent roles (reviewer, fixer, test-runner): `cli/agents/roles.ts` defines each role as data: a permission ceiling (reviewer read, test-runner execute, fixer write), the tools at or below it, a turn cap (12/20/30) and constant instructions so the cached prompt prefix is stable. The reviewer reports `<severity> path:line - problem` lines, which `agent.ts` turns into findings. The fixer must not weaken checks. Shared contract in `cli/agents/model.ts`
- [x] LLM provider client with API key config: `cli/agents/provider.ts` resolves the key and model from the same settings chain as reviews (`ai.apiKey`, `TYR_API_KEY`, `ANTHROPIC_API_KEY`, `ai.model`; no key means skipped). `runToolLoop` is a manual tool-use loop over the Messages API (`@anthropic-ai/sdk`, injectable client) with prompt caching on the system prompt and the conversation, a turn cap, cancellation, per-request timeouts, progress events and key-scrubbed errors. Tools in `cli/agents/tools.ts`: `read_file`, `list_files` (gitignore-aware), `search`, `git_diff`, `run_check` (only configured checks), `edit_file` (exact unique replace) and `write_file`, all confined to the workspace with bounded output
- [x] Prompting with repo context (profile, diff, failing output): `cli/agents/context.ts` builds the system prompt from the role instructions, then the `tyr.json` profile, CLAUDE.md/README, the working-tree diff (`.tyr/` excluded, untracked files included, secrets masked, trimmed whole-file to about 60 KB) and the failing checks and open findings from `.tyr/state/`, each with its own budget. Context is marked as material, not instructions
- [x] Safety: permission model, dry-run, branch or worktree isolation, human approval before changes: `cli/agents/safety.ts` gates every tool call by the role ceiling and a path policy. Secrets are never read. `.git/` is never touched. Lockfiles, `.claude/settings*.json` and `.tyr/` are never written. Paths outside the workspace are refused, including symlinks pointing out. Every decision is recorded and summarized in the run record. `resolveRunSafety` maps `--apply`/`--isolate`/`--yes` and whether a terminal is present to dry-run, auto, ask or deny (dry run unless `--apply`). Isolated runs use a `tyr/<role>-<time>` branch checked out under `.tyr/worktrees/`, with the user's uncommitted changes copied in and staged so the worktree's diff is only the agent's. An unused worktree is removed and a kept one is listed and removed by `tyr agents list|clean`. In-place changes are approved one by one by a `y/N` prompter that refuses without a terminal
- [x] Coordinating with and correcting a live Claude Code session: `cli/agents/coordinate.ts` keeps a fingerprinted corrections queue (`.tyr/state/corrections.json`) derived from open problems and serious findings, resolved when they go away, plus user and agent entries. `tyr hook` answers with `additionalContext` on UserPromptSubmit, SessionStart and PostToolUse, or in mode `block` with a bounded Stop block (at most two in a row per session, honoring `stop_hook_active`). Setting `agents.correct` (`off`/`context`/`block`, default `context`, env `TYR_AGENTS_CORRECT`)
- [x] Orchestration and wiring: `cli/agents/agent.ts` `runAgent()` goes key, then role, then an up-front refusal when nobody can approve, then the worktree, context, gate, tools filtered to the role, the loop, cleanup and an `AgentRunResult` with changes, the worktree, usage and the safety summary. It never throws. `--correct` queues the summary as an `agent` correction. `tyr run --agent <role>` (with `--apply`, `--isolate`, `--yes`, `--correct`) streams tool calls as progress lines and is recorded like every route (`run.started`/`run.completed`, a `run` report, `RunResult.agent` in `--json`) through a `RunAgentDelegate`, so `cli/engine/` never imports `cli/agents/`. Keyword routing never picks an agent; agents are always explicit. Tests: `tests/agents-*.test.ts` (scripted client: reviewer read-only, fixer dry run, `--apply --isolate` writing only in the worktree, no key, refusal, correction, run recording) and the `tyr run --agent` / `tyr agents` CLI tests
- [ ] Follow-ups: not yet exercised against the live API (all tests use a scripted client); an isolated run leaves its changes uncommitted in the worktree (no commit on the `tyr/` branch, no PR); the `agent.permission` setting is still not read (the `tyr run` flags decide); the daemon does not dispatch agents on its own (e.g. a fixer after a regression); no streaming of the agent's text while a turn is in progress

### 2.15 Integrations (`cli/integrations/`, documented in `integrations/INTEGRATIONS.md`): 55%, Partial
- [x] Claude Code: hook installation and session/transcript reading: built in 2.9 (`tyr hooks install|uninstall|status`, `cli/core/claude-hooks.ts`, `cli/core/claude-transcripts.ts`); the hook also answers with corrections since 2.14 (`agents.correct`)
- [ ] GitHub: PR comments, check runs, issues (via `gh` or the REST API)
- [x] Notifications, terminal and desktop: `cli/engine/alerts.ts` turns each daemon check pass into at most one notification (error: a check regressed or the diff review found a new error/critical finding; warning: a check started failing that never passed; info: failing checks pass again; a still-failing check says nothing). `cli/integrations/notify.ts` delivers it to `notifications.targets`, read at send time: `terminal` is a journaled `notification` event that `tyr watch` highlights and rings the bell for (live, TTY only); `desktop` is a native notification (`cli/integrations/desktop.ts`: WinRT toast via `powershell.exe -EncodedCommand` with the text in env vars, `osascript` argv on macOS, `notify-send --` on Linux). Every notification is journaled with where it was delivered; the daemon's notifier drops the same news within 10 minutes, caps 5 a minute and logs a broken target once. `tyr notify [message] [-t target]` sends one now to test the setup. Verified with a real toast on Windows 10
- [ ] Follow-ups: Slack and webhook targets (accepted by the setting, reported as unsupported); a `notifications.minSeverity` setting; desktop delivery untested on macOS and Linux; `tyr run` and agent runs never notify

### 2.16 Console UI (`cli/ui/reporter.ts`): 100%, Done
- [x] Spinner tasks with succeed, fail, skip and update, one spinner per line
- [x] TTY, CI, `NO_COLOR` and `TERM=dumb` detection. ASCII fallback for legacy Windows consoles
- [x] Cursor restored on exit, SIGINT and SIGTERM
- [x] Send `warn` and `error` to stderr: the reporter's `errorStream` (default `process.stderr` when the main stream is stdout; a caller that already moved output to stderr for `--json`, or a test capturing one stream, keeps one stream). A live spinner steps aside for a line on either stream
- [x] JSON/quiet reporter variant for `--json` and scripting: every command takes the global `--json` (stdout holds only JSON; text moves to stderr via `verbosityOf()` = quiet and a stderr reporter) and `-q`/`--quiet` (warnings and errors only), with `TYR_JSON` / `TYR_QUIET` for scripts; failures under `--json` are one JSON error object (2.17)
- [x] Live multi-line view for `tyr watch` (`cli/ui/watch-panel.ts`): a four-line panel pinned under the scrolling events on a TTY while following: daemon (pid, uptime, crashed), Claude Code (working/idle, current tool), last result per check and the running one with its elapsed time, open problems, findings of the last review, last notification. Seeded from `engine.json` / `findings.json`, folded from live events by a pure `applyPanelEvent`, redrawn in place (cursor up + clear, one write per update, lines cut to the width, 1 s timer). Off with `--no-panel`, filters, `--json`, `--quiet`, pipes, CI, `TERM=dumb`
- [ ] Follow-ups: the panel is untested on a real Windows console (escape handling verified with a fake stream only); a terminal resize mid-follow keeps the width read at start

### 2.17 Error handling and logging: 100%, Done
- [x] Detection modules return a value on every path and degrade to null or empty instead of throwing
- [x] Init failures are reported plainly and set a non-zero exit code
- [x] Best-effort append-only log at `.tyr/logs/tyr.log`
- [x] Typed error classes with user-facing hints (`cli/core/errors.ts`): `UsageError` (2), `NotInitializedError` (3, default hint "Run tyr init first"), `ConfigError` (4, with the offending `file`) and `GitUnavailableError` (1), all `TyrError`s; the throw sites in `run`, `watch`, `hooks`, `notify`, `claude-hooks.ts` and `settings-edit.ts` use them, and `--json` errors name the class in `error.type`
- [x] Log levels, rotation, and a debug flag that dumps stack traces: `cli/core/log.ts` (debug/info/warn/error/silent via `--log-level`, `TYR_LOG_LEVEL`, `--verbose`; rotation at 1 MiB keeping 3); the new global `--debug` (= `TYR_DEBUG=1`) prints the stack and cause chain of every error, expected ones included, and logs at debug level; unexpected errors are appended to `tyr.log` (`cli/core/fatal.ts`)
- [x] Daemon-level crash logging: `runDaemon` routes `uncaughtException` / `unhandledRejection` to a shutdown that logs the stack to `tyr.log` and `daemon.log` (stderr), journals `daemon.crashed` (shown by `tyr watch` and its panel), marks state as error and removes its PID file; `daemon-main.ts` covers failures before that
- [ ] Follow-ups: `tyr start` and `tyr status` still report "not initialized" themselves rather than throwing `NotInitializedError` (same exit code 3); `GitUnavailableError` has no call site yet beyond its definition

### 2.18 Tests: 0%, Not started
- [ ] Pick a test runner (Vitest or `node:test`) and add an `npm test` script
- [ ] Unit tests: `git.ts` parsers (`getStatus`, `parseBranchLine`, `unquotePath`, `getHeadCommit`), `project.ts` detectors (fixture repos), `discovery.ts` (ignore rules, symlinks, depth), `scaffold.ts` (atomic write, malformed JSON)
- [ ] Reporter tests against a fake stream (TTY and non-TTY)
- [ ] Integration test: run `tyr init` in temporary repos (git, non-git, empty repo, detached HEAD)
- [ ] Cross-platform test coverage (Windows paths and line endings)

### 2.19 Lint, format and CI: 0%, Not started
- [ ] ESLint and Prettier (or Biome) config plus `lint` / `format` / `typecheck` scripts. Right now `tyr init` on Tyr itself reports "Linter: none detected"
- [ ] GitHub Actions workflow: install, build, typecheck, lint, test on Linux, macOS and Windows across Node LTS versions
- [ ] Release workflow (tag, then npm publish)

### 2.20 Packaging and distribution (`package.json`): 30%, Partial
- [x] `build` script (`npx tsc`) and `bin` mapping
- [x] MIT `LICENSE`
- [ ] Lowercase package name. npm rejects `"Tyr"` for publishing
- [ ] Fill in `description`, `repository`, `homepage`, `bugs`
- [ ] `"files": ["dist"]` and `"engines": { "node": ">=18" }` (the code needs ES2022 and `Object.hasOwn`)
- [ ] `prepare` / `prepublishOnly` that builds, plus a `clean` script
- [ ] Decide what `pyproject.toml` is for. It is empty (0 bytes), and Python tooling may reject it. Either remove it or define the Python part
- [ ] Verify `npm pack` / `npm i -g` install and that `tyr` runs from `PATH` on every OS

### 2.21 Documentation: 60%, Partial
- [x] One-line project description in `README.md` (being rewritten separately)
- [x] Placeholder docs: `cli/CLI.md`, `cli/engine/ENGINE.md`, `agents/AGENTS.md`, `integrations/INTEGRATIONS.md`
- [x] User documentation site in `docs/` (Mintlify: `docs.json` + 26 `.mdx` pages): introduction and why, quickstart, installation, core concepts; guides for Claude Code, `tyr watch`, checks, review and regressions, reports, team setup; settings, `tyr.json`, ignore patterns, environment variables; a page per command; `.tyr/` layout, event kinds, diff-review rules, supported tools, troubleshooting. Preview with `mint dev` in `docs/`
- [x] Install, quickstart, command reference, `.tyr/` layout and `tyr.json` reference (in `docs/`)
- [ ] Publish the docs site (Mintlify deployment, domain)
- [ ] Trim README.md to an overview that links into `docs/`; parts of it are stale (status table, known limitations)
- [ ] Architecture doc for contributors: daemon, engine, agents, integrations, and data flow
- [ ] CONTRIBUTING and a CLAUDE.md for this repo

---

## 3. Component summary

| # | Component | Weight | % complete | Status | Weighted |
|---|-----------|-------:|-----------:|--------|---------:|
| 1 | CLI framework (`cli/index.ts`) | 5 | 100% | Done | 5.0 |
| 2 | `tyr init` command | 10 | 90% | Partial | 9.0 |
| 3 | Discovery / file scanning | (in 2) | 85% | Partial | — |
| 4 | Git integration | 8 | 100% | Done | 8.0 |
| 5 | Project profiling | 5 | 90% | Partial | 4.5 |
| 6 | `.tyr/` state and storage | 8 | 100% | Done | 8.0 |
| 7 | User configuration | 4 | 100% | Done | 4.0 |
| 8 | Background process (`start`/`stop`) | 9 | 100% | Done | 9.0 |
| 9 | Observation (`watch`, Claude Code, fs, git events) | 9 | 100% | Done | 9.0 |
| 10 | Core engine / orchestration | 9 | 100% | Done | 9.0 |
| 11 | Problem detection / review | 7 | 100% | Done | 7.0 |
| 12 | `tyr status` | 3 | 100% | Done | 3.0 |
| 13 | `tyr run` | 3 | 100% | Done | 3.0 |
| 14 | Agents | 5 | 100% | Done | 5.0 |
| 15 | Integrations (Claude Code, notifications, GitHub) | 5 | 55% | Partial | 2.75 |
| 16 | Console UI / reporter | (in 1, 2) | 100% | Done | — |
| 17 | Error handling and logging | 2 | 100% | Done | 2.0 |
| 18 | Tests | 3 | 0% | Not started | 0 |
| 19 | Lint / format / CI | 1 | 0% | Not started | 0 |
| 20 | Packaging and distribution | 2 | 30% | Partial | 0.6 |
| 21 | Documentation | 2 | 60% | Partial | 1.2 |
| | **Total** | **100** | | | **≈ 90.1 → 90%** |

Discovery and the reporter are counted inside the `init` and CLI weights, because their only consumer today is `init`.

---

## 4. Fully complete vs. partially done

### Fully complete
No component is 100% done. These individual pieces are complete and work as intended. I verified them by building and running `tyr init`:
- **The `init` pipeline as a whole:** find root, git snapshot, scan, profile, atomic scaffold of `.tyr/`, log, and the `--force` / `--no-color` flags.
- **Git read-only snapshot:** `collectGitInfo()` covers branch (including unborn and detached), HEAD commit, porcelain status with conflict, rename and quoting handling, remotes and default remote.
- **Project root resolution and the `.tyr/` location:** `findProjectRoot()` puts `.tyr/` at the absolute repo root.
- **File scan with ignore lists:** `scanProject()`, `IGNORED_DIRS`, `IGNORED_EXTENSIONS`.
- **Project profiling:** languages, package manager, frameworks, toolchain commands, README and CLAUDE.md detection.
- **Atomic JSON persistence primitives:** `writeFileAtomic`, `readConfig`, `readState`, `writeState`, `appendLog`.
- **Console reporter:** spinners, colour and Unicode detection, cursor safety.
- **TypeScript build:** `npm run build` compiles cleanly.

### Partially done (what is missing)
- **CLI framework:** version is duplicated in three places, the banner prints on every call, there are no global flags and no top-level error handler.
- **`tyr init`:** `--start` is a no-op warning, a failed task is not marked `✗`, `--force` discards state history and `.tyr/.gitignore` edits, and there is no handling of the root `.gitignore`.
- **Discovery:** ignores `.gitignore`, has unbounded concurrency, the `bin` ignore is questionable, and there is no incremental scan.
- **Git integration:** read-only and a single snapshot. No diffs, change detection, commit history, event watching or write operations.
- **Project profiling:** no monorepo support, the project name comes from the directory, and command `tool`/`evidence` is dropped from the config.
- **State and storage:** no schema validation or migration, nothing updates state after init, no lock or PID file, no report writer, no log rotation.
- **User configuration:** done. Detection (`tyr.json`) is separate from preferences, which resolve default < global (`~/.config/tyr`) < project (`.tyr/settings.json`) < `TYR_*` env, and `tyr config` reads and edits them. Nothing consumes the preferences yet; that arrives with the engine and agents.
- **Error handling and logging:** no typed errors or levels, and warnings and errors go to stdout.
- **Packaging:** the package name cannot be published, and `files`, `engines`, `prepare` and metadata are missing. `pyproject.toml` is empty.
- **Docs:** placeholders only.

---

## 5. Known issues, bugs and tech debt

1. **Committed `.tyr/tyr.json` is machine-specific and stale.** It holds `"root": "/home/ayaan/Tyr"` and `headCommit: 8316774…` (two commits behind). Because it is tracked, anyone who clones the repo and runs `tyr init` is refused ("already initialized") until they pass `--force`. Either stop tracking it, or store `root` as relative or omit it, and keep volatile fields (HEAD, file count, timestamps) in `state/`.
2. **`.gitkeep` contradiction.** `scaffold()` writes `reports/.gitkeep` "so git keeps reports/ in the tree" (`scaffold.ts`), but the generated `.tyr/.gitignore` ignores `reports/`, so the `.gitkeep` is never tracked.
3. **Stale TODO and unneeded cast in `buildConfig()`** (`scaffold.ts:~89-99`). `DiscoveryResult` already has `ignoredDirs` / `ignoredExtensions`, so the `as unknown as {...}` cast and the "TODO: integrator" comment can go.
4. **The figlet banner prints unconditionally** (`cli/index.ts:16-17`) to stdout on `--version`, on errors and on every subcommand. This breaks scripted or piped use and any future `--json` output.
5. **The version is hard-coded in three places:** `package.json`, `cli/index.ts:21` and `cli/commands/init.ts:30` (`TYR_VERSION`).
6. **Failed task is lost on error.** In `runInit`'s `catch`, `reporter.stop()` clears the current task without resolving it, so the user sees "Initialization failed: …" but not which step failed.
7. **Every reporter line goes to stdout**, including warnings and errors (`ConsoleReporter.emit`).
8. **Duplicate log entry per init.** `scaffold()` appends a log line and `runInit` appends another. "State initialized" and "Logging initialized" are printed unconditionally rather than reflecting any real check.
9. **`--force` is destructive.** It resets `state.json` (`createdAt`, `runCount`) and overwrites `.tyr/.gitignore` without merging.
10. **Scan uses unbounded parallelism** (`Promise.all` per directory in `scanProject`). This risks `EMFILE` on large repos. The scan also ignores the repo's own `.gitignore`.
11. **Questionable ignore entries:** `bin` (skips legitimate source directories) and `.DS_Store` (a file, listed under directories).
12. **Git status timeout fails silently.** On big repos, `git status --untracked-files=all` can exceed `GIT_TIMEOUT_MS = 5000`. The result is `status: null` with no warning to the user.
13. **Detached HEAD is not visible in `tyr.json`.** `git.branch` may hold a tag or short hash and the `detached` flag is not persisted.
14. **The project name comes from the directory basename,** not from `package.json` / `pyproject.toml` (`buildConfig`).
15. **Dead or unused code:** `discoverProject`, `readState`, `writeState`, the exported single detectors in `project.ts`, and `TyrState.status` values `running` / `stopped` / `error`.
16. **Copy-paste and leftover code:** `// init command` header comments in `run.ts`, `start.ts` and `watch.ts`. Commented-out `fs` / `path` imports in every stub and in `index.ts`.
17. **Confusing layout.** The top-level `core/`, `agents/` and `integrations/` directories hold only `.md` placeholders and are outside `tsconfig.json`'s `include` (`cli/**/*.ts`), while real "core" code lives in `cli/core/`.
18. **`pyproject.toml` is empty** (0 bytes). It is not valid for Python tooling, and its purpose is undefined in a TypeScript project.
19. **`package.json` problems:** the name `"Tyr"` is uppercase (npm rejects this on publish), `description` is empty, and there is no `files`, `engines`, `test` or `lint` script.
20. **No tests, linter, formatter or CI.** Tyr's own `init` reports "Tests / Linter / Formatter: none detected" on this repo.
21. **No schema validation** when reading `tyr.json` / `state.json`. A hand-edited file with wrong types passes the `as T` cast and fails later.
22. **`findProjectRoot` git call** uses its own hard-coded 5000 ms timeout instead of sharing `git.ts`'s `runGit`, which duplicates the git invocation logic.

---

## 6. Suggested next steps (priority order)

1. **Fix the `.tyr/` tracking model and the small init bugs.** Stop committing machine-specific `tyr.json` fields, or untrack `.tyr/tyr.json`. Fix the `.gitkeep` / `.gitignore` contradiction. Remove the stale TODO and cast. Mark the failing task `✗`. Make `--force` preserve state history. Read the version from `package.json`. Gate the banner. These are cheap, and they make `init` correct to build on.
2. **Add a test harness and CI now,** while the codebase is small. Use Vitest or `node:test` with unit tests for `git.ts` parsers, `project.ts` detectors (fixture dirs) and `scaffold.ts`. Add an integration test that runs `tyr init` in temporary git and non-git repos. Add ESLint and Prettier, and a GitHub Actions matrix (Linux, macOS, Windows).
3. **Implement `tyr status`.** It is the first consumer of `.tyr/`. Read `tyr.json` and `state.json`, detect "not initialized", show drift (HEAD and file count against the last index), and support `--json`. This exercises the storage layer and adds schema validation and migration.
4. **Design and build the background process.** Implement `tyr start` / `tyr stop` with a PID or lock file, state transitions (`running` / `stopped` / `error`), graceful shutdown, Windows support, and a simple IPC channel. Then make `init --start` call it.
5. **Observation layer (done).** Add a debounced file watcher using the discovery ignore rules, git change detection against `lastIndexedCommit`, and Claude Code hook installation or transcript reading. Emit events into a core event model, and have `tyr watch` stream them.
6. **Core engine plus first detector.** Run the detected `build` / `test` / `lint` / `typecheck` commands from `tyr.json` on change events. Capture results, detect regressions and write findings to `reports/`. This is the first real "reviewer" value.
7. **Git diff and review.** Add diff and commit-log helpers to `git.ts`. Add rule-based checks (deleted tests, secrets, very large diffs).
8. **Agents and `tyr run`.** Add an LLM client and config (API key), a reviewer agent over diffs and failures, and `tyr run "<prompt>"` routing. Corrective agents should work on an isolated branch or worktree and require approval.
9. **Integrations.** Add GitHub PR comments and check runs, plus optional notifications.
10. **Packaging and docs.** Use a lowercase package name, add `files` / `engines` / `prepare`, decide what to do with `pyproject.toml`, add a release workflow, and write the command reference, architecture doc and schema reference.
