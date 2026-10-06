# Tyr: Planning and Status

_Last assessed: 2026-10-04, at commit `9fe8758` ("feat: implement scaffolding for Tyr project initialization")._

## 1. Goal and overall completion

**What Tyr is meant to be** (from `README.md`, `core/CORE.md`, `agents/AGENTS.md`, `integrations/INTEGRATIONS.md` and the CLI command descriptions):

> A background engineering manager and reviewer. It watches what Claude Code is doing, understands the repository's state, detects problems (failing builds, tests, lint, risky changes), and eventually coordinates corrective agents.

The intended user flow is:

1. `tyr init` inspects the repo and writes `.tyr/`.
2. `tyr start` launches a background process.
3. `tyr watch` shows live progress.
4. `tyr status` reports what Tyr knows and is doing.
5. `tyr run "<prompt>"` asks Tyr to do something explicitly.

It is a TypeScript/Node CLI (`commander`, `figlet`) that builds to `dist/cli/index.js` and installs as the `tyr` binary.

**What works today:** `tyr init` works end to end. It finds the root, takes a git snapshot, scans files, profiles languages, frameworks and toolchain commands, writes `.tyr/` atomically and logs the run. I verified this by building a copy of the repo and running it: `npm ci && npm run build` succeeds, and `tyr init` / `tyr init --force` both produce the full `.tyr/` tree. Every other command is a one-line `console.log` stub. None of the actual product exists yet: the background process, observing Claude Code, the problem detection, the agents and the integrations.

### Overall completion: about 29%

I weighted each component by how much it contributes to an end-to-end working Tyr, multiplied the weight by that component's completion, and added up the results (see the table in section 3). The groundwork is the most polished part: init, discovery, git snapshot and project profiling are high quality. But it carries less than a third of the weight. The core product (daemon, observation, detection, agents, integrations) is about 45% of the weight and is at 0%.

---

## 2. Checklist by component

Legend: `[x]` means the code actually implements it, `[ ]` means it is not implemented or only stubbed.

### 2.1 CLI framework (`cli/index.ts`): 80%, Partial
- [x] `commander` program with name and `-v, --version` (`cli/index.ts`)
- [x] All five commands registered (`init`, `start`, `watch`, `status`, `run`)
- [x] `bin` entry `tyr -> dist/cli/index.js` with a `#!/usr/bin/env node` shebang (survives `tsc`)
- [x] ESM (`"type": "module"`, `NodeNext`) and strict TypeScript build that compiles cleanly
- [x] Unknown commands rejected with a non-zero exit (commander default)
- [x] Single source of truth for the version: read from `package.json` by `cli/core/version.ts` (`TYR_VERSION`), used by `cli/index.ts` and `cli/commands/init.ts`
- [ ] Show the figlet banner only for interactive or help output. Today it prints on every call, including `--version`, errors and piped output
- [ ] Global options: `--verbose`/`--quiet`, `--cwd <dir>`, `--json`
- [ ] Top-level handler for uncaught errors and unhandled rejections, with consistent exit codes
- [x] `tyr --help` text and examples for each command

### 2.2 `tyr init` (`cli/commands/init.ts`): 90%, Partial
- [x] Finds the project root, with git toplevel preferred and manifest markers as fallback (`findProjectRoot`, `cli/core/discovery.ts`)
- [x] Puts `.tyr/` at the absolute repo root
- [x] Refuses to re-init when `.tyr/tyr.json` is readable. `--force` overwrites (`isInitialized`)
- [x] Treats an empty or corrupt `.tyr/` as not initialized
- [x] Git detection report: branch (including detached), HEAD commit, working-tree summary, remote (`reportGit`, `describeStatus`)
- [x] File scan with directory and extension ignore lists (`scanProject`, `IGNORED_DIRS`, `IGNORED_EXTENSIONS`)
- [x] Project profile report: language, frameworks, package manager, build/test/lint/format/typecheck commands, README, CLAUDE.md (`reportProject`)
- [x] Records the ignore lists in `tyr.json` (`DiscoveryResult.ignoredDirs/ignoredExtensions`)
- [x] Writes `.tyr/` through `scaffold()` and logs completion
- [x] `--no-color` flag. Sets `process.exitCode = 1` on failure
- [ ] `--start` really starts the background process. Today it only warns "not implemented" (`init.ts:129-133`)
- [ ] Marks the in-flight task as failed (`✗`) when an error occurs. Today `reporter.stop()` drops it silently (`init.ts:137-143`)
- [ ] Offers to add `.tyr/` entries to the project's root `.gitignore`, or documents which parts get committed
- [ ] Optional interactive confirmation or editing of detected commands before writing them
- [ ] Preserves user-edited fields and state history on `--force` instead of overwriting everything

