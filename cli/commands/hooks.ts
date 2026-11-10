// Claude Code integration (PLANNING.md 2.9).
//
//   tyr hook                       what Claude Code runs; hidden from --help
//   tyr hooks install [--shared]   add Tyr's hooks to .claude/settings(.local).json
//   tyr hooks uninstall            remove them again
//   tyr hooks status               show what is installed where
//
// `tyr hook` is the odd one out. Claude Code runs it synchronously for every
// tool call, prompt and stop, and gives meaning to its exit code and stdout
// (exit 2 blocks a PreToolUse, stdout on UserPromptSubmit / SessionStart is
// fed to the model as context). So it never prints, always exits 0, and
// gives up fast: a hard limit on reading stdin, a timer that ends the
// process regardless, and every error swallowed. Losing one journal entry
// is always better than slowing or derailing the session it observes.
//
// Normalization and the settings-file editing live in core/claude-hooks.ts.

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { findProjectRoot, isAlreadyInitialized } from "../core/discovery.js";
import { appendEvent, type TyrEvent, type TyrEventInput } from "../core/events.js";
import { printJson, readGlobals, verbosityOf, type GlobalOptions } from "../core/globals.js";
import { runGit } from "../core/git-exec.js";
import {
    TYR_HOOK_EVENTS,
    claudeSettingsFile,
    defaultHookCommand,
    hooksStatus,
    installHooks,
    normalizeHookPayload,
    uninstallHooks,
    type HooksEdit,
    type HooksStatus,
} from "../core/claude-hooks.js";
import { EXIT_CODES, TyrError } from "../core/errors.js";
import { withoutBanner } from "../ui/banner.js";
import { createReporter } from "../ui/reporter.js";

/* -------------------------------------------------------------------------
 * tyr hook
 * ---------------------------------------------------------------------- */

/** How long to wait for Claude Code to finish writing the payload. */
export const HOOK_STDIN_TIMEOUT_MS = 2000;
/** Hard ceiling on the whole `tyr hook` run; the process exits 0 at this point regardless. */
export const HOOK_DEADLINE_MS = 5000;
/**
 * Largest payload read. PostToolUse carries the tool's whole result (a Read
 * of a big file), none of which is kept, so past this the payload is
 * dropped rather than buffered without bound.
 */
export const HOOK_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

export interface HookInput {
    on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
    on(event: "end" | "close", listener: () => void): unknown;
    on(event: "error", listener: (error: Error) => void): unknown;
    isTTY?: boolean;
    destroy?(): unknown;
    resume?(): unknown;
}

/**
 * Read all of `input`, or null on a TTY (someone ran `tyr hook` by hand),
 * an error, a payload over `maxBytes`, or no end within `timeoutMs`.
 * Never rejects.
 */
export function readHookStdin(
    input: HookInput,
    timeoutMs: number = HOOK_STDIN_TIMEOUT_MS,
    maxBytes: number = HOOK_MAX_PAYLOAD_BYTES,
): Promise<string | null> {
    if (input.isTTY === true) return Promise.resolve(null);
    return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let settled = false;
        const finish = (value: string | null): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };
        const timer = setTimeout(() => {
            finish(null);
            // Stop holding the event loop open on a writer that never closes.
            input.destroy?.();
        }, timeoutMs);
        timer.unref?.();
        try {
            input.on("data", (chunk) => {
                if (settled) return;
                const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
                size += buffer.length;
                // Over the cap: keep draining (so the writer never sees EPIPE)
                // but stop buffering.
                if (size <= maxBytes) chunks.push(buffer);
            });
            input.on("end", () => finish(size <= maxBytes ? Buffer.concat(chunks).toString("utf8") : null));
            input.on("close", () => finish(size <= maxBytes ? Buffer.concat(chunks).toString("utf8") : null));
            input.on("error", () => finish(null));
            input.resume?.();
        } catch {
            finish(null);
        }
    });
}

export interface RecordHookDeps {
    /** Default: discovery.findProjectRoot. */
    findRoot?: (dir: string) => Promise<string>;
    /** Default: discovery.isAlreadyInitialized. */
    isInitialized?: (root: string) => Promise<boolean>;
    /** Default: events.appendEvent. */
    append?: (root: string, input: TyrEventInput) => Promise<TyrEvent | null>;
    /** Default: process.env (for CLAUDE_PROJECT_DIR). */
    env?: Record<string, string | undefined>;
    /** Default: process.cwd(). */
    cwd?: string;
}

