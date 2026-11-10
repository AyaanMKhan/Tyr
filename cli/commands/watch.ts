// `tyr watch` — a live view of the event journal (PLANNING.md 2.9).
//
// Everything Tyr knows about happens as an event in `.tyr/state/events.jsonl`:
// the daemon's git and file watchers, Claude Code hooks, `tyr init`, checks.
// `tyr watch` replays the tail of that journal, then follows it with
// followEvents() (event-stream.ts) and prints each event through
// ui/event-view.ts. It never talks to the daemon except for one optional ping
// in the header: hooks write to the journal with no daemon running, so a
// stopped daemon is a warning, not an error.
//
// Output contract:
//   - text: an optional status header, the replayed history, a "live"
//     separator, then one line per event. Header, separator and hints are
//     decoration and disappear under --quiet; event lines never do (they are
//     what the command is for).
//   - --json: NDJSON, exactly one raw journal event per stdout line, nothing
//     else on stdout. Warnings (daemon not running) go to stderr.
//
// Stopping: Ctrl-C ends the follow. The process-wide fatal handler (core/
// fatal.ts) turns SIGINT into exit 130, the same code `tail -f` and every
// other Tyr command report, so a script can tell "interrupted" from
// `--no-follow`'s clean 0. Nothing here hides the cursor or changes terminal
// modes, so there is no terminal state to restore beyond what fatal.ts
// already does. runWatch() itself takes an AbortSignal so tests (and any
// future embedding) can stop it without a signal.

import * as fs from "node:fs/promises";
import { Command, InvalidArgumentError, Option } from "commander";
import { findProjectRoot } from "../core/discovery.js";
import { readDaemonStatus, type DaemonStatus } from "../core/daemon.js";
import { pingDaemon } from "../core/daemon-requests.js";
import { EXIT_CODES, TyrError } from "../core/errors.js";
import { EVENT_SOURCES, readEvents, type EventSource, type TyrEvent } from "../core/events.js";
import { followEvents } from "../core/event-stream.js";
import { readGlobals, verbosityOf } from "../core/globals.js";
import { resolveTyrPaths } from "../core/scaffold.js";
import { withoutBanner } from "../ui/banner.js";
import { createEventFormatter, formatUptime, parseSince } from "../ui/event-view.js";
import { createReporter, detectColor, detectUnicode, paint, SGR } from "../ui/reporter.js";

export const DEFAULT_WATCH_LINES = 20;
/** How long the header waits for the daemon's pong before giving up. */
const PING_TIMEOUT_MS = 1000;

export interface WatchOptions {
    /** History lines to replay (0 = none). */
    lines: number;
    /**
     * Whether `lines` was given explicitly. With `since` and no explicit
     * `--lines`, everything since that time is replayed.
     */
    linesExplicit?: boolean;
    since?: Date;
    sources?: readonly EventSource[];
    /** Same semantics as readEvents kinds ("git." prefix, "daemon" exact-or-child). */
    kinds?: readonly string[];
    /** Claude session ids or id prefixes; only events of those sessions are shown. */
    sessions?: readonly string[];
    /** False for --no-follow: print history and return. */
    follow: boolean;
    json?: boolean;
    quiet?: boolean;
    verbose?: boolean;
    color?: boolean;
    unicode?: boolean;
    /** Terminal width for truncating lines; undefined = never truncate. */
    width?: number;
    /** Ping the daemon for the header's latency. Default true. */
    ping?: boolean;
}

/** The minimal stream surface runWatch writes to. */
export interface WatchStream {
    write(chunk: string): unknown;
}

export interface WatchContext {
    root: string;
    stdout: WatchStream;
    stderr: WatchStream;
    /** Aborting ends the follow and lets runWatch resolve. */
    signal?: AbortSignal;
    now?: () => Date;
    pollIntervalMs?: number;
    forcePolling?: boolean;
    /** Keep the event loop alive while following. Default true. */
    persistent?: boolean;
    daemonStatus?: (root: string) => Promise<DaemonStatus>;
    ping?: (root: string, timeoutMs: number) => Promise<number | null>;
}

