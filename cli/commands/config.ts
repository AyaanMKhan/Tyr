// `tyr config` — view and change Tyr's settings (PLANNING.md 2.7).
//
//   tyr config [list]                    every key: effective value, layer, source
//   tyr config get <key>                 one effective value, bare, for scripts
//   tyr config set <key> <value>         write .tyr/settings.json (or --global)
//   tyr config unset <key>               remove it there, so lower layers apply
//   tyr config path                      where that file is, for hand-editing
//
// Wiring only. Resolving the layers lives in core/settings.ts and the
// careful read-modify-write in core/settings-edit.ts; expected failures come
// back as TyrError and the top-level handler (core/fatal.ts) prints them with
// the right exit code.
//
// Output streams: `get`, `list` and `path` print *data* on stdout, so their
// warnings go to stderr where `$(tyr config get …)` will not capture them.
// `set` / `unset` print a confirmation like other commands (stdout), and
// everything moves to stderr under --json, which owns stdout.
//
// Secrets are masked everywhere (`sk-…abcd`); only `get` / `list --reveal`
// print one in full, because the user asked for exactly that.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { printJson, readGlobals, verbosityOf, type GlobalOptions } from "../core/globals.js";
import { createReporter } from "../ui/reporter.js";
import { withoutBanner } from "../ui/banner.js";
import { SETTING_KEYS, getAtPath, type SettingKeySpec } from "../core/settings-types.js";
import {
    describeSettingValue,
    displaySettingValue,
    formatSettingValue,
    resolveSettings,
    type ResolvedSettings,
    type SettingOrigin,
} from "../core/settings.js";
import {
    locateProject,
    requireSettingKey,
    setSetting,
    settingsFileFor,
    unsetSetting,
    type SettingEdit,
    type SettingsScope,
} from "../core/settings-edit.js";
import { NOTIFY_NONE } from "../core/env-settings.js";
import type { Reporter } from "../core/types.js";

interface RevealOptions {
    reveal?: boolean;
}
interface GetOptions extends RevealOptions {
    showOrigin?: boolean;
}
interface ScopeOptions {
    global?: boolean;
}

/** The value argument that means "read it from stdin" (keeps secrets out of shell history). */
const STDIN_VALUE = "-";

