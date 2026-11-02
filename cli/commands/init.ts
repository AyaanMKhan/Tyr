// `tyr init` — inspect the project, then lay down `.tyr/`.
//
// This file is wiring only. Every piece of real work lives in a focused module
// under `cli/core/`, and every line of user-facing output goes through the
// reporter in `cli/ui/`. Keeping detection silent and display centralized is
// what lets the same detectors be reused by `status`, `watch`, and `run`.

import { Command } from "commander";
import {
    findProjectRoot,
    isAlreadyInitialized,
    scanProject,
    IGNORED_DIRS,
    IGNORED_EXTENSIONS,
    IGNORED_FILES,
} from "../core/discovery.js";
import { collectGitInfo } from "../core/git.js";
import { profileProject } from "../core/project.js";
import { scaffold, readConfig, appendLog, type ScaffoldPreserved } from "../core/scaffold.js";
import { withTyrLock } from "../core/lock.js";
import { appendEvent } from "../core/events.js";
import { countPatterns, readTyrIgnore, TYR_IGNORE_FILE } from "../core/ignore.js";
import { buildScanManifest, saveScanManifest } from "../core/scan-diff.js";
import { verifyCommands } from "../core/verify-commands.js";
import { CLEAR_TOKEN, COMMAND_SLOTS, editCommands } from "../core/edit-commands.js";
import { applyGitignorePolicy, TYR_GITIGNORE_ENTRY, type GitignoreOutcome } from "../core/root-gitignore.js";
import { TYR_VERSION } from "../core/version.js";
import { printJson, readGlobals, verbosityOf, type GlobalOptions } from "../core/globals.js";
import { createReporter } from "../ui/reporter.js";
import { ask, canPrompt, confirm } from "../ui/prompt.js";
import { reportDaemonStart, type DaemonSummary } from "./start.js";
import type {
    CommandKind,
    CommandProbe,
    CommandVerification,
    DiscoveryResult,
    GitInfo,
    InitSnapshot,
    ProjectCommand,
    ProjectProfile,
    Reporter,
} from "../core/types.js";

interface InitOptions {
    start?: boolean;
    force?: boolean;
    /** Re-initialize from scratch instead of merging; implies --force. */
    reset?: boolean;
    color?: boolean;
    /** False under `--no-verify`. */
    verify?: boolean;
    interactive?: boolean;
    /** True under `--gitignore`, false under `--no-gitignore`, otherwise unset. */
    gitignore?: boolean;
}