export function registerWatchCommand(program: Command) {
    const watch = program
        .command("watch")
        .description("Follow what Tyr, git and Claude Code are doing, live")
        .addOption(
            new Option("-n, --lines <n>", "Replay the last <n> events before following (0 for none)")
                .default(DEFAULT_WATCH_LINES)
                .argParser(parseLines),
        )
        .addOption(
            new Option("--since <time>", 'Replay events since <time>: an age like "10m", "2h", "1d" or an ISO date').argParser(
                (value: string) => {
                    const since = parseSince(value);
                    if (since === null) throw new InvalidArgumentError('expected an age like "10m", "2h", "1d" or an ISO date/time.');
                    return since;
                },
            ),
        )
        .addOption(
            new Option("--source <list>", `Only these sources, comma-separated (${EVENT_SOURCES.join(", ")})`).argParser(
                (value: string, previous: EventSource[] | undefined) => [...(previous ?? []), ...parseSources(value)],
            ),
        )
        .addOption(
            new Option("--kind <pattern>", 'Only these kinds (repeatable or comma-separated); "git." is a prefix, "daemon" matches daemon.*').argParser(
                collectList,
            ),
        )
        .addOption(new Option("--session <id>", "Only events of this Claude session (an id or a prefix; repeatable)").argParser(collectList))
        .option("--no-follow", "Print the history and exit instead of following")
        .option("--no-ping", "Do not ping the background process for the header")
        .option("--no-color", "Disable colored output")
        .addHelpText("after", `
Replays the most recent events from .tyr/state/events.jsonl, then prints new
ones as they happen until you press Ctrl-C (exit code 130). Events come from
the background process (git, file changes), Claude Code hooks ("tyr hooks
install") and Tyr itself, so watching works even when "tyr start" has not
been run; you then only see what hooks and commands record.

Each line is: local time, source, and a one-line summary. --verbose adds the
event kind, id and details (changed paths, session ids, errors).

  14:22:31 ◆ claude  Bash: npm test
  14:22:33 ◆ claude  Bash: npm test  ✗ Exit code 1
  14:22:40 ⎇ git     switched to main at 1a2b3c4
  14:22:41 ✎ fs      14 files changed by checkout

Examples:
  $ tyr watch                       Last 20 events, then follow
  $ tyr watch -n 100                Last 100 events, then follow
  $ tyr watch --since 2h --no-follow   Everything from the last two hours
  $ tyr watch --source claude       Only Claude Code activity
  $ tyr watch --kind git. --kind daemon   Git events and daemon lifecycle
  $ tyr watch --session 3f2a9c1d    One Claude session
  $ tyr watch --json | jq -r .kind  NDJSON: one raw event per line`)
        .action(async (options: CommandOptions, command: Command) => {
            const globals = readGlobals(command);
            const json = globals.json === true;
            const stdout = process.stdout;
            const root = await findProjectRoot();
            await runWatch(
                {
                    lines: options.lines,
                    linesExplicit: command.getOptionValueSource("lines") === "cli",
                    since: options.since,
                    sources: options.source,
                    kinds: options.kind,
                    sessions: options.session,
                    follow: options.follow !== false,
                    json,
                    quiet: verbosityOf(globals) === "quiet",
                    verbose: globals.verbose === true,
                    // `--no-color` forces it off; otherwise the reporter's NO_COLOR/TTY rules decide.
                    color: options.color === false ? false : detectColor(stdout),
                    unicode: detectUnicode(),
                    width: stdout.isTTY === true && !json ? stdout.columns : undefined,
                    ping: options.ping !== false,
                },
                { root, stdout, stderr: process.stderr },
            );
        });
    // Streaming output: five lines of ASCII art above a log is noise, and
    // `tyr watch | grep` should see only events.
    withoutBanner(watch);
}

