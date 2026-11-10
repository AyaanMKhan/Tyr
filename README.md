# Tyr

> A persistent, background engineering manager and reviewer for AI-assisted codebases.

Tyr is a command-line tool that sits **beside** your AI coding agent instead of acting as one. It builds and keeps an on-disk understanding of your repository: where the root is, what it is written in, how it builds, tests, lints and type-checks, and what git state it is in. The goal is to observe what an agent such as Claude Code is doing, check that work against that understanding, flag problems, and eventually coordinate corrective agents to fix them. Today Tyr ships the foundation for this: a complete `tyr init` that profiles a project and writes a `.tyr/` state directory. The observing, reviewing and coordinating layers are planned and are not built yet. This README separates the two throughout.

---

## Table of contents

- [Why Tyr exists](#why-tyr-exists)
  - [The gaps in current AI coding tools](#the-gaps-in-current-ai-coding-tools)
  - [How Tyr is designed to close them](#how-tyr-is-designed-to-close-them)
- [Status at a glance](#status-at-a-glance)
- [Installation](#installation)
  - [Requirements](#requirements)
  - [Build from source](#build-from-source)
  - [Put `tyr` on your PATH](#put-tyr-on-your-path)
- [Command reference](#command-reference)
  - [Global options](#global-options)
  - [Environment variables](#environment-variables)
  - [`tyr init`](#tyr-init)
  - [`tyr start`](#tyr-start)
  - [`tyr watch`](#tyr-watch)
  - [`tyr status`](#tyr-status)
  - [`tyr config`](#tyr-config)
    - [How settings resolve](#how-settings-resolve)
  - [`tyr run <prompt>`](#tyr-run-prompt)
  - [`tyr hooks`](#tyr-hooks)
  - [Exit codes](#exit-codes)
- [How `tyr init` works, step by step](#how-tyr-init-works-step-by-step)
  - [1. Locating the project root](#1-locating-the-project-root)
  - [2. Already-initialized check](#2-already-initialized-check)
  - [3. Git detection](#3-git-detection)
  - [4. File scan and ignore lists](#4-file-scan-and-ignore-lists)
  - [5. Project identification](#5-project-identification)
  - [6. Writing `.tyr/`](#6-writing-tyr)
- [The `.tyr/` directory](#the-tyr-directory)
  - [What gets committed](#what-gets-committed)
  - [Settings (`settings.json`)](#settings-settingsjson)
  - [`tyr.json` schema](#tyrjson-schema)
  - [`state/state.json` schema](#statestatejson-schema)
  - [`logs/tyr.log` format](#logstyrlog-format)
- [Claude Code integration](#claude-code-integration)
  - [Install](#install)
  - [What is recorded](#what-is-recorded)
  - [Privacy](#privacy)
  - [Uninstall](#uninstall)
  - [Transcripts](#transcripts)
- [Global config](#global-config)
- [Architecture](#architecture)
- [Roadmap](#roadmap)
- [Development](#development)
- [Known limitations and quirks](#known-limitations-and-quirks)
- [License](#license)

---

## Why Tyr exists

AI coding agents are good at writing code within a single session. They are much weaker at the work a senior engineer or engineering manager does around that code: keeping track of what the project is, noticing when work drifts or breaks something, and holding the line across many sessions and many agents. Tyr is built for that surrounding role.

### The gaps in current AI coding tools

Claude Code, Cursor, GitHub Copilot, Aider and Codex CLI each handle in-session code generation well. The problems below come from how these tools are structured, not from model quality. Each tool has partial answers to some of them, as noted.

| Gap | What happens today | What Tyr targets |
|---|---|---|
| **The agent checks its own work** | The agent that writes the change also decides whether it is done. When it believes tests pass, or skips them, nothing independent pushes back. | A **separate process** with its own view of the repo that reviews what the coding agent did. *(Planned.)* |
| **Project knowledge is rebuilt in every session** | Each new session works out again how to build and test the project, often by guessing (`npm test`? `pytest`? `make`?) or by reading a hand-written `CLAUDE.md`, `.cursorrules` or `AGENTS.md`, which goes stale. | `tyr init` detects build, test, lint, format and type-check commands **from evidence** (manifests, lockfiles, config files, `package.json` scripts) and stores them in machine-readable form in `.tyr/tyr.json`. *(Implemented.)* |
| **Memory is prose, not state** | Where persistent memory exists (`CLAUDE.md`, rules files, chat history), it is natural-language text for the model to read. No structured record says "last indexed at commit X, N files, status Y". | `.tyr/state/state.json` records lifecycle status, the last indexed commit, file count and run counters, so later runs can tell **what changed since last time**. *(Schema and writer implemented. Consumers planned.)* |
| **State is tied to one tool and one session** | Context lives in a vendor's session, IDE workspace or conversation, and it is lost or fragmented when you switch tools, restart or run agents in parallel. | `.tyr/` lives at the **repository root**, is tool-agnostic plain JSON, and `tyr.json` is designed to be committed so a whole team shares one profile. *(Implemented.)* |
| **No awareness of git state** | Agents often learn about branch, uncommitted changes, divergence from upstream or merge conflicts only when a command fails. | `tyr init` collects branch (including detached-HEAD labels), HEAD commit, staged, modified, untracked and conflicted files, ahead/behind counts and remotes. The HEAD hash is recorded for change detection. *(Implemented.)* |
| **No coordination between agents** | When several agents or sessions work on one repo, none of them oversees the others. | Tyr is designed to **coordinate corrective agents**: detect a problem, then send a focused agent to fix it. *(Planned. See `agents/` and `core/`.)* |
| **Opaque progress** | Long agent runs are a black box until they finish. | `tyr watch` and `tyr status` are reserved for showing what Tyr knows and is doing. *(Stubs only.)* |

In short, existing tools are **actors**. Tyr is meant to be the **supervisor**: persistent, independent of any one agent, and grounded in facts about the repository instead of in a conversation.

### How Tyr is designed to close them

The code follows a few design principles that are already visible:

1. **Detect from evidence.** Every detected fact carries the file that proved it (`evidence` in `ProjectCommand` and `PackageManagerInfo`). If Tyr cannot prove a command, it records `null` instead of guessing. The comment in `project.ts` puts it this way: *"report null rather than inventing a command Tyr cannot run."*
2. **Total, silent detectors.** Every detection module (`discovery`, `git`, `project`) is *total*. A missing git binary, a repo with no commits, a malformed `package.json` or an unreadable directory all return a documented empty or `null` value instead of throwing. Detectors never print. All output goes through one reporter, so `status`, `watch` and `run` can reuse the same detectors later.
3. **Crash-safe state.** `tyr.json` and `state.json` are written atomically (temp file in the same directory, then `rename`), so an interrupted run never leaves a half-written config.
4. **Shared config, private runtime data.** `tyr.json` (the detection snapshot) and `settings.json` (your preferences) are meant to be committed. `state/`, `logs/` and `reports/` are git-ignored per machine.
5. **Minimal dependencies.** Git is driven by shelling out to the real `git` binary. The spinner, colours and terminal detection are hand-written ANSI. The only runtime dependencies are `commander` and `figlet`.

---

## Status at a glance

| Area | State |
|---|---|
| CLI skeleton (`commander`), version flag, help | Implemented |
| `tyr init`: root discovery, git detection, file scan, project profiling, `.tyr/` scaffolding, logging | **Implemented** |
| `tyr init --force` / `--reset` / `--no-color` | Implemented |
| `tyr init --start` | Flag accepted. Prints a warning that the background process is not implemented yet. |
| `tyr config` (`list`, `get`, `set`, `unset`, `path`) and the layered settings resolver | Implemented |
| `tyr start`, `tyr watch`, `tyr status`, `tyr run` | **Stubs**: each prints one placeholder line |
| Claude Code session observation (`tyr hooks`, see [Claude Code integration](#claude-code-integration)) | Implemented |
| Background observer of Claude Code, problem detection, corrective agents | **Planned** |
| Integrations (Claude Code, GitHub, Git) | **Planned** (`integrations/INTEGRATIONS.md`) |
| Python component (`pyproject.toml`) | Placeholder (empty file) |
| Test suite / linter | None yet |

---

## Installation

Tyr is not yet published to npm. Build it from source.

### Requirements

- **Node.js**: ES2022 target with `module: NodeNext`, so use a modern LTS. Development has been done on Node 22. `project.ts` uses `Object.hasOwn`, which needs Node 16.9 or later.
- **npm** (lockfile is `package-lock.json`)
- **git** on your `PATH`. It is optional at runtime: without it Tyr falls back to manifest-based root detection and reports "Git repository: none".

### Build from source

```bash
git clone <this-repo-url> Tyr
cd Tyr
npm install
npm run build        # runs `npx tsc`, emitting to dist/
```

The compiled entry point is `dist/cli/index.js`, which starts with a `#!/usr/bin/env node` shebang.

Run it directly:

```bash
node dist/cli/index.js --help
```

### Put `tyr` on your PATH

`package.json` declares `"bin": { "tyr": "dist/cli/index.js" }`, so after building:

```bash
npm link             # symlinks the `tyr` command globally
tyr --version        # -> 1.0.0
```

To remove it later, run `npm unlink -g Tyr`.

---

## Command reference

Every invocation prints a `figlet` "Tyr" ASCII banner first. That includes `--help` and `--version`.

```
  _____
 |_   _|   _ _ __
   | || | | | '__|
   | || |_| | |
   |_| \__, |_|
       |___/
```

```
Usage: Tyr [options] [command]

Options:
  -v, --version   Output version of Tyr
  -h, --help      display help for command

Commands:
  init [options]  Initialize Tyr in the current project
  start           Starts Tyr
  watch           Allows user to see the progress Tyr is making
  status          Tells user what Tyr knows / is doing
  run <prompt>    Explicitly tell Tyr to perform something
  help [command]  display help for command
```

### Global options

| Flag | Description |
|---|---|
| `-v`, `--version` | Print the Tyr version (`1.0.0`) |
| `-h`, `--help` | Show help. `tyr help <command>` or `tyr <command> --help` shows help for one command. |

### Environment variables

Tyr's settings resolve in layers, lowest precedence first: built-in defaults, the global config (`~/.config/tyr/config.json`), the project's `.tyr/settings.json`, then environment variables (see [How settings resolve](#how-settings-resolve)). Each setting has a `TYR_*` variable that overrides every file; `tyr config list` shows when one is in effect. A few more variables stand in for global flags, for CI and scripts; an explicit flag always wins over them.

| Variable | Overrides | Accepted values |
|---|---|---|
| `TYR_CHECKS_BUILD` | `checks.build` | `true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off` (any case) |
| `TYR_CHECKS_TEST` | `checks.test` | same as above |
| `TYR_CHECKS_LINT` | `checks.lint` | same as above |
| `TYR_CHECKS_FORMAT` | `checks.format` | same as above |
| `TYR_CHECKS_TYPECHECK` | `checks.typecheck` | same as above |
| `TYR_SEVERITY` | `severity.threshold` | `info` \| `warning` \| `error` |
| `TYR_AGENT_PERMISSION` | `agent.permission` | `read-only` \| `suggest` \| `edit` |
| `TYR_NOTIFY` | `notifications.targets` | Comma-separated targets (`terminal,desktop`), or `none` for no targets |
| `TYR_MODEL` | `ai.model` | Any model id |
| `TYR_API_KEY` | `ai.apiKey` (secret) | Any string |
| `ANTHROPIC_API_KEY` | `ai.apiKey` (secret) | Used only when `TYR_API_KEY` is unset |
| `TYR_QUIET` | `--quiet` | Boolean, as above. Ignored when `--quiet` or `--verbose` is passed |
| `TYR_VERBOSE` | `--verbose` | Boolean. Ignored when `--quiet` or `--verbose` is passed. Implies debug logging unless `--log-level` or `TYR_LOG_LEVEL` is set |
| `TYR_JSON` | `--json` | Boolean. `TYR_JSON=0` turns an inherited `TYR_JSON=1` off |
| `TYR_LOG_LEVEL` | `--log-level` | `debug` \| `info` \| `warn` \| `error` \| `silent`. Inherited by the background process |

- **Empty means unset.** A variable set to an empty or whitespace-only value is ignored, as if it were not set. CI systems often export missing secrets as `""`, and that should never wipe a configured value. So `TYR_API_KEY=""` still falls back to `ANTHROPIC_API_KEY`. To turn notifications off from the environment, use `TYR_NOTIFY=none` (`tyr config set notifications.targets none` is the same spelling for the files).
- **Bad values never stop Tyr.** An invalid value (`TYR_SEVERITY=fatal`) is ignored with a warning naming the variable, and the lower layers apply. Warnings never include the value of `TYR_API_KEY` or `ANTHROPIC_API_KEY`.
- **API key.** `TYR_API_KEY` wins over `ANTHROPIC_API_KEY`, so an existing Anthropic setup works without Tyr-specific configuration.
- `NO_COLOR` (any value) disables colored output, per [no-color.org](https://no-color.org).

The full list is exported as `ENV_VARS` from `cli/core/env-settings.ts`.

### `tyr init`

**Status: implemented.**

```
tyr init [options]
```

Inspects the current project and creates the `.tyr/` directory at the project root. You can run it from **any subdirectory**: Tyr resolves the real root first (see [step 1](#1-locating-the-project-root)).

| Option | Description |
|---|---|
| `-f`, `--force` | Re-initialize even if `.tyr/tyr.json` already exists. Detection runs again and refreshes everything it owns (git snapshot, file and language counts, ignore lists, root, versions), but keeps what you changed: commands you edited in `tyr.json`, keys Tyr does not recognise, and state history (`createdAt`, `runCount`, `lastRunAt`, `status` and any extra fields). Other files in `state/` are left alone, and the log is **appended** to. |
| `--reset` | Re-initialize from scratch (implies `--force`). Overwrites `tyr.json` and `state/state.json`, discarding command edits, extra keys and state history. `scan.extraIgnore` is still kept. `.tyr/settings.json` is never touched: it holds your preferences, not detection output. |
| `-s`, `--start` | Initialize, then start the background process. **The background process is not implemented yet.** Tyr finishes `init`, prints a warning and writes a `WARN` line to the log. |
| `--gitignore` | Add `/.tyr/` to the project's root `.gitignore` without asking (creating the file if needed). Does nothing if `.tyr` is already ignored. |
| `--no-gitignore` | Never read, change or ask about the root `.gitignore`. |
| `--no-color` | Disable ANSI colours. Colour is also turned off automatically when `NO_COLOR` is set, when `TERM=dumb`, or when stdout is not a TTY. |
| `-h`, `--help` | Show help for `init`. |

**Exit codes:** `0` on success. `1` if the project is already initialized and `--force` was not given, or if any step throws. In the failure case Tyr prints `Initialization failed: <reason>` instead of claiming success.

**Example: first run in a TypeScript/npm git repo**

```text
$ tyr init

Initializing Tyr...

✓ Project root: /home/you/Tyr
✓ Git repository detected
✓ Branch: main
✓ Commit: 8534726 initial commit
✓ Working tree: clean
- Remote: none configured
✓ Files scanned: 23
✓ Project type: TypeScript
✓ Package manager: npm
✓ Build: tsc
- Tests: none detected
- Linter: none detected
- Formatter: none detected
✓ Type checker: tsc
✓ README.md detected
- CLAUDE.md not found

Creating .tyr...
✓ Configuration created
✓ State initialized
✓ Logging initialized

Tyr initialized successfully.
```

(This is real output from running `tyr init` against this repository. The banner is omitted.) A `✓` line is a positive finding. A dimmed `-` line is a normal "not found" result. A non-empty working tree is summarised like `3 modified, 2 untracked (1 ahead, 2 behind)`.

**Example: already initialized**

```text
$ tyr init
Initializing Tyr...

✓ Project root: /home/you/Tyr

! Project is already initialized (.tyr/tyr.json exists).
Re-run with --force to re-detect (keeping your edits), or --reset to start over.
$ echo $?
1
```

**Example: force re-init and request start**

```text
$ tyr init --force --start
Initializing Tyr...

✓ Project root: /home/you/Tyr
Existing configuration found - re-detecting, keeping your edits (--force).
✓ Git repository detected
...
Tyr initialized successfully.

! --start was requested, but the background process is not implemented yet.
```

**Terminal behaviour.** In an interactive terminal each step shows an animated spinner (braille frames at 80 ms) that resolves into its final `✓`, `✗` or `-` line. In CI (`CI` set to anything other than empty, `0` or `false`), with piped output, or with `TERM=dumb`, the spinner is off and every task prints exactly one line, which keeps logs clean. On legacy Windows consoles that lack `WT_SESSION`, `ConEmuANSI=ON`, `TERM_PROGRAM=vscode` or `TERM`, Tyr uses ASCII glyphs (`√`, `x`, `| / - \`) instead of Unicode. The hidden cursor is always restored on exit, including on `Ctrl-C` and `SIGTERM`.

### `tyr start`

**Status: stub.** It prints `Starting the process...` and does nothing else.

```
tyr start
```

Intended purpose: start Tyr's long-running background process, which observes the coding agent and the repository. This is the same process `tyr init --start` will launch.

**What the background process watches** (`runDaemon` in `cli/core/daemon.ts`):

- **Git** (`cli/core/git-watch.ts`): HEAD, the index, refs and in-progress merges/rebases, recorded as `git.*` events.
- **Project files** (`cli/core/fs-watch.ts`): one recursive file watcher on the project root, using the same ignore rules as the init scan (built-in directories/extensions, `scan.extraIgnore` in `tyr.json`, `.tyrignore`, and `.gitignore` inside a git work tree). `.git/` and `.tyr/` are never reported. Changes are debounced (300 ms of quiet, at most 2 s) and recorded as one `fs.changed` event per burst, listing added, modified and removed paths (50 per list, plus a total). Each file is checked against its size and modification time, so a file created and deleted within one burst is not reported, while a bare `touch` counts as modified. If the platform cannot watch recursively, or the watcher fails (for example on inotify limits on Linux), it falls back to rescanning every 5 s. The `daemon.started` event records which mode is in use (`fsWatch: "watch"` or `"poll"`).

### `tyr watch`

**Status: stub.** It prints `Watching Project ...`.

```
tyr watch
```

Intended purpose (from the command description): *"Allows user to see the progress Tyr is making"*, a live view of what the background process is observing and doing.

### `tyr status`

**Status: stub.** It prints `Status of Project ...`.

```
tyr status
```

Intended purpose: *"Tells user what Tyr knows / is doing"*. The building blocks already exist: `readConfig()` and `readState()` in `cli/core/scaffold.ts`, and the git and discovery detectors, which are deliberately silent so `status` can reuse them.

### `tyr config`

**Status: implemented.**

```
tyr config [list] [--reveal]
tyr config get <key> [--show-origin] [--reveal]
tyr config set <key> <value> [-g, --global]
tyr config unset <key> [-g, --global]
tyr config path [-g, --global]
```

Views and changes [settings](#settings-settingsjson). `set` and `unset` write the project's `.tyr/settings.json` (committed, shared with your team) unless you pass `--global`, which writes your per-user [global config](#global-config) instead. The keys are the ones in the [settings table](#settings-settingsjson). `tyr config` prints data, so it never draws the banner.

| Subcommand | What it does |
|---|---|
| `list` (the default) | Every key with its effective value and where it came from: the layer (`default`, `global`, `project`, `env`) and the file or variable. Problems found while reading the files go to stderr. |
| `get <key>` | The effective value as bare text on stdout, in the same spelling `set` accepts: `true`/`false`, plain strings, lists comma-joined (`terminal,desktop`). An empty list and an unset value print an empty line. `--show-origin` prefixes `<layer>:<source>` and a tab. `--json` gives the exact typed value. |
| `set <key> <value>` | Parses the value for the key's type and stores it. Booleans accept `true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off`. Lists are comma-separated; `none` (or `""`) means an empty list, the same spelling as `TYR_NOTIFY=none`. A value of `-` is read from stdin, which keeps an API key out of your shell history. |
| `unset <key>` | Removes the key from that one file, so the next layer down applies again. Unsetting a key that is not there is not an error. |
| `path` | Prints the absolute path of the file `set` would write, for hand-editing: `$EDITOR "$(tyr config path --global)"`. |

```text
$ tyr config set checks.lint false
✓ Set checks.lint = false in .tyr/settings.json

$ echo "$MY_KEY" | tyr config set --global ai.apiKey -
✓ Set ai.apiKey = sk-…mnop in ~/.config/tyr/config.json

$ tyr config set --global notifications.targets terminal,desktop
✓ Set notifications.targets = terminal,desktop in ~/.config/tyr/config.json

$ tyr config
KEY                    VALUE             ORIGIN
checks.build           true              default
checks.test            true              default
checks.lint            false             project (.tyr/settings.json)
checks.format          false             default
checks.typecheck       true              default
severity.threshold     warning           default
agent.permission       suggest           default
notifications.targets  terminal,desktop  global (~/.config/tyr/config.json)
ai.model               claude-opus-5-5   default
ai.apiKey              sk-…mnop          global (~/.config/tyr/config.json)

Global config:    ~/.config/tyr/config.json
Project settings: .tyr/settings.json

$ tyr config get checks.lint
false
$ tyr config get --show-origin checks.lint
project:/home/you/app/.tyr/settings.json	false

$ tyr config unset checks.lint
✓ Removed checks.lint from .tyr/settings.json
Effective value: true (default)

$ TYR_CHECKS_TEST=1 tyr config set checks.test false
✓ Set checks.test = false in .tyr/settings.json
! TYR_CHECKS_TEST is set in this environment and overrides checks.test, so the new value will not take effect in this shell; unset TYR_CHECKS_TEST to use it
```

**Secrets.** `ai.apiKey` is shown masked everywhere (`sk-…abcd`: a short kind prefix and the last four characters; values under 12 characters as `****`). Only `get --reveal` and `list --reveal` print it in full. `tyr config set ai.apiKey …` without `--global` is refused (exit `2`) because `.tyr/settings.json` is committed; use `--global` or `TYR_API_KEY`. `tyr config unset ai.apiKey` *is* allowed on the project file, to remove a key committed by mistake.

**Safety.** Only the one key changes, and Tyr never rewrites a file it would damage. If the target file is malformed JSON, was written by a newer Tyr, or contains invalid values or (in the project file) unknown keys or a secret that a rewrite would silently drop, nothing is written and Tyr exits `4` (`CONFIG`) naming every problem, so you can fix it by hand. The global writer keeps keys it does not recognise, so unknown keys there do not block `--global`. Project writes take the `.tyr/` lock. Setting a value the file already has writes nothing.

**Shadowed values.** The value is saved even when a higher layer still overrides it (a `TYR_*` variable in the current shell, or for `--global` the project's own `settings.json`); a warning says which one and how to clear it.

**Exit codes.** `2` for an unknown key (with a "did you mean" suggestion and the list of valid keys), an invalid value or a secret without `--global`; `3` for `set`/`unset` without `--global` before `tyr init`; `4` as above. Reading (`list`, `get`, `path`) never fails because of a bad file: like every other command it reports the file and uses the remaining layers.

**`--json` shapes:** `list` prints `{ ok, root, files: { global, project }, settings: [{ key, value, layer, source, env, secret?, masked? }], warnings, errors }`; `get` prints `{ ok, key, value, origin: { layer, source }, warnings, errors }`; `set`/`unset` print `{ ok, action, key, scope, file, changed, previous?, value?, effective: { value, origin }, shadowedBy, warnings }`; `path` prints `{ ok, scope, file, exists }`. Secrets are masked in all of them unless `--reveal` is given.

#### How settings resolve

Every setting is resolved key by key from four layers; the highest layer that sets a key wins outright:

| Precedence | Layer | Where | Written by | May hold `ai.apiKey` |
|---|---|---|---|---|
| 4 (highest) | `env` | `TYR_*` variables (and `ANTHROPIC_API_KEY`), see [Environment variables](#environment-variables) | your shell or CI | Yes |
| 3 | `project` | `.tyr/settings.json`, see [Settings](#settings-settingsjson) | `tyr config set`, or by hand | **No** (committed) |
| 2 | `global` | `~/.config/tyr/config.json`, see [Global config](#global-config) | `tyr config set --global`, or by hand | Yes |
| 1 (lowest) | `default` | built into Tyr (`DEFAULT_SETTINGS`) | | |

Lists such as `notifications.targets` are replaced, never merged: a project that sets `[]` means "notify nowhere" whatever your global file lists. A malformed file is ignored as a whole (with an error) and an invalid value or unknown key is ignored on its own (with a warning); either way the other layers still apply. `tyr config list` shows the winning layer for every key. The resolver is `resolveSettings()` in `cli/core/settings.ts`.

### `tyr run <prompt>`

**Status: stub.** It echoes the prompt.

```
tyr run <prompt>
```

```text
$ tyr run "fix the failing tests"
Running the user command... fix the failing tests
```

Intended purpose: *"Explicitly tell Tyr to perform something"*, an on-demand instruction to Tyr instead of waiting for it to act on its own. `TyrState.runCount` and `lastRunAt` exist to track these runs.

### `tyr hooks`

```
tyr hooks install [--shared] [--command <cmd>]
tyr hooks uninstall [--shared | --local]
tyr hooks status
```

Connects Tyr to Claude Code by adding hook entries to `.claude/settings.local.json` (or `.claude/settings.json` with `--shared`), so every session start, prompt, tool call and stop is recorded in `.tyr/state/events.jsonl`. All three honour `--json`, `--quiet` and `--cwd`. See [Claude Code integration](#claude-code-integration).

### Exit codes

Every command exits with one of these codes (defined in `cli/core/errors.ts`), so scripts can branch on `$?` without parsing output:

| Code | Name | Meaning |
|---|---|---|
| `0` | `OK` | Success, including `--help` and `--version`. |
| `1` | `FAILURE` | The command ran and failed (for example the background process would not start), or an unexpected error. |
| `2` | `USAGE` | The command line is wrong: unknown command or option, missing argument, invalid option value, or a `--cwd` directory that does not exist. Running `tyr` with no command also exits `2`. |
| `3` | `NOT_INITIALIZED` | The project has no `.tyr/` yet (for example `tyr start` before `tyr init`). |
| `4` | `CONFIG` | `.tyr/` or a settings file is invalid or was written by a newer Tyr. Fix the file rather than re-running `tyr init`. |
| `130` | `INTERRUPTED` | Stopped with `Ctrl-C`. The hidden cursor is restored first. |

Errors are printed to stderr as `error: <message>`, sometimes followed by a `hint:` line. An unexpected error (a bug) also says how to see its stack trace: rerun with `--verbose` or set `TYR_DEBUG=1`. If the project already has a `.tyr/` directory, the stack is also appended to `.tyr/logs/tyr.log`. With `--json`, a failure that stops a command before it can print its own result writes a single object to stdout instead, so stdout is always JSON:

```json
{ "ok": false, "error": { "message": "unknown option '--bogus'", "code": "USAGE", "exitCode": 2 } }
```

Commands that report their own `--json` result, such as `tyr start` and `tyr stop`, keep that shape on failure, and the process still exits with the matching code.

---

## How `tyr init` works, step by step

`cli/commands/init.ts` contains only wiring. Each step below is a separate module under `cli/core/`, and the steps exchange data only through the types in `cli/core/types.ts`.

### 1. Locating the project root

`findProjectRoot()` in `cli/core/discovery.ts`:

1. **Git is authoritative.** It runs `git rev-parse --show-toplevel` (5 s timeout) from the current directory. If that succeeds, the git top-level directory is the root. Running `tyr init` from `src/components/` therefore still puts `.tyr/` at the **absolute root of the repository**.
2. **Manifest fallback.** If git is missing, the directory is not a repo, or the call times out, Tyr climbs from the current directory toward the filesystem root. It stops at the first directory that contains any of:
   `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, `build.gradle`, `Gemfile`, `composer.json`, `.git`
3. **Last resort.** If nothing matches, the current directory is the root.

This function never throws.

### 2. Already-initialized check

The project counts as initialized only if `.tyr/` is a **directory** *and* `.tyr/tyr.json` parses as a JSON object. An empty or partial `.tyr/` left by an interrupted run does not block a re-run, and you do not need `--force` for it. A hand-edited `tyr.json` that contains `null`, an array or a scalar is also treated as "not initialized".

### 3. Git detection

`collectGitInfo()` in `cli/core/git.ts` shells out to `git` with an argv array, never a shell string, so branch names and paths cannot be shell-injected. Every call has a 5 s timeout and a 16 MB output buffer. If `git rev-parse --is-inside-work-tree` does not print `true` (not a repo, a bare repo, or no git), Tyr reports `- Git repository: none` and continues.

Otherwise five lookups run **in parallel**:

| Lookup | Git command(s) | Notes |
|---|---|---|
| Current branch | `git branch --show-current` → `git rev-parse --abbrev-ref HEAD` | `--show-current` still names an *unborn* branch on a fresh `git init`. The second command covers git < 2.22. Tyr **detects** the branch and does not create one. |
| Detached HEAD label | `git describe --all --exact-match HEAD` → `git rev-parse --short HEAD` | On a detached HEAD, `branch` holds a tag name or short hash and `detached: true`. |
| HEAD commit | `git log -1` with a custom format | Hash, short hash, subject, author, ISO-8601 date. Fields are split on `\x1f\x1e` so commit subjects cannot break parsing. Returns `null` on a repo with no commits. |
| Working tree | `git status --porcelain=v1 --branch --untracked-files=all` | Classified into staged, modified, untracked and conflicted (`DD AU UD UA DU AA UU`). A file can be both staged and modified (`MM`). Renames record the destination path. C-quoted and octal-escaped paths (spaces, non-ASCII) are decoded. Ahead/behind come from the `##` line and are `null` when there is no upstream. |
| Remotes | `git remote -v` | Fetch and push URLs are merged into one entry per remote. |
| Default remote | `git rev-parse --abbrev-ref @{upstream}` | Picks the remote the current branch tracks, else `origin`, else the first remote, else `null`. |

### 4. File scan and ignore lists

`scanProject()` walks the tree from the root:

- Sibling directories are walked **in parallel**.
- **Symlinks are skipped** outright, so the walk cannot loop or leave the root.
- Depth is capped at **25** levels. Deeper directories are recorded as skipped.
- Unreadable directories (`EACCES` and similar) are recorded as skipped instead of failing the run.
- The `.tyr/` directory itself is never scanned.
- The output is sorted, so repeated scans of an unchanged tree produce identical results.

**Ignored directories** (matched by name at any depth):

| Category | Directories |
|---|---|
| VCS / tooling | `.git` `.idea` `.vscode` `.turbo` `.cache` `.parcel-cache` `.pnpm-store` `.terraform` `.DS_Store` |
| JS/TS | `node_modules` `bower_components` `dist` `build` `out` `.next` `.nuxt` `.svelte-kit` `coverage` |
| Python | `__pycache__` `.venv` `venv` `.mypy_cache` `.pytest_cache` `.ruff_cache` `.tox` |
| Other build/vendor output | `target` `vendor` `.gradle` `bin` `obj` `Pods` |

**Ignored file extensions** (case-insensitive), meaning files with no useful text content:

| Category | Extensions |
|---|---|
| Binaries / objects | `.exe .dll .so .dylib .bin .o .a .obj .class .jar .war .pyc .pyo .wasm .pack .idx` |
| Archives / disk images | `.zip .tar .gz .7z .rar .iso .dmg .pkg .deb .rpm` |
| Data / model blobs | `.db .sqlite .sqlite3 .pt .pth .onnx` |
| Images | `.png .jpg .jpeg .gif .webp .ico .svgz .bmp .tiff` |
| Fonts | `.woff .woff2 .ttf .otf .eot` |
| Media | `.mp4 .mov .avi .mkv .mp3 .wav .flac .ogg` |
| Documents | `.pdf` |

Both lists, sorted, are written to `tyr.json` under `scan`. A later run can then tell whether the scan rules changed underneath an existing index.

> These lists are hard-coded in `cli/core/discovery.ts`. Tyr does **not** read your `.gitignore` yet, and the lists cannot be configured yet.

### 5. Project identification

`profileProject()` in `cli/core/project.ts` reads the root directory once (case-insensitively) and a fixed set of small manifests (`pyproject.toml`, `requirements.txt`, `Pipfile`, `setup.py`, `setup.cfg`, `Cargo.toml`, `go.mod`, `Gemfile`, `composer.json`, `pom.xml`, `build.gradle`, `build.gradle.kts`, plus `package.json`). Every detector answers from that shared context, and none of them walks the tree a second time.

**Languages.** Tyr counts the scanned files by extension (TypeScript, JavaScript, Python, Go, Rust, Java, Kotlin, C, C++, C#, Ruby, PHP, Swift, Shell, HTML, CSS/SCSS/Sass/Less, SQL, Markdown, JSON, YAML). Percentages are relative to *classified* files only. The **primary language** is the most common *code* language. Markdown, JSON and YAML appear in the breakdown but never count as primary, so a repo with 3 `.ts` files and 40 `.md` files is a TypeScript project.

**Package manager**, first match wins:

1. Corepack `"packageManager"` field in `package.json` (npm / pnpm / yarn / bun)
2. Lockfiles: `bun.lockb` / `bun.lock` → bun, `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `package-lock.json` → npm
3. `package.json` with no lockfile → npm
4. `poetry.lock` or a `[tool.poetry]` section → poetry
5. `uv.lock` → uv, `Pipfile.lock` → pipenv, `requirements.txt` → pip, `Cargo.toml` → cargo, `go.mod` → go, `Gemfile` → bundler, `composer.json` → composer

**Frameworks** come from npm dependencies (Next.js, Nuxt, SvelteKit, Angular, Astro, React Native/Expo, Electron, NestJS, React, Vue, Svelte, Solid, Express, Fastify, Koa, Hono, Tailwind CSS, Vite, Webpack), root config files (`next.config.*`, `vite.config.*`, `angular.json`, `manage.py` → Django, `artisan` → Laravel, and others), and Python, Ruby, PHP and Java manifests (Django, Flask, FastAPI, Rails, Laravel, Spring). `.tsx`/`.jsx` files with no JSX framework declared imply React. SvelteKit hides the redundant Svelte entry.

**Commands.** For each category (build, test, lint, format, typecheck), resolution goes in this order:

1. **A matching `package.json` script always wins**, because that is what the project's own authors run. Script aliases are `build`; `test`; `lint`; `format`/`fmt`/`prettier`; `typecheck`/`type-check`/`tsc`/`check-types`. The command is spelled with the detected JS package manager, for example `pnpm run lint` or `npm test`.
2. Otherwise, **tool evidence plus a known invocation**:

| Category | Tools detected (in priority order) → fallback command |
|---|---|
| Build | Cargo → `cargo build`, Go → `go build ./...`, Makefile → `make` |
| Test | Jest → `npx jest`, Vitest → `npx vitest run`, Mocha → `npx mocha`, Playwright → `npx playwright test`, Cypress → `npx cypress run`, pytest → `pytest`, `cargo test`, `go test ./...`, JUnit (detected, but no command because Maven and Gradle invocations differ) |
| Lint | ESLint → `npx eslint .`, Biome → `npx biome lint .`, Ruff → `ruff check .`, Flake8 → `flake8`, Pylint → `pylint .`, golangci-lint → `golangci-lint run`, Clippy → `cargo clippy` |
| Format | Prettier → `npx prettier --write .`, Biome → `npx biome format .`, Black → `black .`, rustfmt → `cargo fmt`, gofmt → `gofmt -w .` |
| Typecheck | `tsconfig.json` → `npx tsc --noEmit`, mypy → `mypy .`, Pyright → `pyright` |

3. Otherwise **`null`**. Tyr never makes up a command.

**Docs.** Tyr finds the root README (`README.md`, `.markdown`, `.rst`, `.txt` or bare `README`, case-insensitive) and `CLAUDE.md`. Recording `CLAUDE.md` is the first hook into the Claude Code workflow Tyr is meant to supervise.

### 6. Writing `.tyr/`

`scaffold()` in `cli/core/scaffold.ts`:

1. Creates `.tyr/`, then `state/`, `logs/` and `reports/` (recursively, so it is safe over a partial tree).
2. Writes `tyr.json` **atomically** (temp file `.<name>.<pid>.<timestamp>.tmp` in the same directory, then `rename`).
3. Writes `state/state.json` atomically, and creates `settings.json` if it does not exist yet (never overwritten, not even by `--force` or `--reset`; see [Settings](#settings-settingsjson)).
4. Writes `.tyr/.gitignore` and `reports/.gitkeep`.
5. **Appends** a line to `logs/tyr.log`. Init never truncates the log, so history survives `--force`; size is capped by rotation instead (see [`logs/tyr.log` format](#logstyrlog-format)).

Before merging, any existing `tyr.json` / `state.json` is run through the schema migration chain (`cli/core/migrate.ts`). A file written by a *newer* Tyr is never overwritten: init stops and asks you to upgrade Tyr or pass `--reset`. The write itself runs under the `.tyr/` lock (`cli/core/lock.ts`), so two concurrent inits, or an init racing a daemon state update, serialize instead of losing each other's changes.

`init.ts` then appends a second `tyr init completed - N files indexed` line. Log writes are best-effort: a failed log write never fails a command.

Finally `init` checks the project's root `.gitignore` (see [What gets committed](#what-gets-committed)). If it does not already ignore `.tyr` (any of `/.tyr/`, `.tyr/`, `.tyr`, `/.tyr`, optionally with `*` or `**`), then inside a git repo on an interactive terminal it asks `Add /.tyr/ to the project's .gitignore? (Y/n)`. With no terminal (piped, CI, `--json`) it only prints a hint to use `--gitignore`. Outside a git repo it stays silent. The entry is appended under a `# Tyr` comment, keeping the file's line endings, and written atomically. `--json` reports the outcome as `"gitignore": "added" | "present" | "skipped" | "declined"`.

---

## The `.tyr/` directory

```
<repo-root>/
└── .tyr/
    ├── .gitignore          # ignores logs/, reports/, state/
    ├── tyr.json            # detection snapshot (see "What gets committed")
    ├── settings.json       # your preferences (see "Settings")
    ├── state/
    │   ├── state.json      # runtime lifecycle state (per machine, ignored)
    │   ├── scan.json       # scan manifest for change detection (ignored)
    │   ├── events.jsonl    # append-only event history, rotated (ignored)
    │   ├── tyr.lock        # short-lived write lock, present only while held
    │   ├── requests/       # pending CLI -> daemon requests (short-lived)
    │   └── daemon.pid      # present while the background process runs
    ├── logs/
    │   ├── tyr.log         # activity log, rotated at 1 MiB (ignored)
    │   └── daemon.log      # daemon stdout/stderr, rotated at start (ignored)
    └── reports/
        ├── .gitkeep
        └── <yyyyMMdd-HHmmss>-<kind>-<slug>.{json,md}   # reports (ignored)
```

| Path | Purpose | Committed? |
|---|---|---|
| `tyr.json` | The project's identity: languages, frameworks, package manager, the exact build/test/lint/format/typecheck commands, git snapshot, docs and the scan rules used. This is the shared, machine-readable source of truth that every later Tyr command reads. | **Yes**, so the team shares one profile |
| `settings.json` | Your preferences: which checks run, the severity threshold, agent permission, notification targets, model. Created once by `tyr init`, then edited by you; Tyr never regenerates it. See [Settings](#settings-settingsjson). | **Yes**, so the team shares one set of preferences |
| `state/state.json` | Tyr's lifecycle on this machine: status, last indexed commit, last file count and run counters. Used for change detection between runs. | No |
| `logs/tyr.log` | Timestamped log of Tyr activity, filtered by `--log-level` and rotated at 1 MiB (3 old files kept). | No |
| `state/events.jsonl` | Structured event history, one JSON object per line: daemon start/stop/crash, git events, project file changes (`fs.changed`), `tyr init`, and later Claude Code activity and actions taken. Written by `cli/core/events.ts`, rotated at 5 MiB. | No |
| `reports/` | Review/check reports written by `cli/core/reports.ts`: a JSON document plus a rendered Markdown copy per report. Pruned to 100 reports / 30 days by default; override with `"reports": { "maxCount": N, "maxAgeDays": N }` in `tyr.json`. | No |
| `.gitignore` | Keeps the per-machine runtime output above out of git. | Yes |
| `state/scan.json` | Scan manifest (file fingerprints) that `tyr status` / `tyr watch` diff against. | No (under `state/`) |

The "Committed?" column describes the design: `.tyr/.gitignore` already keeps `state/`, `logs/` and `reports/` out of git on its own, so without any root `.gitignore` entry you would commit `tyr.json`, `settings.json` and `.tyr/.gitignore`.

### What gets committed

Since config schema v2, `tyr.json` is **portable**: `project.root` is stored as `"."` (the directory containing `.tyr/`) and resolved to the absolute path only in memory when Tyr reads the file, so the committed copy is identical on every machine. Sharing `tyr.json` and `.tyr/.gitignore` is the intended setup. The remaining churn is `git.headCommit`, `project.fileCount` and `initializedAt`, which change when someone re-runs `tyr init --force`. That churn is confined to the detection snapshot: preferences live in `settings.json`, which init never rewrites (see [Settings](#settings-settingsjson)). Teams that want Tyr purely local can still ignore the whole directory:

| Choice | Root `.gitignore` | What git tracks |
|---|---|---|
| Ignore everything (default offer, `--gitignore`) | `/.tyr/` | Nothing under `.tyr/`. Every clone runs its own `tyr init`. |
| Share the profile (decline, or `--no-gitignore`) | no entry | `.tyr/tyr.json`, `.tyr/settings.json` and `.tyr/.gitignore`. `state/`, `logs/` and `reports/` stay ignored by `.tyr/.gitignore`. |

A narrower root entry such as `.tyr/state/` would add nothing, since `.tyr/.gitignore` already covers the runtime output. If you share `tyr.json`, expect it to change in diffs when someone re-runs `tyr init --force`.

### Settings (`settings.json`)

`tyr.json` is **detection only**: what `tyr init` found, refreshed by every `--force`. What Tyr should *do* about it lives in `.tyr/settings.json`, which you edit and commit. Tyr creates it on the first `tyr init` and never overwrites it afterwards, not even with `--force` or `--reset` (`--reset` resets detection, not preferences). Delete it by hand to get a fresh starter file.

The starter file is just `{ "version": 1 }`: every setting follows its default (and your [global config](#global-config)) until you add it here. Tyr never writes detection-dependent values into it, because the file is not regenerated and a value frozen today (say, linting off because there is no linter yet) would silently outlive the reason for it. A check whose command was not detected simply does not run.

Keys nest as dotted paths suggest (`checks.test` is `{ "checks": { "test": … } }`); `version` is the file format version (missing means 1).

| Key | Type | Default | Meaning |
|---|---|---|---|
| `checks.build` | boolean | `true` | Run the detected build command |
| `checks.test` | boolean | `true` | Run the detected test command |
| `checks.lint` | boolean | `true` | Run the detected linter |
| `checks.format` | boolean | `false` | Run the detected formatter check |
| `checks.typecheck` | boolean | `true` | Run the detected type checker |
| `severity.threshold` | `info` \| `warning` \| `error` | `warning` | Lowest severity that gets reported |
| `agent.permission` | `read-only` \| `suggest` \| `edit` | `suggest` | What the reviewing agent may do: read only, propose patches, or edit files |
| `notifications.targets` | array of strings | `["terminal"]` | Where findings are sent, e.g. `"terminal"`, `"desktop"`, `"webhook:https://…"` |
| `ai.model` | non-empty string | `claude-opus-5-5` | Model used for reviews |
| `ai.apiKey` | string or null | `null` | API key. **Not allowed here**, see below |

Loading is lenient but validated: an unknown key or a value of the wrong type is ignored with a warning, and the rest of the file still applies. Malformed JSON makes Tyr ignore the whole file (an error, not a crash). A file whose `version` is newer than this Tyr understands is ignored with a warning and never overwritten.

**Secrets never go in `settings.json`.** It is committed, so `ai.apiKey` is refused when Tyr writes the file and ignored (with a warning) if you add it by hand. Put it in the global config or the environment.

`settings.json` is the *project* layer. Settings resolve in this order, later winning: built-in defaults < global config (`~/.config/tyr/config.json`) < project `.tyr/settings.json` < `TYR_*` environment variables; see [How settings resolve](#how-settings-resolve). Edit the file by hand (`tyr config path` prints its location) or with [`tyr config set`](#tyr-config), which changes one key at a time and refuses to rewrite a file it cannot fully understand.

### `tyr.json` schema

Defined as `TyrConfig` in `cli/core/types.ts`. Below is an abridged example from this repository:

```jsonc
{
  "version": 2,                       // config schema version (see "Schema versions")
  "tyrVersion": "1.0.0",              // Tyr version that wrote it
  "initializedAt": "2026-09-14T16:50:02.050Z",
  "project": {
    "name": "Tyr",                    // basename of the root directory
    "root": ".",                      // relative to the directory containing .tyr/
    "primaryLanguage": "TypeScript",
    "languages": [
      { "name": "TypeScript", "fileCount": 12, "percentage": 60 },
      { "name": "Markdown",   "fileCount": 5,  "percentage": 25 },
      { "name": "JSON",       "fileCount": 3,  "percentage": 15 }
    ],
    "frameworks": [],
    "packageManager": "npm",
    "fileCount": 23
  },
  "commands": {                       // { command, tool, evidence }, or null
    "build": { "command": "npm run build", "tool": "tsc", "evidence": "package.json" },
    "test": null,
    "lint": null,
    "format": null,
    "typecheck": { "command": "npx tsc --noEmit", "tool": "tsc", "evidence": "tsconfig.json" }
  },
  "git": {
    "isRepo": true,
    "branch": "main",
    "remote": "origin",               // default remote name
    "headCommit": "83167741fb7b8fee9ac0262a9696a8714fad7297"  // full hash
  },
  "docs": { "readme": "README.md", "claudeMd": null },
  "scan": {
    "ignoredDirs": [".DS_Store", ".cache", ".git", "..."],
    "ignoredExtensions": [".7z", ".a", ".avi", "..."]
  }
}
```

Newer files also carry a `detected.commands` section: the command string detection produced for each slot when the file was written. Leave it alone. `tyr init --force` compares `commands` against it to tell your hand edits (kept) apart from detection changes (refreshed). A command entry with `"source": "user"` is always kept. Configs without the section keep any command that differs from fresh detection.

### Schema versions and validation

Every read of `tyr.json` and `state.json` goes through migrate, then validate (`cli/core/migrate.ts`, `cli/core/schema.ts`) instead of a blind cast:

- **Migration.** A missing `version` counts as v1. Older documents are upgraded step by step in memory; config v1 to v2 makes `project.root` relative and converts old bare-string commands to the object form. A document from a *newer* Tyr is refused, never downgraded. Config is upgraded on disk only by `tyr init`, so a read-only command never dirties a tracked file. State is written back after a migration.
- **Validation.** Required fields with the wrong type are errors that name the path (`commands.test.command: expected non-empty string, got number`). Missing fields that detection can refill get defaults plus a warning. Unknown keys are preserved, so hand-added settings survive `--force`.
- `readConfig` / `readState` return `null` for missing, malformed, newer or invalid files. `loadConfig` / `loadState` return the same value plus `errors`, `warnings` and the migrations applied, for commands that need to explain a problem.

### `state/state.json` schema

Defined as `TyrState`:

```json
{
  "version": 1,
  "status": "initialized",
  "createdAt": "2026-10-04T19:29:37.919Z",
  "updatedAt": "2026-10-04T19:29:37.919Z",
  "lastIndexedCommit": "8534726a5ed86d067965a82c7114e270d6efb065",
  "lastScanFileCount": 23,
  "runCount": 0,
  "lastRunAt": null
}
```

| Field | Meaning |
|---|---|
| `status` | `"initialized"` \| `"running"` \| `"stopped"` \| `"error"`. Set by `tyr init`, then by the background process through the locked transitions in `cli/core/state-store.ts` (`markRunning`, `markStopped`, `markError`). Guards ensure a late-exiting daemon never overwrites a newer daemon's `running`. |
| `lastIndexedCommit` | Full HEAD hash at the last index, for detecting new commits. |
| `lastScanFileCount` | File count at the last scan. |
| `runCount` / `lastRunAt` | Incremented and stamped each time the background process starts (`markRunning`). Updates are read-modify-write under the `.tyr/` lock, so concurrent writers never lose an increment. |
| `pid` / `startedAt` | Pid and start time of the running background process; `pid` is cleared on stop. |
| `updatedAt` | Stamped automatically by `writeState()` on every write. |

### `logs/tyr.log` format

```
[<ISO-8601 timestamp>] <LEVEL> <message>
```

```
[2026-10-04T19:29:37.921Z] INFO tyr init — scaffolded .tyr/ with Tyr 1.0.0 (23 files scanned)
[2026-10-04T19:29:37.922Z] INFO tyr init completed - 23 files indexed
[2026-10-04T19:31:02.114Z] INFO Background process started (pid 4242); watching git (watch), watching files (watch)
```

Levels are `DEBUG`, `INFO`, `WARN` and `ERROR`. Continuation lines of multi-line messages (stack traces) are indented so every record still starts with a timestamp.

- **Level.** `--log-level <debug|info|warn|error|silent>` on any command, else `--verbose` (debug), else the `TYR_LOG_LEVEL` environment variable, else `info`. The background process inherits the level of the `tyr start` that launched it. `--quiet` and `--json` affect terminal output only, never the log.
- **Rotation.** Before each append, a `tyr.log` of 1 MiB or more is rotated to `tyr.log.1`, `tyr.log.2`, `tyr.log.3` (oldest dropped). `daemon.log` is rotated the same way each time the daemon starts. Concurrent rotation by two processes is safe and loses no lines.

---

## Claude Code integration

Tyr observes Claude Code sessions through [Claude Code hooks](https://code.claude.com/docs/en/hooks): Claude Code runs a command at each session start, prompt, tool call and stop, and passes it a JSON description of what is happening on stdin. Tyr's command (`tyr hook`, hidden from `--help`) turns each one into an event in `.tyr/state/events.jsonl`, where `tyr watch` and the background process pick it up. No daemon has to be running for events to be recorded.

### Install

```text
$ tyr init                       # events are only recorded in an initialized project
$ tyr hooks install
✓ Installed Claude Code hooks in .claude/settings.local.json (10 events)
New Claude Code sessions pick this up; in a running one, review it under /hooks.
$ tyr hooks status
✓ .claude/settings.local.json: installed for all 10 events
- .claude/settings.json: not installed
```

`tyr hooks install` adds one entry for each of `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `SubagentStop`, `Notification`, `PreCompact` and `SessionEnd`, merged into whatever the file already holds: your own hooks and other settings are never changed. Running it again is a no-op. A settings file that is not valid JSON is left alone and the command exits 4 (`CONFIG`). Each entry looks like this:

```json
{
  "matcher": "*",
  "hooks": [
    {
      "type": "command",
      "command": "node /path/to/Tyr/dist/cli/index.js hook # tyr:claude-hook",
      "timeout": 10
    }
  ]
}
```

The `# tyr:claude-hook` comment is how Tyr finds its own entries again. `matcher` is only written for the tool events.

**Where:** by default `.claude/settings.local.json`, which is personal (Claude Code keeps it out of version control; Tyr warns if your `.gitignore` does not). `--shared` writes `.claude/settings.json`, which is committed and applies to everyone working on the repository.

**Which command:** by default the absolute path of the Tyr you ran, as `node "<path>/dist/cli/index.js" hook`. That works from a development checkout and when `tyr` is not on the `PATH` Claude Code sees, but the path only exists on your machine, so with `--shared` Tyr warns unless you choose a portable command: `tyr hooks install --shared --command "npx tyr hook"` (or `"tyr hook"`).

### What is recorded

One event per hook, with `source: "claude"`:

| Kind | Hook | `message` example | Extra `data` |
|---|---|---|---|
| `claude.session_start` | `SessionStart` | `Session started (startup)` | `source`, `model` |
| `claude.prompt` | `UserPromptSubmit` | `Prompt: "fix the failing tests"` | `prompt` (preview), `promptLength` |
| `claude.tool_use` | `PreToolUse` | `Edit src/a.ts`, `Bash: npm test` | `tool`, `toolUseId`, `input`, `file` |
| `claude.tool_result` | `PostToolUse`, `PostToolUseFailure` | `Bash: npm test (failed)` | as above plus `success`, `durationMs`, `error` (first line) |
| `claude.stop` / `claude.subagent_stop` | `Stop` / `SubagentStop` | `Claude finished responding` | `lastMessage` (truncated), `agentType` |
| `claude.notification` | `Notification` | `Notification: Claude needs your permission` | `notificationType` |
| `claude.compact` | `PreCompact` | `Compacting context (auto)` | `trigger` |
| `claude.session_end` | `SessionEnd` | `Session ended (prompt_input_exit)` | `reason` |
| `claude.hook` | anything else | `SubagentStart hook` | |

Every event also carries `sessionId`, `hookEvent`, `transcriptPath` and `cwd`. `input` is a one-line summary of a tool call: the Bash command, the file path (relative to the project), a Grep/Glob pattern, a URL, or for unfamiliar tools (MCP servers) only the *names* of the arguments. Long values are cut to 300 characters.

`tyr hook` never prints anything and always exits 0, quickly: Claude Code treats a hook's exit code 2 as "block this tool call" and feeds some hooks' stdout to the model, so a recording problem must never turn into a change in the session. It reads stdin for at most 2 seconds, gives up entirely after 5, and silently skips projects without a `.tyr/` (it never creates one). If Claude is working inside a worktree that has no `.tyr/`, the session's starting directory (`CLAUDE_PROJECT_DIR`) is tried instead.

### Privacy

The journal is a local file under `.tyr/state/`, which is never committed, but it is still a copy of what happened in your session, so Tyr keeps as little as it needs:

- **Prompts** are stored as an 80-character preview and their length, never in full. Prompts are where pasted API keys and passwords end up.
- **File contents and tool output are never stored**: not what `Write`/`Edit` wrote, not what `Read` returned, not a command's output. Only *which* file or command.
- **Likely secrets are masked** in everything that is kept (prompt previews, Bash commands, messages): `sk-…`, GitHub/Slack tokens, AWS key ids, JWTs, and `password=`/`token:`/`Authorization:` style values become `[redacted]`. This is pattern matching, so treat it as a safety net rather than a guarantee.
- `PreCompact` custom instructions are reduced to a yes/no.

### Uninstall

```text
$ tyr hooks uninstall
✓ Removed Tyr's hooks from .claude/settings.local.json (10 events)
- No Tyr hooks in .claude/settings.json
```

Without flags both settings files are cleaned; `--local` or `--shared` limits it to one. Only Tyr's entries are removed, and a settings file left completely empty is deleted. Recorded events stay in `.tyr/state/events.jsonl`.

### Transcripts

Claude Code also keeps a JSON Lines transcript of every session in `~/.claude/projects/<project path with every non-alphanumeric character replaced by "-">/<session id>.jsonl`. `cli/core/claude-transcripts.ts` can find a project's transcripts (`findSessionTranscripts`) and summarize one (`readTranscriptSummary`: session id, start and end time, prompt count, tool calls by tool). It is not wired into a command yet; it exists to look back at sessions that ran before the hooks were installed. The format is Claude Code's private detail, so hooks remain the primary source.

---

## Global config

Settings that belong to *you* rather than to a repository live in one per-user file, `config.json`, outside every project:

| Platform | Location |
|---|---|
| Linux, macOS | `~/.config/tyr/config.json` (or `$XDG_CONFIG_HOME/tyr/config.json` when `XDG_CONFIG_HOME` is set to an absolute path) |
| Windows | `%APPDATA%\tyr\config.json` (or `$XDG_CONFIG_HOME\tyr\config.json` as above) |

Set `TYR_CONFIG_HOME` to use a different directory on any platform (the file is then `$TYR_CONFIG_HOME/config.json`); handy for tests and portable setups.

What belongs there: your API key (`ai.apiKey`) and personal defaults you want in every project, such as `ai.model`, `notifications.targets` or which `checks` to run. Project settings in `.tyr/settings.json` override it, and `TYR_*` environment variables override both. Unlike the project file, the global file may hold secrets, so Tyr creates its directory with mode `700` and the file with mode `600`, and warns on every load if a file holding a key is readable by other users (fix with `chmod 600 ~/.config/tyr/config.json`).

```json
{
  "version": 1,
  "ai": { "model": "claude-opus-5-5", "apiKey": "sk-..." },
  "notifications": { "targets": ["terminal", "desktop"] }
}
```

Unknown keys and invalid values are reported as warnings and ignored; the rest of the file still applies. Malformed JSON is an error and the whole file is ignored. A file written by a newer Tyr is read best-effort with a warning but never rewritten. Implemented in `cli/core/global-config.ts`.

Change it with `tyr config set --global <key> <value>` (`-` reads the value from stdin, the safe way to store an API key), or open it with `$EDITOR "$(tyr config path --global)"`. `tyr config set --global` keeps keys this Tyr does not recognise.

---

## Architecture

```
Tyr/
├── cli/                         # User-facing CLI (the only compiled code today)
│   ├── index.ts                 # Entry: banner, commander program, registers commands
│   ├── CLI.md                   # Placeholder for CLI docs
│   ├── commands/
│   │   ├── init.ts              # `tyr init` wiring: runs detectors, reports, scaffolds
│   │   ├── start.ts             # stub
│   │   ├── watch.ts             # stub
│   │   ├── status.ts            # stub
│   │   ├── config.ts            # `tyr config` list/get/set/unset/path wiring
│   │   ├── hooks.ts             # `tyr hook` (run by Claude Code), `tyr hooks` install/uninstall/status
│   │   └── run.ts               # stub
│   ├── core/
│   │   ├── types.ts             # Shared contracts: DiscoveryResult, GitInfo, ProjectProfile,
│   │   │                        #   TyrConfig, TyrState, Reporter, TaskHandle
│   │   ├── discovery.ts         # Root detection, init check, file walk, ignore lists
│   │   ├── git.ts               # All git detection (branch, HEAD, status, remotes)
│   │   ├── project.ts           # Languages, package manager, frameworks, commands, docs
│   │   ├── settings-types.ts    # Settings contract: keys, defaults, parsing, validation
│   │   ├── settings.ts          # resolveSettings(): default < global < project < env, masking
│   │   ├── settings-edit.ts     # Safe one-key read-modify-write behind `tyr config set/unset`
│   │   ├── project-settings.ts  # .tyr/settings.json (project layer)
│   │   ├── global-config.ts     # ~/.config/tyr/config.json (global layer)
│   │   ├── env-settings.ts      # TYR_* variables (env layer)
│   │   ├── claude-hooks.ts      # Hook payload -> journal event; edits .claude/settings*.json
│   │   ├── claude-transcripts.ts # Finds and summarizes ~/.claude/projects/*/<session>.jsonl
│   │   └── scaffold.ts          # Writes .tyr/, atomic JSON I/O, readConfig/readState/
│   │                            #   writeState/appendLog accessors
│   └── ui/
│       └── reporter.ts          # Dependency-free animated console reporter
├── core/CORE.md                 # Planned: orchestration + state + execution engine
├── agents/AGENTS.md             # Planned: Tyr's AI agents
├── integrations/INTEGRATIONS.md # Planned: Claude Code, GitHub, Git integrations
├── .tyr/                        # Tyr's own profile of this repo (dogfooding)
├── package.json                 # bin: tyr -> dist/cli/index.js; ESM ("type": "module")
├── tsconfig.json                # ES2022, NodeNext, strict, compiles cli/** to dist/
└── pyproject.toml               # Empty placeholder
```

**Data flow of `tyr init`:**

```
findProjectRoot ──► isInitialized? ──► collectGitInfo ──► scanProject ──► profileProject
   (discovery)        (discovery +        (git)            (discovery)       (project)
                       scaffold)                                                 │
                                                                                 ▼
                        reporter (ui) ◄── every step reports ── InitSnapshot {discovery, git, project}
                                                                                 │
                                                                                 ▼
                                                              scaffold() ──► .tyr/  (+ appendLog)
```

**How the CLI talks to the daemon:** there is no socket or named pipe. Daemon to CLI, the channel is the event journal `.tyr/state/events.jsonl`: the daemon (and the CLI, and later Claude Code hooks) append to it, and `followEvents()` in `cli/core/event-stream.ts` tails it live, using `fs.watch` on `state/` with a polling fallback, buffering half-written lines and following rotation by inode so no event is lost or duplicated. It can replay history first (`backlog` / `since`), so a reader that attaches late misses nothing. CLI to daemon, `cli/core/daemon-requests.ts` drops small JSON request files into `.tyr/state/requests/` (written atomically, consumed by deletion) that the daemon services from its poll timer: `stop`, and `ping`, which the daemon answers with a `daemon.pong` event that `pingDaemon()` waits for. A journal works identically on Windows, needs no daemon to be running for writers to record history, and lets several writers that are not the daemon share one ordered stream. The price is up to one poll period (500 ms) of request latency. `tyr stop` still uses its original `state/daemon.stop` file, which the daemon also polls.

**Rules the code keeps:**

- `commands/*` contain wiring only. Real work lives in `core/*`.
- `core/*` modules **never print** and **never throw for normal conditions**. They return data.
- `ui/reporter.ts` owns **every** line of user output. Exactly one spinner owns the current line at a time.
- Modules communicate only through the types in `core/types.ts`, which the file calls "a fixed API".

**Top-level `core/`, `agents/` and `integrations/`** contain only description files for now. Their stated intent:

- **`core/`**: "Orchestration + state + execution engine for Tyr… responsible for managing the state of the system, executing commands, and orchestrating the flow of data between different components."
- **`agents/`**: the AI agents Tyr will coordinate.
- **`integrations/`**: "Will support Claude Code, Github, Git etc."

---

## Roadmap

These items come from stated intent in the code, command descriptions and the `*.md` placeholders. None of them is implemented yet.

- [x] CLI skeleton with `init`, `start`, `watch`, `status`, `run`
- [x] `tyr init`: root discovery (git-first), git snapshot, filtered scan, project profiling, atomic `.tyr/` scaffold, logging
- [ ] **`tyr start`**: long-running background process (also triggered by `tyr init --start`) that sets `state.status` to `running`/`stopped`/`error`
- [x] **Observe Claude Code**: hooks record every prompt, tool call and stop in the event journal (`tyr hooks install`)
- [ ] **Change detection**: compare the current HEAD and file count with `lastIndexedCommit` / `lastScanFileCount` and re-index incrementally
- [ ] **Review and problem detection**: run the recorded `commands.*` (build, test, lint, typecheck) against the agent's changes and write findings to `.tyr/reports/`
- [ ] **Corrective agents**: dispatch focused agents (`agents/`) to fix detected problems, coordinated by the engine in `core/`
- [ ] **`tyr status`**: show what Tyr knows (`tyr.json`), its lifecycle (`state.json`) and live git state
- [ ] **`tyr watch`**: live progress view of the background process
- [ ] **`tyr run <prompt>`**: on-demand instructions to Tyr, tracked via `runCount` / `lastRunAt`
- [ ] **Integrations**: Claude Code, GitHub, Git
- [ ] Configurable ignore lists / `.gitignore` awareness
- [ ] Test suite and linting for Tyr itself

---

## Development

```bash
npm install
npm run build                 # tsc -> dist/
node dist/cli/index.js init   # try it
npx tsc --noEmit              # type-check only (the command Tyr detects for itself)
```

- **Language / modules:** TypeScript, strict mode, ESM (`"type": "module"`, `NodeNext`). Relative imports must use the **`.js` extension** (for example `import { scaffold } from "../core/scaffold.js"`).
- **Adding a command:** create `cli/commands/<name>.ts` exporting `register<Name>Command(program: Command)` and register it in `cli/index.ts`. Keep it to wiring: put detection or state logic in `cli/core/` and all output in the reporter.
- **Adding a detector:** make it *total* (return `null` or empty on any normal failure), *silent* (no `console.log`), and record its `evidence`. Extend the contracts in `cli/core/types.ts` if needed.
- **Persisting state:** use the accessors in `scaffold.ts` (`readConfig`, `readState`, `writeState`, `appendLog`) instead of touching `.tyr/` directly. They give you atomic writes and automatic `updatedAt` stamping.
- **Version bumps:** the version string `1.0.0` appears in `package.json`, `cli/index.ts` and `TYR_VERSION` in `cli/commands/init.ts`. Keep all three in sync.
- **Testing `init` safely:** this repo dogfoods `.tyr/` and commits `tyr.json`. Running `tyr init --force` here rewrites it with the current HEAD and file count. To experiment without touching it, copy the repo elsewhere (for example `git archive HEAD | tar -x -C /tmp/tyr-test`).
- There is no test runner, linter or formatter configured yet. Contributions that add them are welcome.

---

## Known limitations and quirks

- Only `init` does real work. `start`, `watch`, `status` and `run` are placeholders, and `--start` only warns.
- The ASCII banner prints on every invocation, including `--version` and `--help`, and before machine-readable output.
- The help header reads `Usage: Tyr` (the program name is set to `"Tyr"`), while the installed binary is `tyr`.
- `tyr.json` is portable since schema v2 (`project.root` is stored as `"."`), but it still churns when someone re-runs `tyr init --force`: `git.headCommit`, `project.fileCount` and `initializedAt` change. Preferences in `settings.json` are not affected (see [What gets committed](#what-gets-committed)).
- `project.name` is the root directory's basename, not the `name` from `package.json`.
- Ignore lists are fixed and do not read `.gitignore`. Because they match directory names at any depth, a source folder named `bin`, `build`, `out` or `vendor` is skipped.
- A `scaffold.ts` comment still carries a `TODO` saying the ignore lists are not passed through. They are now: `init.ts` attaches them to `DiscoveryResult`, and they appear in `tyr.json`.
- `discoverProject()` in `discovery.ts` is exported but unused. `init` calls the individual functions so it can report each step.

---

## License

[MIT](LICENSE) © 2026 Ayaan Khan