export function registerInitCommand(program: Command) {
    program
        .command("init")
        .description("Initialize Tyr in the current project")
        .option("-s, --start", "Initialize, then start the background process")
        .option("-f, --force", "Re-initialize even if .tyr already exists, keeping your edits")
        .option("--reset", "Re-initialize from scratch, discarding edits and state history (implies --force)")
        .option("--no-color", "Disable colored output")
        .option("--no-verify", "Skip checking that detected commands are runnable")
        .option("-i, --interactive", "Review and edit detected commands before writing")
        .option("--gitignore", "Add /.tyr/ to the project's root .gitignore without asking")
        .option("--no-gitignore", "Never touch the root .gitignore, and do not ask")
        .addHelpText("after", `
Finds the project root (the git toplevel, or the nearest directory with a
manifest), scans files, detects the toolchain and writes .tyr/ there.
Detected commands are checked without running them: the tool must resolve
(node_modules/.bin, then PATH) and answer --version, and npm scripts must
exist in package.json.

With --interactive, each command slot is shown before anything is written:
press Enter to keep it, type a command to replace it, or type "${CLEAR_TOKEN}" to clear
it. Typed commands are recorded with evidence "user". Declining the final
confirmation writes nothing. Without a terminal (piped, CI, --json) the
flag is ignored with a warning.

In a git repo whose root .gitignore does not already ignore .tyr/, init asks
whether to add /.tyr/ (tyr.json holds a machine-specific absolute path).
Without a terminal it only prints a hint; --gitignore / --no-gitignore decide
up front.

--force re-runs detection but keeps what you changed: commands you edited
in tyr.json (or marked "source": "user"), keys Tyr does not know about, and
state history (createdAt, runCount, lastRunAt, status). --reset discards all
of that and writes tyr.json and state.json from scratch.

Examples:
  $ tyr init                Initialize the current project
  $ tyr init --force        Re-detect, keeping edited commands and history
  $ tyr init --reset        Re-initialize from scratch, overwriting .tyr/
  $ tyr init --start        Initialize, then start the background process
  $ tyr init --no-color     Plain output, e.g. for logs
  $ tyr init --no-verify    Skip probing build/test/lint tools
  $ tyr init --interactive  Confirm or edit detected commands first
  $ tyr init --gitignore    Also add /.tyr/ to the root .gitignore
  $ tyr init --no-gitignore Leave the root .gitignore alone
  $ tyr init --verbose      Also show scan and write details
  $ tyr init --json         Print a JSON summary instead of text`)
        .action(async (options: InitOptions, command: Command) => {
            const globals = readGlobals(command);
            const result = await runInit(options, globals);
            if (globals.json) {
                printJson(result);
            }
            if (!result.ok) {
                // Signal failure to shells and CI without killing the process
                // mid-write, which process.exit() would risk.
                process.exitCode = 1;
            }
        });
}

/** The outcome of `tyr init`, and exactly what `--json` prints. */
type InitResult =
    | {
          ok: true;
          root: string;
          tyrDir: string;
          tyrVersion: string;
          fileCount: number;
          git: { isRepo: boolean; branch: string | null; detached: boolean; headCommit: string | null };
          project: ProjectProfile;
          /** Null under `--no-verify`. */
          commandChecks: CommandVerification | null;
          /** Null unless `--start` was given and the background process started. */
          daemon: DaemonSummary | null;
          /** What happened to the root `.gitignore`. */
          gitignore: GitignoreOutcome;
      }
    | { ok: false; root?: string; error: string };