interface CommandOptions {
    lines: number;
    since?: Date;
    source?: EventSource[];
    kind?: string[];
    session?: string[];
    follow?: boolean;
    ping?: boolean;
    color?: boolean;
}

function parseLines(value: string): number {
    if (!/^\d+$/.test(value.trim())) throw new InvalidArgumentError("expected a whole number (0 or more).");
    return Number(value.trim());
}

function splitList(value: string): string[] {
    return value
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part !== "");
}

function collectList(value: string, previous: string[] | undefined): string[] {
    return [...(previous ?? []), ...splitList(value)];
}

/** Comma list of sources, each checked against EVENT_SOURCES. Exported for tests. */
export function parseSources(value: string): EventSource[] {
    const sources = splitList(value);
    const unknown = sources.filter((source) => !(EVENT_SOURCES as readonly string[]).includes(source));
    if (unknown.length > 0) {
        throw new InvalidArgumentError(`unknown source ${unknown.map((s) => `"${s}"`).join(", ")}; expected ${EVENT_SOURCES.join(", ")}.`);
    }
    return sources as EventSource[];
}

/**
 * Run `tyr watch` against `context.root`. Resolves when the history has been
 * printed (`follow: false`) or once `context.signal` aborts. Throws a
 * NOT_INITIALIZED TyrError when the project has no `.tyr/tyr.json`.
 */
export async function runWatch(options: WatchOptions, context: WatchContext): Promise<void> {
    const { root } = context;
    const json = options.json === true;
    const quiet = options.quiet === true || json;
    const color = options.color === true && !json;
    const unicode = options.unicode !== false;
    const now = context.now ?? (() => new Date());

    const configStat = await fs.stat(resolveTyrPaths(root).configFile).catch(() => null);
    if (!configStat?.isFile()) {
        throw new TyrError(`Tyr is not initialized in ${root}`, {
            exitCode: EXIT_CODES.NOT_INITIALIZED,
            hint: 'Run "tyr init" first; then "tyr start" to record git and file activity.',
        });
    }

    // Decoration goes through the reporter; under --json it moves to stderr
    // so stdout stays pure NDJSON (and quiet keeps only the warning).
    const reporter = createReporter({
        stream: (json ? context.stderr : context.stdout) as NodeJS.WriteStream,
        verbosity: quiet ? "quiet" : options.verbose === true ? "verbose" : "normal",
        color,
        unicode,
        animate: false,
    });

    if (options.follow) {
        await printHeader(options, context, reporter, { quiet, now });
    }

    const accept = buildExtraFilter(options);
    const format = createEventFormatter({ color, unicode, verbose: options.verbose === true, width: options.width });
    const print = (event: TyrEvent, live: boolean): void => {
        if (json) {
            context.stdout.write(`${JSON.stringify(event)}\n`);
            return;
        }
        context.stdout.write(`${format(event)}\n`);
        if (live && !quiet) announceLifecycle(event, context.stdout, color);
    };

    const baseFilter = { sources: options.sources, kinds: options.kinds };
    const historyLimit = options.since !== undefined && options.linesExplicit !== true ? undefined : options.lines;
    const readHistory = async (): Promise<TyrEvent[]> => {
        if (historyLimit === 0) return [];
        const events = (await readEvents(root, { ...baseFilter, since: options.since })).filter(accept);
        return historyLimit === undefined ? events : events.slice(-historyLimit);
    };

    if (!options.follow) {
        const history = await readHistory();
        for (const event of history) print(event, false);
        if (history.length === 0) reporter.muted("No matching events.");
        return;
    }

    // Follow first, buffering, then read history: an event appended in
    // between lands in both and is printed once (by id), and none can fall in
    // the gap. The history is read here rather than through followEvents'
    // own backlog because the session filter is applied after reading, and
    // "the last N lines" has to mean N lines that are actually shown.
    let replaying = true;
    const buffered: TyrEvent[] = [];
    const follower = await followEvents(root, {
        ...baseFilter,
        signal: context.signal,
        pollIntervalMs: context.pollIntervalMs,
        forcePolling: context.forcePolling,
        persistent: context.persistent,
        onEvent: (event) => {
            if (!accept(event)) return;
            if (replaying) buffered.push(event);
            else print(event, true);
        },
    });

    const history = await readHistory();
    const seen = new Set(history.map((event) => event.id).filter((id) => id !== ""));
    for (const event of history) print(event, false);
    if (!quiet) {
        const rule = unicode ? "──" : "--";
        const label = history.length === 0 ? "no matching events yet; following live" : "following live";
        context.stdout.write(paint(`${rule} ${label} (Ctrl-C to stop) ${rule}`, SGR.dim, color) + "\n");
    }
    for (const event of buffered) {
        if (event.id === "" || !seen.has(event.id)) print(event, true);
    }
    buffered.length = 0;
    replaying = false;

    if (context.signal === undefined) {
        // The CLI: follow until Ctrl-C, which fatal.ts turns into exit 130.
        await new Promise<never>(() => undefined);
    }
    await follower.done;
}