export interface RecordHookResult {
    recorded: boolean;
    root: string | null;
    /** Why nothing was recorded. */
    reason?: "unparseable" | "not-initialized" | "append-failed";
    event?: TyrEvent;
}

/**
 * Record one raw hook payload in the right project's journal. Never throws.
 *
 * The project is the one containing the payload's `cwd` (Claude may have cd'd
 * into a subdirectory; findProjectRoot climbs back up). If that has no
 * `.tyr/`, CLAUDE_PROJECT_DIR (where the session started) gets a chance:
 * Claude working inside a git worktree of an initialized repo reports the
 * worktree as cwd, and the worktree has no `.tyr/` of its own. A project
 * without `.tyr/` records nothing: hooks must never be what creates it.
 */
export async function recordHookPayload(raw: string, deps: RecordHookDeps = {}): Promise<RecordHookResult> {
    const findRoot = deps.findRoot ?? findProjectRoot;
    const isInitialized = deps.isInitialized ?? isAlreadyInitialized;
    const append = deps.append ?? ((root: string, input: TyrEventInput) => appendEvent(root, input));
    const env = deps.env ?? process.env;
    try {
        let payload: unknown;
        try {
            payload = JSON.parse(raw);
        } catch {
            return { recorded: false, root: null, reason: "unparseable" };
        }
        const cwd =
            payload !== null && typeof payload === "object" && typeof (payload as { cwd?: unknown }).cwd === "string"
                ? (payload as { cwd: string }).cwd
                : undefined;

        const candidates = [cwd, env.CLAUDE_PROJECT_DIR, cwd === undefined ? (deps.cwd ?? process.cwd()) : undefined];
        let root: string | null = null;
        const tried = new Set<string>();
        for (const dir of candidates) {
            if (dir === undefined || dir === "" || !path.isAbsolute(dir)) continue;
            const found = await findRoot(dir);
            if (tried.has(found)) continue;
            tried.add(found);
            if (await isInitialized(found)) {
                root = found;
                break;
            }
        }
        if (root === null) return { recorded: false, root: null, reason: "not-initialized" };

        const input = normalizeHookPayload(payload, { root });
        if (input === null) return { recorded: false, root, reason: "unparseable" };
        const event = await append(root, input);
        return event === null ? { recorded: false, root, reason: "append-failed" } : { recorded: true, root, event };
    } catch {
        return { recorded: false, root: null, reason: "append-failed" };
    }
}

function registerHookCommand(program: Command): void {
    withoutBanner(
        program
            // Hidden: people never run it; Claude Code does.
            .command("hook", { hidden: true })
            .description("Record one Claude Code hook event from stdin (run by Claude Code)")
            // A usage error would exit 2, which blocks a PreToolUse. Accept
            // anything a future settings file might pass.
            .allowUnknownOption()
            .allowExcessArguments(true)
            .action(async () => {
                // Whatever happens below, end the process cleanly by the
                // deadline. unref: it never keeps an otherwise idle process alive.
                const deadline = setTimeout(() => process.exit(EXIT_CODES.OK), HOOK_DEADLINE_MS);
                deadline.unref();
                try {
                    const raw = await readHookStdin(process.stdin);
                    if (raw !== null) await recordHookPayload(raw);
                } catch {
                    // Never let a journal problem reach Claude Code.
                }
                process.exitCode = EXIT_CODES.OK;
            }),
    );
}

/* -------------------------------------------------------------------------
 * tyr hooks install / uninstall / status
 * ---------------------------------------------------------------------- */

/** The compiled CLI entry point this module belongs to (dist/cli/index.js). */
export const CLI_SCRIPT = fileURLToPath(new URL("../index.js", import.meta.url));

type Scope = "shared" | "local";

interface InstallOptions {
    shared?: boolean;
    command?: string;
}
interface UninstallOptions {
    shared?: boolean;
    local?: boolean;
}

/** `path` relative to `root` for display, when inside it. */
function shown(root: string, file: string): string {
    const relative = path.relative(root, file);
    return relative.startsWith("..") || path.isAbsolute(relative) ? file : relative;
}