export function registerConfigCommand(program: Command) {
    const config = withoutBanner(
        program
            .command("config")
            .description("View and change Tyr's settings")
            .addHelpText("after", `
Settings resolve in layers, later winning:

  default  <  global config  <  project .tyr/settings.json  <  TYR_* env vars

"tyr config" (or "tyr config list") shows every key with its effective value
and where it came from. "set" and "unset" change the project's
.tyr/settings.json, which is committed and shared with your team; add
--global to change your per-user config (~/.config/tyr/config.json) instead.
The API key (ai.apiKey) is a secret: it can only go in the global config or
the environment, and is shown masked (sk-…abcd) unless you pass --reveal.

Prefer editing by hand? "tyr config path" prints the file to open.

Examples:
  $ tyr config                                   List every setting and its origin
  $ tyr config get severity.threshold            Print one value (bare, for scripts)
  $ tyr config set checks.lint false             Turn linting off for this project
  $ tyr config set notifications.targets terminal,desktop
  $ tyr config set notifications.targets ${NOTIFY_NONE}    Notify nowhere (an empty list)
  $ tyr config set --global ai.model claude-opus-5-5
  $ tyr config set --global ai.apiKey -          Read the key from stdin
  $ tyr config unset checks.lint                 Fall back to the global/default value
  $ $EDITOR "$(tyr config path --global)"        Hand-edit your global config

Run "tyr config <subcommand> --help" for details.`),
    );

    config
        .command("list", { isDefault: true })
        .description("List every setting with its effective value and origin (the default)")
        // As the default subcommand, a mistyped one ("tyr config lst") lands
        // here as an argument; reject it instead of silently listing.
        .allowExcessArguments(false)
        .option("--reveal", "Show secrets in full instead of masked")
        .addHelpText("after", `
Prints one row per setting: the key, the value Tyr will use, and the layer it
came from (default, global, project or env) with the file or variable that
set it. Problems found while reading the files or variables are printed to
stderr. A malformed file is reported and ignored; the other layers still
apply, exactly as they would for every other command.

Examples:
  $ tyr config list
  $ tyr config list --json   { ok, root, files, settings: [{ key, value, layer, source, ... }], warnings, errors }`)
        .action(async (options: RevealOptions, command: Command) => {
            const globals = readGlobals(command);
            const reporter = diagnostics(globals);
            const location = await locateProject();
            const root = location.initialized ? location.root : null;
            const resolved = await resolveSettings({ root });

            const rows = SETTING_KEYS.map((spec) => {
                const origin = resolved.origins[spec.key];
                return {
                    key: spec.key,
                    value: displaySettingValue(spec, getAtPath(resolved.settings, spec.key), options),
                    layer: origin.layer,
                    source: origin.source,
                    env: spec.env,
                    ...(spec.secret ? { secret: true, masked: options.reveal !== true } : {}),
                };
            });

            if (globals.json) {
                printJson({
                    ok: true,
                    root,
                    files: resolved.files,
                    settings: rows,
                    warnings: resolved.warnings,
                    errors: resolved.errors,
                });
            } else {
                const table = rows.map((row) => [
                    row.key,
                    describeSettingValue(row.value),
                    originLabel({ layer: row.layer, source: row.source }),
                ]);
                writeTable(["KEY", "VALUE", "ORIGIN"], table);
                if (verbosityOf(globals) !== "quiet") {
                    process.stdout.write("\n");
                    process.stdout.write(`Global config:    ${displayPath(resolved.files.global)}\n`);
                    process.stdout.write(
                        `Project settings: ${resolved.files.project === null ? "(not initialized; run \"tyr init\")" : displayPath(resolved.files.project)}\n`,
                    );
                }
            }
            reportProblems(reporter, resolved);
            reporter.stop();
        });

    config
        .command("get")
        .description("Print the effective value of one setting")
        .argument("<key>", "Setting key, e.g. checks.lint (see \"tyr config list\")")
        .option("--show-origin", "Prefix the value with its origin (layer:source) and a tab")
        .option("--reveal", "Print a secret in full instead of masked")
        .addHelpText("after", `
Prints the value Tyr would use, after all layers, as bare text on stdout in
the same spelling "tyr config set" accepts: true/false, plain strings, lists
comma-joined (terminal,desktop). An empty list and an unset value print an
empty line. Use --json for the exact typed value. Secrets print masked unless
you pass --reveal. Warnings go to stderr, so $(tyr config get KEY) is clean.

Examples:
  $ tyr config get checks.lint                  true
  $ tyr config get --show-origin severity.threshold
                                                env:TYR_SEVERITY<TAB>error
  $ tyr config get ai.apiKey                    sk-…abcd
  $ tyr config get notifications.targets --json { ok, key, value, origin: { layer, source }, ... }
  $ if [ "$(tyr config get checks.test)" = true ]; then npm test; fi`)
        .action(async (key: string, options: GetOptions, command: Command) => {
            const globals = readGlobals(command);
            const spec = requireSettingKey(key);
            const reporter = diagnostics(globals);
            const location = await locateProject();
            const resolved = await resolveSettings({ root: location.initialized ? location.root : null });
            const origin = resolved.origins[spec.key];
            const value = displaySettingValue(spec, getAtPath(resolved.settings, spec.key), options);

            if (globals.json) {
                printJson({
                    ok: true,
                    key: spec.key,
                    value,
                    origin,
                    ...(spec.secret ? { secret: true, masked: options.reveal !== true } : {}),
                    warnings: resolved.warnings,
                    errors: resolved.errors,
                });
            } else {
                const prefix = options.showOrigin ? `${originToken(origin)}\t` : "";
                process.stdout.write(`${prefix}${formatSettingValue(value)}\n`);
            }
            reportProblems(reporter, resolved);
            reporter.stop();
        });

    config
        .command("set")
        .description("Store a setting in .tyr/settings.json (or the global config with --global)")
        .argument("<key>", "Setting key, e.g. checks.lint")
        .argument("<value>", `New value; "${STDIN_VALUE}" reads it from stdin`)
        .option("-g, --global", "Write your per-user config (~/.config/tyr/config.json) instead of the project")
        .addHelpText("after", `
Values are parsed for the key's type: booleans accept true/false, 1/0,
yes/no, on/off; lists are comma-separated, and "${NOTIFY_NONE}" (or "") means an empty
list. The project file must exist (run "tyr init"); the global file is
created on first use with owner-only permissions.

Only the one key changes. If the file is malformed, from a newer Tyr, or has
other invalid or unknown keys that a rewrite would drop, nothing is written
and Tyr exits 4 (CONFIG) so you can fix it by hand. ai.apiKey is refused
without --global: .tyr/settings.json is committed. Pass "${STDIN_VALUE}" as the value
to keep a key out of your shell history.

If a higher layer still overrides the key (a TYR_* variable in this shell,
or for --global the project's own settings), the value is saved anyway and
a warning says why it does not take effect yet.

Examples:
  $ tyr config set checks.format true
  $ tyr config set severity.threshold error
  $ tyr config set agent.permission read-only
  $ tyr config set notifications.targets terminal,webhook:https://example.test/hook
  $ tyr config set notifications.targets ${NOTIFY_NONE}
  $ tyr config set --global ai.model claude-opus-5-5
  $ pbpaste | tyr config set --global ai.apiKey -`)
        .action(async (key: string, rawValue: string, options: ScopeOptions, command: Command) => {
            const globals = readGlobals(command);
            const scope: SettingsScope = options.global ? "global" : "project";
            // Validate the key before blocking on stdin.
            requireSettingKey(key);
            const raw = rawValue === STDIN_VALUE ? await readStdin() : rawValue;
            const location = await locateProject();
            const edit = await setSetting(key, raw, { scope, root: location.initialized ? location.root : null });
            reportEdit(globals, edit);
        });

    config
        .command("unset")
        .description("Remove a setting from .tyr/settings.json (or the global config with --global)")
        .argument("<key>", "Setting key, e.g. checks.lint")
        .option("-g, --global", "Change your per-user config instead of the project")
        .addHelpText("after", `
Deletes the key from that one file, so the next layer down applies again
(project -> global -> default). Unsetting a key the file does not contain is
not an error. Also the way to remove an ai.apiKey committed to
.tyr/settings.json by mistake.

Examples:
  $ tyr config unset checks.lint
  $ tyr config unset --global ai.apiKey`)
        .action(async (key: string, options: ScopeOptions, command: Command) => {
            const globals = readGlobals(command);
            const scope: SettingsScope = options.global ? "global" : "project";
            requireSettingKey(key);
            const location = await locateProject();
            const edit = await unsetSetting(key, { scope, root: location.initialized ? location.root : null });
            reportEdit(globals, edit);
        });

    config
        .command("path")
        .description("Print the location of the settings file, for hand-editing")
        .option("-g, --global", "The per-user config instead of the project's .tyr/settings.json")
        .addHelpText("after", `
Prints the absolute path of .tyr/settings.json for the current project, or
with --global of your per-user config (honouring TYR_CONFIG_HOME and
XDG_CONFIG_HOME). The file may not exist yet; a note on stderr says so.
Hand edits are validated when Tyr reads the file: unknown keys and bad values
are reported (see "tyr config list") and ignored.

Examples:
  $ tyr config path
  $ $EDITOR "$(tyr config path --global)"
  $ tyr config path --json    { ok, scope, file, exists }`)
        .action(async (options: ScopeOptions, command: Command) => {
            const globals = readGlobals(command);
            const reporter = diagnostics(globals);
            const scope: SettingsScope = options.global ? "global" : "project";
            const location = await locateProject();
            // The project path is printed even before `tyr init`: it is where
            // the file will be, and the note below says it is not there yet.
            const file = settingsFileFor(scope, location.root)!;
            const exists = await fileExists(file);

            if (globals.json) {
                printJson({ ok: true, scope, file, exists });
            } else {
                process.stdout.write(`${file}\n`);
            }
            if (!exists) {
                reporter.warn(
                    scope === "project" && !location.initialized
                        ? `Tyr is not initialized in ${location.root}; run "tyr init" to create this file`
                        : `${file} does not exist yet; "tyr config set${scope === "global" ? " --global" : ""}" creates it`,
                );
            }
            reporter.stop();
        });
}