/**
 * Filters the journal reader cannot express: Claude session ids, and
 * daemon.pong, which is request/response plumbing (the header's own ping
 * makes one) and only shown under --verbose or when asked for by --kind.
 */
function buildExtraFilter(options: WatchOptions): (event: TyrEvent) => boolean {
    const sessions = options.sessions !== undefined && options.sessions.length > 0 ? options.sessions : null;
    const showPongs = options.verbose === true || (options.kinds !== undefined && options.kinds.length > 0);
    return (event) => {
        if (!showPongs && event.kind === "daemon.pong") return false;
        if (sessions !== null) {
            const id = event.data?.sessionId;
            if (typeof id !== "string" || !sessions.some((wanted) => id.startsWith(wanted))) return false;
        }
        return true;
    };
}

async function printHeader(
    options: WatchOptions,
    context: WatchContext,
    reporter: ReturnType<typeof createReporter>,
    { quiet, now }: { quiet: boolean; now: () => Date },
): Promise<void> {
    const status = await (context.daemonStatus ?? readDaemonStatus)(context.root);
    reporter.header(`Watching ${context.root}`);
    if (status.running) {
        const parts = [`pid ${status.pid}`];
        if (status.startedAt !== null && !Number.isNaN(Date.parse(status.startedAt))) {
            parts.push(`up ${formatUptime(now().getTime() - Date.parse(status.startedAt))}`);
        }
        // Only for a person reading: a ping costs a request file and a pong event.
        if (!quiet && options.ping !== false) {
            const latency = await (context.ping ?? pingDaemon)(context.root, PING_TIMEOUT_MS);
            parts.push(latency === null ? "not answering pings" : `ping ${Math.round(latency)}ms`);
        }
        reporter.success(`Background process running (${parts.join(", ")})`);
    } else {
        reporter.warn(
            status.stale
                ? `Background process is not running (it exited without cleaning up, pid ${status.pid ?? "?"})`
                : "Background process is not running",
        );
        reporter.info('  Git and file changes are not being recorded; start it with "tyr start".');
        reporter.info("  Claude Code hooks and Tyr commands still write events, so they are shown below.");
    }
    reporter.blank();
}

/** A hint after a live daemon lifecycle event, so a crash is never just one more line. */
function announceLifecycle(event: TyrEvent, stdout: WatchStream, color: boolean): void {
    let hint: string | null = null;
    if (event.kind === "daemon.crashed") {
        hint = 'The background process crashed; see .tyr/logs/tyr.log and restart it with "tyr start". Still following.';
    } else if (event.kind === "daemon.stopped") {
        hint = 'Git and file changes are no longer recorded; "tyr start" resumes them. Still following.';
    }
    if (hint !== null) stdout.write(paint(`         ${hint}`, SGR.dim, color) + "\n");
}