### 2.3 Discovery / file scanning (`cli/core/discovery.ts`): 85%, Partial
- [x] `findProjectRoot()`: tries git first, then climbs looking for markers, never throws
- [x] `isAlreadyInitialized()`: checks for a real directory, not a stray file
- [x] `scanProject()`: skips symlinks, caps depth at 25, sorts output deterministically, records skipped dirs
- [x] `discoverProject()` convenience wrapper (exported but unused)
- [ ] Respect the project's `.gitignore` (for example via `git ls-files -co --exclude-standard` inside a repo). Today only the hard-coded list applies
- [ ] Limit concurrency in the walk. `Promise.all` over every subdirectory can hit `EMFILE` on very large trees
- [ ] Revisit `bin` in `IGNORED_DIRS`, which skips real source such as Node `bin/` and Rust `src/bin`. `.DS_Store` is a file, not a directory
- [ ] User-configurable extra ignore patterns, read from `tyr.json` or a `.tyrignore`
- [ ] Incremental re-scan: diff against the last scan to support change detection

### 2.4 Git integration (`cli/core/git.ts`): 50%, Partial
- [x] Repo detection (`isGitRepository`), which correctly reports bare repos as not being a work tree
- [x] Current branch, including unborn and detached HEAD with a tag or short-hash label (`getCurrentBranch`, `describeDetachedHead`)
- [x] HEAD commit with a robust delimiter (`getHeadCommit`)
- [x] Porcelain v1 status parsing: staged, modified, untracked, conflicted, ahead/behind, renames, C-quoted paths (`getStatus`, `unquotePath`)
- [x] Remotes and default remote resolution (`getRemotes`, `resolveDefaultRemote`)
- [x] Every call is argv-only (no shell injection), time-limited and returns a value on every path (`runGit`)
- [ ] Change detection: compare HEAD and working tree against `state.lastIndexedCommit`
- [ ] Diffs: `git diff` / `git diff --stat` for staged, unstaged and since-commit changes, so Tyr can review them
- [ ] Commit log since a reference point (to see what Claude Code committed)
- [ ] Watch for git events (HEAD, index or ref changes, via fs watch on `.git/` or hooks)
- [ ] Write operations for corrective agents: create branch or worktree, stash, commit, revert. All guarded
- [ ] Handle status timeouts on huge repos. Today a `git status` that exceeds 5s quietly becomes `status: null`
- [ ] Persist the `detached` flag in `tyr.json` (today `git.branch` can silently hold a hash or tag)

### 2.5 Project profiling (`cli/core/project.ts`): 90%, Partial
- [x] Language histogram from the discovery file list. Docs and data formats never count as the primary language (`buildLanguageStats`, `pickPrimaryLanguage`)
- [x] Package manager detection: Corepack field, then lockfiles, then poetry/uv/pip/cargo/go/bundler/composer (`detectPackageManager`)
- [x] Framework detection for JS, Python, Ruby, PHP and Java (`detectFrameworks`)
- [x] Build/test/lint/format/typecheck command resolution: npm scripts first, then config-file fallbacks (`detectCommands`, `resolveCommand`)
- [x] README and CLAUDE.md detection (`detectDocs`)
- [ ] Use the `package.json` / `pyproject.toml` name for `project.name`. Today it is the directory basename (`scaffold.ts` `buildConfig`)
- [ ] Monorepo and workspace awareness (npm/pnpm/yarn workspaces, Cargo workspaces, nested packages)
- [ ] Keep each command's `tool` and `evidence` in `tyr.json`. `commandOf()` currently drops them
- [ ] Check that detected commands actually run (dry run or `--help` probe)

### 2.6 `.tyr/` state and storage (`cli/core/scaffold.ts`, `cli/core/types.ts`): 55%, Partial
- [x] Layout `.tyr/{tyr.json, state/state.json, logs/tyr.log, reports/, .gitignore}` (`resolveTyrPaths`, `scaffold`)
- [x] Atomic writes through a temp file and rename in the same directory (`writeFileAtomic`)
- [x] Safe readers that return `null` on missing or malformed JSON (`readConfig`, `readState`)
- [x] `writeState()` stamps `updatedAt`. Best-effort `appendLog()`
- [x] Typed schemas `TyrConfig` (v1) and `TyrState` (v1)
- [ ] Validate loaded config and state against the schema. Today it is a blind `as T` cast
- [ ] Schema version migration (`version` exists, but nothing reads or upgrades it)
- [ ] Code that updates state: `status` changes between `running`, `stopped` and `error`, plus `runCount` and `lastRunAt`. Nothing calls `writeState` today
- [ ] A lock or PID file so two daemons or commands cannot race on `.tyr/`
- [ ] Report writer for `reports/` (format, naming, retention)
- [ ] Log rotation or size cap, and a `--log-level`
- [ ] Event/history store (what Claude Code did, what Tyr detected, what actions were taken)
- [ ] Decide what is committed. `tyr.json` is tracked but contains an absolute, machine-specific `project.root`

