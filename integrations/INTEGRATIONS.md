# Integrations

How Tyr connects to the tools around it. The code lives in
`cli/integrations/` (delivery to the outside world) and `cli/core/`
(Claude Code hooks and transcripts, which the daemon observes).

| Integration | Status | Code |
|---|---|---|
| Claude Code: hooks and transcripts | Done | `cli/core/claude-hooks.ts`, `cli/core/claude-transcripts.ts`, `cli/commands/hooks.ts` |
| Claude Code: correcting a live session | Done | `cli/agents/coordinate.ts` (see `agents/AGENTS.md`) |
| Notifications: terminal and desktop | Done | `cli/integrations/notify.ts`, `cli/integrations/desktop.ts`, `cli/engine/alerts.ts` |
| Notifications: Slack, webhooks | Not started | |
| GitHub: PR comments, check runs, issues | Not started | |

## Claude Code

`tyr hooks install` adds Tyr's hook to `.claude/settings.json` for every
Claude Code hook event. Each event is journaled as a `claude.*` event
(`tyr watch` shows them), and the hook can answer with corrections when
`agents.correct` is `context` or `block`. Transcripts under
`~/.claude/projects/` are discovered and summarized by
`cli/core/claude-transcripts.ts`. The README's "Claude Code integration"
section has the details.

## Notifications

The background process tells you when something changes for the worse, or
gets fixed, without you watching a terminal.

### When Tyr notifies

After each check pass the daemon compares `.tyr/state/engine.json` before
and after, plus the review result (`passNotification` in
`cli/engine/alerts.ts`), and sends **at most one notification per pass**:

| Severity | When | Example title |
|---|---|---|
| error | a check regressed (it passed before), or the diff review found a new error or critical problem | `Tyr: test regressed` |
| warning | a check started failing that never passed | `Tyr: lint failing` |
| info | only good news: failing checks pass again | `Tyr: build passing again` |

A check that keeps failing says nothing new, so no notification. The body
lists up to three changes, then `+N more (tyr status)`.

`tyr run` never notifies: you are already looking at its output.

### Targets

Set with `notifications.targets` (env `TYR_NOTIFY`), default `["terminal"]`:

| Target | What happens |
|---|---|
| `terminal` | The notification is shown highlighted in `tyr watch`, which rings the terminal bell for it (live events only, not history) |
| `desktop` | A native notification: a toast on Windows 10+ (through PowerShell, no install needed), Notification Center on macOS (`osascript`), `notify-send` on Linux (install libnotify if it's missing) |

Every notification is journaled as a `notification` event (source `tyr`)
whatever the targets, recording where it was sent and which targets failed.
Other entries such as `slack` or `webhook:https://…` are accepted by the
setting but reported as not supported yet.

```bash
tyr config set notifications.targets terminal,desktop   # both
tyr config set notifications.targets none               # off
tyr notify                                              # send a test now
tyr notify -t desktop "hello"                           # test one target
```

### Limits

- The same news (the same problems, identified by check and the run that
  opened them) is sent at most once every 10 minutes.
- At most 5 notifications a minute.
- A broken target (no display, `notify-send` missing) is logged to
  `.tyr/logs/tyr.log` once, and again only after it has worked in between.
- Targets are read at send time, so `tyr config set` applies without
  restarting the background process.

### Safety

Notification text never becomes code. On Windows the title and message
reach PowerShell through environment variables and are XML-escaped inside a
fixed script; `osascript` receives them as `argv`; `notify-send` gets them
after `--`. Control characters are stripped and text is clipped (title 120,
body 400 characters).

## GitHub

Not started: PR comments, check runs and issues, through `gh` or the REST
API.