async function runInit(options: InitOptions, globals: GlobalOptions): Promise<InitResult> {
    const reporter = createReporter({
        // `--no-color` gives us `color: false`; anything else stays auto-detected.
        color: options.color === false ? false : undefined,
        verbosity: verbosityOf(globals),
        // Under --json stdout carries only the JSON, so warnings and errors go to stderr.
        stream: globals.json ? process.stderr : undefined,
    });
    let root: string | undefined;

    reporter.header("Initializing Tyr...");
    reporter.blank();

    try {
        /* ---------------------------------------------------------------
         * Phase 1 — discovery, git, and identification
         * ------------------------------------------------------------ */

        const rootTask = reporter.task("Locating project root...");
        root = await findProjectRoot();
        rootTask.succeed(`Project root: ${root}`);

        if (await isInitialized(root)) {
            if (!options.force && !options.reset) {
                reporter.blank();
                reporter.warn("Project is already initialized (.tyr/tyr.json exists).");
                reporter.info("Re-run with --force to re-detect (keeping your edits), or --reset to start over.");
                reporter.stop();
                return { ok: false, root, error: "Project is already initialized (.tyr/tyr.json exists)" };
            }
            reporter.info(
                options.reset
                    ? "Existing configuration found - overwriting (--reset)."
                    : "Existing configuration found - re-detecting, keeping your edits (--force).",
            );
        }

        const git = await reportGit(reporter, root);

        const ignore = await loadExtraIgnore(reporter, root);

        const scanTask = reporter.task("Scanning project files...");
        const scan = await scanProject(root, { extraIgnore: ignore.patterns });
        scanTask.succeed(`Files scanned: ${scan.files.length}`);
        reporter.debug(`Skipped directories: ${scan.skippedDirs.length ? scan.skippedDirs.join(", ") : "none"}`);
        reporter.debug(`Ignored directory names: ${[...IGNORED_DIRS].sort().join(", ")}`);
        reporter.debug(`Ignored file names: ${[...IGNORED_FILES].sort().join(", ")}`);

        const profileTask = reporter.task("Identifying project...");
        let project = await profileProject(root, scan.files);
        profileTask.succeed(`Project type: ${project.primaryLanguage ?? "unknown"}`);

        // Probing spawns `<tool> --version` for each detected command, which
        // costs real time on a cold disk; --no-verify opts out entirely.
        let checks: CommandVerification | null = null;
        if (options.verify !== false) {
            const verifyTask = reporter.task("Verifying commands...");
            checks = await verifyCommands(root, project);
            verifyTask.succeed(`Commands checked: ${describeChecks(checks)}`);
        }

        reportProject(reporter, project, checks);

        if (options.interactive) {
            const reviewed = await reviewCommands(reporter, root, project, checks, globals);
            if (reviewed === null) {
                reporter.blank();
                reporter.warn("Configuration not written.");
                reporter.stop();
                return { ok: false, root, error: "Aborted: configuration not written" };
            }
            ({ project, checks } = reviewed);
        }

        const discovery: DiscoveryResult = {
            root,
            alreadyInitialized: false,
            files: scan.files,
            fileCount: scan.files.length,
            skippedDirs: scan.skippedDirs,
            // Recorded in tyr.json so a later run can tell whether the scan
            // rules changed underneath an existing index.
            ignoredDirs: [...IGNORED_DIRS].sort(),
            ignoredExtensions: [...IGNORED_EXTENSIONS].sort(),
            ignoredFiles: [...IGNORED_FILES].sort(),
            // Read from the old tyr.json before scaffold() overwrites it, so a
            // `--force` re-init keeps the user's hand-written patterns.
            extraIgnore: ignore.fromConfig,
        };

        const snapshot: InitSnapshot = { discovery, git, project };

        /* ---------------------------------------------------------------
         * Phase 2 — write `.tyr/`
         * ------------------------------------------------------------ */

        reporter.blank();
        reporter.header("Creating .tyr...");

        const writeTask = reporter.task("Writing configuration...");
        // Under the .tyr lock: scaffold() merges with the existing state.json,
        // so a concurrent init or daemon update must not interleave with it.
        const paths = await withTyrLock(root, "tyr init", () => scaffold(snapshot, TYR_VERSION, { reset: options.reset }));
        writeTask.succeed("Configuration created");
        reportPreserved(reporter, paths.preserved);
        reporter.debug(`Wrote ${paths.configFile}`);
        reporter.debug(`Wrote ${paths.stateFile}`);

        // Baseline for change detection: `tyr status` / `tyr watch` diff
        // later scans against this manifest.
        const manifest = await buildScanManifest(root, scan.files);
        await saveScanManifest(root, manifest);
        reporter.debug(`Wrote ${paths.scanFile} (${manifest.fileCount} files fingerprinted)`);
        reporter.success("State initialized");
        reporter.success("Logging initialized");

        await appendLog(root, "info", `tyr init completed - ${scan.files.length} files indexed`);
        await appendEvent(root, {
            source: "tyr",
            kind: "init.completed",
            message: options.reset ? "Re-initialized from scratch (--reset)" : options.force ? "Re-initialized (--force)" : "Initialized",
            data: {
                force: options.force === true,
                reset: options.reset === true,
                tyrVersion: TYR_VERSION,
                primaryLanguage: project.primaryLanguage,
                fileCount: scan.files.length,
                headCommit: git.headCommit?.hash ?? null,
            },
        });

        const gitignore = await offerRootGitignore(reporter, root, options, git.isRepo, globals.json === true);

        reporter.blank();
        reporter.done("Tyr initialized successfully.");

        // Same code path and output as `tyr start`. Init itself succeeded, so a
        // failed start keeps `ok: true` but still fails the exit code.
        let daemon: DaemonSummary | null = null;
        if (options.start) {
            reporter.blank();
            daemon = await reportDaemonStart(reporter, root);
            if (daemon === null) process.exitCode = 1;
        }

        reporter.stop();
        return {
            ok: true,
            root,
            tyrDir: paths.tyrDir,
            tyrVersion: TYR_VERSION,
            fileCount: scan.files.length,
            git: {
                isRepo: git.isRepo,
                branch: git.branch,
                detached: git.detached,
                headCommit: git.headCommit?.hash ?? null,
            },
            project,
            commandChecks: checks,
            daemon,
            gitignore,
        };
    } catch (error) {
        // Any throw here means `.tyr` may be incomplete, so say so plainly
        // rather than reporting a success the user does not actually have.
        // Fail the in-flight task first so the output names the step that broke.
        reporter.failActive();
        reporter.stop();
        reporter.blank();
        reporter.error(`Initialization failed: ${describeError(error)}`);
        return { ok: false, root, error: describeError(error) };
    }
}