### 2.7 User configuration: 15%, Partial
- [x] `tyr.json` exists and stores detected commands that a user could hand-edit
- [ ] Separate the detected snapshot from user preferences (enabled checks, severity thresholds, agent permissions, notification targets)
- [ ] `tyr config get/set` or documented hand-editing
- [ ] Global, per-user config (`~/.config/tyr`) for API keys and defaults
- [ ] Env var overrides

### 2.8 Background process: `tyr start` (`cli/commands/start.ts`): 0%, Not started
- [ ] Choose the process model: detached child process, or foreground plus a supervisor
- [ ] Spawn a detached daemon and write a PID file to `.tyr/state/`
- [ ] Prevent duplicates (detect a live PID or stale lock)
- [ ] `tyr stop` command (not registered yet)
- [ ] Graceful shutdown on SIGINT/SIGTERM. Persist `status: "stopped"`
- [ ] Windows-compatible daemonizing (`detached`, `windowsHide`, no POSIX-only signals)
- [ ] Recover after a crash: `status: "error"` plus a log entry

### 2.9 Observation of Claude Code and the repo: `tyr watch` (`cli/commands/watch.ts`): 0%, Not started
- [ ] File-system watcher on the project, using the discovery ignore rules and debounced
- [ ] Git event watcher (see 2.4)
- [ ] Claude Code session observation: read the session transcripts or JSONL logs and/or install Claude Code hooks (PreToolUse/PostToolUse/Stop) that report to Tyr
- [ ] IPC channel between the daemon and the CLI (Unix socket or named pipe, or a polled file in `.tyr/state/`)
- [ ] `tyr watch` live view: stream daemon events and progress through the reporter

### 2.10 Core engine / orchestration (`core/`, currently only `core/CORE.md`): 0%, Not started
- [ ] Event bus and model (file changed, commit made, Claude tool call, check result)
- [ ] Repository state model: current diff, last good build or test, open problems
- [ ] Scheduler for when to run checks (on idle, on commit, on Claude "Stop")
- [ ] Execution engine: run detected commands from `tyr.json` with timeouts, output capture and exit-code handling
- [ ] Decide on the code layout. The top-level `core/` is outside `tsconfig.include` (`cli/**/*.ts`) and overlaps with `cli/core/`

### 2.11 Problem detection / review: 0%, Not started
- [ ] Run build, test, lint and typecheck after changes, then parse the results into findings
- [ ] Regression detection (passed before, fails now)
- [ ] Diff review: risky patterns, deleted tests, large unreviewed changes, secrets
- [ ] LLM-based review of diffs against CLAUDE.md and README conventions
- [ ] Findings model with severity, persisted to `reports/`

### 2.12 `tyr status` (`cli/commands/status.ts`): 5%, Not started (stub only)
- [x] Command registered (prints a placeholder)
- [ ] Read `tyr.json` and `state.json` and print the project profile, daemon status, last run and open findings
- [ ] Detect "not initialized" and suggest `tyr init`
- [ ] Show drift: HEAD and file count against the last index
- [ ] `--json` output

### 2.13 `tyr run <prompt>` (`cli/commands/run.ts`): 5%, Not started (stub only)
- [x] Command registered with a required `<prompt>` argument (echoes it)
- [ ] Route the prompt to the engine or an agent, with repo context from `.tyr/`
- [ ] Stream progress, then record the result in state and reports

### 2.14 Agents (`agents/`, currently only `agents/AGENTS.md`): 0%, Not started
- [ ] Define agent roles (reviewer, fixer, test-runner)
- [ ] LLM provider client (likely the Anthropic API or the Claude Agent SDK) with API key config
- [ ] Prompting with repo context (profile, diff, failing output)
- [ ] Safety: permission model, dry-run, branch or worktree isolation, human approval before changes
- [ ] Coordinating with and correcting a live Claude Code session

### 2.15 Integrations (`integrations/`, currently only `integrations/INTEGRATIONS.md`): 0%, Not started
- [ ] Claude Code: hook installation and session/transcript reading
- [ ] GitHub: PR comments, check runs, issues (via `gh` or the REST API)
- [ ] Notifications (terminal, desktop, Slack). Optional

### 2.16 Console UI (`cli/ui/reporter.ts`): 90%, Partial
- [x] Spinner tasks with succeed, fail, skip and update, one spinner per line
- [x] TTY, CI, `NO_COLOR` and `TERM=dumb` detection. ASCII fallback for legacy Windows consoles
- [x] Cursor restored on exit, SIGINT and SIGTERM
- [ ] Send `warn` and `error` to stderr (everything goes to stdout today)
- [ ] JSON/quiet reporter variant for `--json` and scripting
- [ ] Live multi-line view for `tyr watch`