/** True when git ignores `file` (or cannot say, outside a repo). */
async function gitIgnores(root: string, file: string): Promise<boolean | null> {
    const inside = await runGit(root, ["rev-parse", "--is-inside-work-tree"]);
    if (!inside.ok) return null;
    // check-ignore exits 0 when ignored, 1 when not.
    return (await runGit(root, ["check-ignore", "-q", "--", file])).ok;
}

function reporterFor(globals: GlobalOptions) {
    return createReporter({ verbosity: verbosityOf(globals), stream: globals.json ? process.stderr : undefined });
}

export function registerHooksCommand(program: Command): void {
    registerHookCommand(program);

    const hooks = program
        .command("hooks")
        .description("Connect Tyr to Claude Code through hooks")
        .addHelpText("after", `
Claude Code can run a command on every session start, prompt, tool call and
stop. "tyr hooks install" registers Tyr for those events in the project's
.claude/settings.local.json (or .claude/settings.json with --shared), and each
one is recorded in .tyr/state/events.jsonl for "tyr watch" and the
background process. Nothing is recorded until the project has a .tyr/ (run
"tyr init"), and recording never slows down or blocks Claude Code.

Examples:
  $ tyr hooks install              Just for you (settings.local.json)
  $ tyr hooks install --shared --command "npx tyr hook"
                                   For the whole team (settings.json, committed)
  $ tyr hooks status
  $ tyr hooks uninstall`);

    hooks
        .command("install")
        .description("Add Tyr's hooks to .claude/settings.local.json (or settings.json with --shared)")
        .option("--shared", "Write .claude/settings.json, which is committed and applies to everyone")
        .option("--command <cmd>", "Command Claude Code should run (default: node \"<this Tyr>/dist/cli/index.js\" hook)")
        .addHelpText("after", `
Adds one entry per event (${TYR_HOOK_EVENTS.join(", ")})
and leaves every other setting and hook in the file alone. Running it again
is harmless; with a different --command it replaces Tyr's entries instead of
adding more. A file that is not valid JSON is not touched (exit 4).

The default command runs this copy of Tyr by absolute path, so it works in a
development checkout and when "tyr" is not on the PATH Claude Code sees. That
path is specific to this machine: for --shared, pass a command that works for
everyone, such as --command "npx tyr hook" or --command "tyr hook".

Examples:
  $ tyr hooks install
  $ tyr hooks install --command "tyr hook"
  $ tyr hooks install --shared --command "npx tyr hook"
  $ tyr hooks install --json      { ok, root, file, changed, events, command, warnings }`)
        .action(async (options: InstallOptions, command: Command) => {
            const globals = readGlobals(command);
            const reporter = reporterFor(globals);
            const scope: Scope = options.shared ? "shared" : "local";
            if (options.command !== undefined && options.command.trim() === "") {
                throw new TyrError("--command must not be empty", { exitCode: EXIT_CODES.USAGE });
            }
            const root = await findProjectRoot();
            const file = claudeSettingsFile(root, scope);
            const edit = await installHooks(file, options.command ?? defaultHookCommand(CLI_SCRIPT));

            const warnings: string[] = [];
            if (scope === "shared" && options.command === undefined) {
                warnings.push(
                    `${shown(root, file)} is shared, but the installed command points at ${CLI_SCRIPT} on this machine; ` +
                        `re-run with --command "npx tyr hook" (or "tyr hook") so it works for everyone`,
                );
            }
            const other = await hooksStatus(claudeSettingsFile(root, scope === "shared" ? "local" : "shared"));
            if (other.installed.length > 0) {
                warnings.push(
                    `${shown(root, other.file)} also has Tyr hooks, so every event will be recorded twice; ` +
                        `remove them with "tyr hooks uninstall --${scope === "shared" ? "local" : "shared"}"`,
                );
            }
            if (scope === "local" && (await gitIgnores(root, file)) === false) {
                warnings.push(`${shown(root, file)} is not ignored by git; it is meant to stay personal, so add it to .gitignore`);
            }
            if (!(await isAlreadyInitialized(root))) {
                warnings.push(`Tyr is not initialized in ${root}; events are ignored until you run "tyr init"`);
            }

            if (edit.changed) {
                reporter.success(`Installed Claude Code hooks in ${shown(root, file)} (${edit.events.length} events)`);
            } else {
                reporter.muted(`Claude Code hooks are already installed in ${shown(root, file)}; nothing changed`);
            }
            reporter.debug(`Command: ${edit.command}`);
            for (const warning of warnings) reporter.warn(warning);
            if (edit.changed) reporter.info("New Claude Code sessions pick this up; in a running one, review it under /hooks.");
            reporter.stop();
            if (globals.json) printJson({ ok: true, root, scope, ...editJson(edit), warnings });
        });

    hooks
        .command("uninstall")
        .description("Remove Tyr's hooks from .claude/settings.local.json and .claude/settings.json")
        .option("--shared", "Only .claude/settings.json")
        .option("--local", "Only .claude/settings.local.json")
        .addHelpText("after", `
Removes only the entries Tyr installed (they end in "# tyr:claude-hook");
your own hooks and settings stay. Without --shared or --local both files are
cleaned, and a file left completely empty is deleted. The journal
(.tyr/state/events.jsonl) is kept.

Examples:
  $ tyr hooks uninstall
  $ tyr hooks uninstall --shared
  $ tyr hooks uninstall --json    { ok, root, files: [{ file, changed, events }] }`)
        .action(async (options: UninstallOptions, command: Command) => {
            const globals = readGlobals(command);
            const reporter = reporterFor(globals);
            const root = await findProjectRoot();
            const both = options.shared === options.local; // neither or both flags
            const scopes: Scope[] = [];
            if (both || options.local) scopes.push("local");
            if (both || options.shared) scopes.push("shared");

            const edits: HooksEdit[] = [];
            for (const scope of scopes) edits.push(await uninstallHooks(claudeSettingsFile(root, scope)));
            for (const edit of edits) {
                if (edit.changed) reporter.success(`Removed Tyr's hooks from ${shown(root, edit.file)} (${edit.events.length} events)`);
                else reporter.muted(`No Tyr hooks in ${shown(root, edit.file)}`);
            }
            reporter.stop();
            if (globals.json) printJson({ ok: true, root, files: edits.map(editJson) });
        });

    hooks
        .command("status")
        .description("Show whether Tyr's Claude Code hooks are installed")
        .addHelpText("after", `
Checks .claude/settings.local.json and .claude/settings.json for Tyr's
entries and whether the project is initialized (events are only recorded
when it is). Exits 0 either way; use --json to script it.

Examples:
  $ tyr hooks status
  $ tyr hooks status --json   { ok, root, initialized, installed, files: [{ file, exists, installed, missing, commands, error? }] }`)
        .action(async (_options, command: Command) => {
            const globals = readGlobals(command);
            const reporter = reporterFor(globals);
            const root = await findProjectRoot();
            const initialized = await isAlreadyInitialized(root);
            const files: HooksStatus[] = [];
            for (const scope of ["local", "shared"] as const) files.push(await hooksStatus(claudeSettingsFile(root, scope)));
            const installed = files.some((status) => status.installed.length > 0);

            for (const status of files) {
                const name = shown(root, status.file);
                if (status.error !== undefined) {
                    reporter.error(status.error);
                } else if (status.installed.length === 0) {
                    reporter.muted(`${name}: not installed`);
                } else if (status.missing.length === 0) {
                    reporter.success(`${name}: installed for all ${status.installed.length} events`);
                } else {
                    reporter.warn(
                        `${name}: installed for ${status.installed.length} of ${TYR_HOOK_EVENTS.length} events ` +
                            `(missing ${status.missing.join(", ")}); run "tyr hooks install" to repair`,
                    );
                }
                for (const hookCommand of status.commands) reporter.debug(`${name} runs: ${hookCommand}`);
            }
            if (installed && !initialized) {
                reporter.warn(`Tyr is not initialized in ${root}; events are ignored until you run "tyr init"`);
            } else if (!installed) {
                reporter.info(`Run "tyr hooks install" to record Claude Code sessions in this project.`);
            }
            reporter.stop();
            if (globals.json) printJson({ ok: true, root, initialized, installed, files });
        });
}

function editJson(edit: HooksEdit): Record<string, unknown> {
    return {
        file: edit.file,
        changed: edit.changed,
        events: edit.events,
        ...(edit.command !== undefined ? { command: edit.command } : {}),
    };
}