/** Adds, offers or skips the root `.gitignore` entry; the policy lives in root-gitignore.ts. */
async function offerRootGitignore(
    reporter: Reporter,
    root: string,
    options: InitOptions,
    isRepo: boolean,
    json: boolean,
): Promise<GitignoreOutcome> {
    const { outcome, suggestFlag } = await applyGitignorePolicy(root, {
        flag: options.gitignore,
        isRepo,
        interactive: canPrompt({ json }),
        ask: () => {
            // The prompt writes to the same terminal, so no spinner may own the line.
            reporter.stop();
            return confirm(`Add ${TYR_GITIGNORE_ENTRY} to the project's .gitignore?`, true);
        },
    });
    if (outcome === "added") reporter.success(`Added ${TYR_GITIGNORE_ENTRY} to .gitignore`);
    else if (outcome === "present") reporter.debug(".gitignore already ignores .tyr/");
    else if (outcome === "declined") reporter.muted(".gitignore left unchanged");
    else if (suggestFlag) reporter.muted(`.gitignore does not ignore .tyr/ (run with --gitignore to add ${TYR_GITIGNORE_ENTRY})`);
    return outcome;
}

/**
 * An empty `.tyr/` directory (say, from an interrupted run) is not a real
 * installation, so require a readable config before refusing to re-init.
 */
async function isInitialized(root: string): Promise<boolean> {
    if (!(await isAlreadyInitialized(root))) {
        return false;
    }
    return (await readConfig(root)) !== null;
}

/**
 * Gather user ignore patterns: `scan.extraIgnore` from any existing tyr.json,
 * then `.tyrignore`. The file goes last so its rules win on conflict (the last
 * matching pattern decides). Silent apart from verbose detail lines.
 */
async function loadExtraIgnore(
    reporter: Reporter,
    root: string,
): Promise<{ patterns: string[]; fromConfig: string[] }> {
    const config = await readConfig(root);
    // tyr.json may be hand-edited; keep only strings and ignore any other shape.
    const rawExtra: unknown = config?.scan?.extraIgnore;
    const fromConfig = Array.isArray(rawExtra)
        ? rawExtra.filter((entry): entry is string => typeof entry === "string")
        : [];
    const fromFile = (await readTyrIgnore(root)) ?? [];

    const configCount = countPatterns(fromConfig);
    const fileCount = countPatterns(fromFile);
    reporter.debug(
        `Extra ignore patterns: ${configCount} from tyr.json (scan.extraIgnore), ` +
            `${fileCount} from ${TYR_IGNORE_FILE}`,
    );

    return { patterns: [...fromConfig, ...fromFile], fromConfig };
}