### 2.17 Error handling and logging: 50%, Partial
- [x] Detection modules return a value on every path and degrade to null or empty instead of throwing
- [x] Init failures are reported plainly and set a non-zero exit code
- [x] Best-effort append-only log at `.tyr/logs/tyr.log`
- [ ] Typed error classes (`NotInitializedError`, `GitUnavailableError`, ...) with user-facing hints
- [ ] Log levels, rotation, and a debug flag that dumps stack traces
- [ ] Daemon-level crash logging

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

### 2.21 Documentation: 10%, Partial
- [x] One-line project description in `README.md` (being rewritten separately)
- [x] Placeholder docs: `cli/CLI.md`, `core/CORE.md`, `agents/AGENTS.md`, `integrations/INTEGRATIONS.md`
- [ ] README: install, quickstart, command reference, `.tyr/` layout
- [ ] `cli/CLI.md`: document each command and its flags
- [ ] Architecture doc: daemon, engine, agents, integrations, and data flow
- [ ] `tyr.json` / `state.json` schema reference
- [ ] CONTRIBUTING and a CLAUDE.md for this repo

---

## 3. Component summary

| # | Component | Weight | % complete | Status | Weighted |
|---|-----------|-------:|-----------:|--------|---------:|
| 1 | CLI framework (`cli/index.ts`) | 5 | 80% | Partial | 4.0 |
| 2 | `tyr init` command | 10 | 90% | Partial | 9.0 |
| 3 | Discovery / file scanning | (in 2) | 85% | Partial | — |
| 4 | Git integration | 8 | 50% | Partial | 4.0 |
| 5 | Project profiling | 5 | 90% | Partial | 4.5 |
| 6 | `.tyr/` state and storage | 8 | 55% | Partial | 4.4 |
| 7 | User configuration | 4 | 15% | Partial | 0.6 |
| 8 | Background process (`start`/`stop`) | 9 | 0% | Not started | 0 |
| 9 | Observation (`watch`, Claude Code, fs, git events) | 9 | 0% | Not started | 0 |
| 10 | Core engine / orchestration | 9 | 0% | Not started | 0 |
| 11 | Problem detection / review | 7 | 0% | Not started | 0 |
| 12 | `tyr status` | 3 | 5% | Not started (stub) | 0.15 |
| 13 | `tyr run` | 3 | 5% | Not started (stub) | 0.15 |
| 14 | Agents | 5 | 0% | Not started | 0 |
| 15 | Integrations (Claude Code, GitHub) | 5 | 0% | Not started | 0 |
| 16 | Console UI / reporter | (in 1, 2) | 90% | Partial | — |
| 17 | Error handling and logging | 2 | 50% | Partial | 1.0 |
| 18 | Tests | 3 | 0% | Not started | 0 |
| 19 | Lint / format / CI | 1 | 0% | Not started | 0 |
| 20 | Packaging and distribution | 2 | 30% | Partial | 0.6 |
| 21 | Documentation | 2 | 10% | Partial | 0.2 |
| | **Total** | **100** | | | **≈ 28.6 → 29%** |

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
- **User configuration:** only the detected `tyr.json`. No user preferences, config command or global config.
- **Error handling and logging:** no typed errors or levels, and warnings and errors go to stdout.
- **Packaging:** the package name cannot be published, and `files`, `engines`, `prepare` and metadata are missing. `pyproject.toml` is empty.
- **Docs:** placeholders only.
- **`status` / `run`:** registered stubs that only print a line.

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
5. **Observation layer.** Add a debounced file watcher using the discovery ignore rules, git change detection against `lastIndexedCommit`, and Claude Code hook installation or transcript reading. Emit events into a core event model, and have `tyr watch` stream them.
6. **Core engine plus first detector.** Run the detected `build` / `test` / `lint` / `typecheck` commands from `tyr.json` on change events. Capture results, detect regressions and write findings to `reports/`. This is the first real "reviewer" value.
7. **Git diff and review.** Add diff and commit-log helpers to `git.ts`. Add rule-based checks (deleted tests, secrets, very large diffs).
8. **Agents and `tyr run`.** Add an LLM client and config (API key), a reviewer agent over diffs and failures, and `tyr run "<prompt>"` routing. Corrective agents should work on an isolated branch or worktree and require approval.
9. **Integrations.** Add GitHub PR comments and check runs, plus optional notifications.
10. **Packaging and docs.** Use a lowercase package name, add `files` / `engines` / `prepare`, decide what to do with `pyproject.toml`, add a release workflow, and write the command reference, architecture doc and schema reference.