/* -------------------------------------------------------------------------
 * Reporting
 * ---------------------------------------------------------------------- */

/** Reporter for warnings beside data on stdout: always stderr. */
function diagnostics(globals: GlobalOptions): Reporter {
    return createReporter({ verbosity: verbosityOf(globals), stream: process.stderr });
}

function reportProblems(reporter: Reporter, resolved: ResolvedSettings): void {
    for (const error of resolved.errors) reporter.error(`${error} (file ignored)`);
    for (const warning of resolved.warnings) reporter.warn(warning);
}

function reportEdit(globals: GlobalOptions, edit: SettingEdit): void {
    const spec = SETTING_KEYS.find((s) => s.key === edit.key)!;
    const reporter = createReporter({
        verbosity: verbosityOf(globals),
        stream: globals.json ? process.stderr : undefined,
    });
    const show = (value: unknown) => describeSettingValue(displaySettingValue(spec, value));
    const file = displayPath(edit.file);
    const warnings: string[] = [];
    if (edit.shadowedBy !== null) warnings.push(shadowWarning(spec, edit.shadowedBy));

    if (edit.action === "set") {
        if (edit.changed) reporter.success(`Set ${edit.key} = ${show(edit.value)} in ${file}`);
        else reporter.muted(`${edit.key} is already ${show(edit.value)} in ${file}; nothing changed`);
    } else if (edit.changed) {
        reporter.success(`Removed ${edit.key} from ${file}`);
    } else {
        reporter.muted(`${edit.key} is not set in ${file}; nothing changed`);
    }
    for (const note of edit.notes) reporter.debug(note);
    if (edit.shadowedBy === null) {
        // Most useful after unset: which lower layer now applies.
        const message = `Effective value: ${show(edit.effective.value)} (${originLabel(edit.effective.origin)})`;
        if (edit.action === "unset") reporter.info(message);
        else reporter.debug(message);
    }
    for (const warning of warnings) reporter.warn(warning);
    reporter.stop();

    if (globals.json) {
        printJson({
            ok: true,
            action: edit.action,
            key: edit.key,
            scope: edit.scope,
            file: edit.file,
            changed: edit.changed,
            // `previous` / `value` are omitted when the file does not set the key.
            previous: edit.previous === undefined ? undefined : displaySettingValue(spec, edit.previous),
            value: edit.value === undefined ? undefined : displaySettingValue(spec, edit.value),
            effective: { value: displaySettingValue(spec, edit.effective.value), origin: edit.effective.origin },
            shadowedBy: edit.shadowedBy,
            warnings,
        });
    }
}