/** Says what a `--force` re-init carried over; silent on a fresh init. */
function reportPreserved(reporter: Reporter, preserved: ScaffoldPreserved): void {
    const { commands, configKeys, stateFields } = preserved;
    if (commands.length) {
        reporter.info(
            `Kept ${commands.length} user-edited command${commands.length === 1 ? "" : "s"}: ${commands.join(", ")}`,
        );
    }
    if (configKeys.length) reporter.debug(`Kept tyr.json keys: ${configKeys.join(", ")}`);
    if (stateFields.length) reporter.debug(`Kept state fields: ${stateFields.join(", ")}`);
}

/** Runs git detection and prints the repository, branch, commit, status, remote. */
async function reportGit(reporter: Reporter, root: string): Promise<GitInfo> {
    const gitTask = reporter.task("Detecting git repository...");
    const git = await collectGitInfo(root);

    if (!git.isRepo) {
        gitTask.skip("Git repository: none");
        return git;
    }
    gitTask.succeed("Git repository detected");

    if (git.branch) {
        reporter.success(`Branch: ${git.branch}${git.detached ? " (detached)" : ""}`);
    } else {
        reporter.muted("Branch: detached HEAD");
    }

    if (git.headCommit) {
        reporter.success(`Commit: ${git.headCommit.shortHash} ${git.headCommit.subject}`);
    } else {
        reporter.muted("Commit: no commits yet");
    }

    if (git.status) {
        reporter.success(`Working tree: ${describeStatus(git.status)}`);
        if (git.status.untrackedSkipped) {
            reporter.warn("Working tree: git status was slow, so untracked files were not checked");
        }
    } else if (git.statusTimedOut) {
        reporter.warn("Working tree: git status timed out; status unknown");
    }

    const remote = git.remotes.find((r) => r.name === git.defaultRemote) ?? git.remotes[0];
    if (remote) {
        const url = remote.fetchUrl ?? remote.pushUrl;
        reporter.success(`Remote: ${remote.name}${url ? ` (${url})` : ""}`);
    } else {
        reporter.muted("Remote: none configured");
    }

    return git;
}

/** Condenses porcelain counts into one human-readable phrase. */
function describeStatus(status: NonNullable<GitInfo["status"]>): string {
    const parts: string[] = [];
    if (status.staged.length) parts.push(`${status.staged.length} staged`);
    if (status.modified.length) parts.push(`${status.modified.length} modified`);
    if (status.untracked.length) parts.push(`${status.untracked.length} untracked`);
    if (status.conflicted.length) parts.push(`${status.conflicted.length} conflicted`);

    const tracking: string[] = [];
    if (status.ahead) tracking.push(`${status.ahead} ahead`);
    if (status.behind) tracking.push(`${status.behind} behind`);

    const summary = parts.length ? parts.join(", ") : "clean";
    return tracking.length ? `${summary} (${tracking.join(", ")})` : summary;
}

/** Prints the toolchain Tyr will drive: frameworks, package manager, commands, docs. */
function reportProject(
    reporter: Reporter,
    project: ProjectProfile,
    checks: CommandVerification | null,
): void {
    if (project.frameworks.length) {
        reporter.success(`Frameworks: ${project.frameworks.join(", ")}`);
    }

    if (project.packageManager) {
        reporter.success(`Package manager: ${project.packageManager.name}`);
    } else {
        reporter.muted("Package manager: none detected");
    }

    // Single-package projects are the common case, so absence stays silent.
    if (project.workspace) {
        const { tool, packages } = project.workspace;
        reporter.success(`Workspace: ${tool} (${packages.length} package${packages.length === 1 ? "" : "s"})`);
        for (const pkg of packages) {
            reporter.debug(`Workspace package: ${pkg.path}${pkg.name ? ` (${pkg.name})` : ""}`);
        }
    }

    reportCommand(reporter, "Build", project.build, checks?.build ?? null);
    reportCommand(reporter, "Tests", project.test, checks?.test ?? null);
    reportCommand(reporter, "Linter", project.lint, checks?.lint ?? null);
    reportCommand(reporter, "Formatter", project.format, checks?.format ?? null);
    reportCommand(reporter, "Type checker", project.typecheck, checks?.typecheck ?? null);

    if (project.readme) {
        reporter.success(`${project.readme} detected`);
    } else {
        reporter.muted("README not found");
    }

    if (project.claudeMd) {
        reporter.success(`${project.claudeMd} detected`);
    } else {
        reporter.muted("CLAUDE.md not found");
    }
}

/**
 * A command that failed its probe is still reported (and still written to
 * tyr.json) — the user may simply not have run `npm install` yet — but as a
 * warning carrying the reason instead of a `✓`.
 */
function reportCommand(
    reporter: Reporter,
    label: string,
    command: ProjectCommand | null,
    probe: CommandProbe | null,
): void {
    if (!command) {
        reporter.muted(`${label}: none detected`);
        return;
    }
    if (probe?.status === "missing" || probe?.status === "failed") {
        reporter.warn(`${label}: ${command.tool} - ${probe.detail}`);
        return;
    }
    reporter.success(`${label}: ${command.tool}`);
    if (probe) {
        reporter.debug(`${label} (${command.command}): ${probe.status} - ${probe.detail}`);
    }
}

/**
 * `--interactive`: let the user keep, replace or clear each command, then
 * re-verify only what they typed. Returns null when they decline to write.
 * Falls back to the detected commands, with a warning, when nobody can answer.
 */
async function reviewCommands(
    reporter: Reporter,
    root: string,
    project: ProjectProfile,
    checks: CommandVerification | null,
    globals: GlobalOptions,
): Promise<{ project: ProjectProfile; checks: CommandVerification | null } | null> {
    if (!canPrompt({ json: globals.json })) {
        reporter.warn("--interactive needs a terminal; keeping the detected commands.");
        return { project, checks };
    }

    // No spinner may share the line with a question.
    reporter.stop();
    reporter.blank();
    const edit = await editCommands(project, {
        ask: (question, current) => ask(question, current),
        confirm: (question, defaultYes) => confirm(question, defaultYes),
        checks,
        say: (line) => reporter.info(line),
    });
    if (!edit.confirmed) return null;

    if (checks) {
        checks = { ...checks };
        for (const kind of edit.cleared) checks[kind] = null;
        if (edit.changed.length) {
            // Probe only what the user typed; kept commands keep their result.
            const only: Pick<ProjectProfile, CommandKind> = {
                build: null, test: null, lint: null, format: null, typecheck: null,
            };
            for (const kind of edit.changed) only[kind] = edit.project[kind];
            const verifyTask = reporter.task("Verifying edited commands...");
            const fresh = await verifyCommands(root, only);
            for (const kind of edit.changed) checks[kind] = fresh[kind];
            verifyTask.succeed(`Edited commands checked: ${describeChecks(fresh)}`);
        }
    }

    if (edit.changed.length || edit.cleared.length) {
        reporter.blank();
        for (const { kind, label } of COMMAND_SLOTS) {
            if (edit.changed.includes(kind) || edit.cleared.includes(kind)) {
                reportCommand(reporter, label, edit.project[kind], checks?.[kind] ?? null);
            }
        }
    }
    return { project: edit.project, checks };
}

/** e.g. "3 ok, 1 missing" over the slots that had a command. */
function describeChecks(checks: CommandVerification): string {
    const counts = new Map<CommandProbe["status"], number>();
    for (const probe of Object.values(checks)) {
        if (probe) counts.set(probe.status, (counts.get(probe.status) ?? 0) + 1);
    }
    if (counts.size === 0) return "none detected";
    return (["ok", "missing", "failed", "skipped"] as const)
        .filter((status) => counts.has(status))
        .map((status) => `${counts.get(status)} ${status}`)
        .join(", ");
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