function shadowWarning(spec: SettingKeySpec, by: SettingOrigin): string {
    if (by.layer === "env") {
        return `${by.source} is set in this environment and overrides ${spec.key}, so the new value will not take effect in this shell; unset ${by.source} to use it`;
    }
    return `${displayPath(by.source)} also sets ${spec.key} and overrides the global value in this project; run "tyr config unset ${spec.key}" there to use it`;
}

/** "default", "global (~/.config/tyr/config.json)", "env (TYR_SEVERITY)". */
function originLabel(origin: SettingOrigin): string {
    return origin.layer === "default" ? "default" : `${origin.layer} (${displaySource(origin)})`;
}

/** git-style `--show-origin` token: "default", "env:TYR_SEVERITY", "project:/abs/.tyr/settings.json". */
function originToken(origin: SettingOrigin): string {
    return origin.layer === "default" ? "default" : `${origin.layer}:${origin.source}`;
}

function displaySource(origin: SettingOrigin): string {
    return origin.layer === "env" ? origin.source : displayPath(origin.source);
}

/** A path relative to the cwd when it is inside it, else with the home directory as "~". */
function displayPath(file: string): string {
    const relative = path.relative(process.cwd(), file);
    if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
    const home = os.homedir();
    return file === home || file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
}

/** Left-aligned columns separated by two spaces; the last column is not padded. */
function writeTable(header: string[], rows: string[][]): void {
    const all = [header, ...rows];
    const widths = header.map((_, column) => Math.max(...all.map((row) => row[column].length)));
    for (const row of all) {
        const line = row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]))).join("  ");
        process.stdout.write(line.trimEnd() + "\n");
    }
}

async function fileExists(file: string): Promise<boolean> {
    return (await fs.stat(file).catch(() => null))?.isFile() === true;
}

/** All of stdin as text. On a terminal, says how to finish first. */
async function readStdin(): Promise<string> {
    if (process.stdin.isTTY) {
        process.stderr.write("Enter the value, then press Ctrl-D:\n");
    }
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}
