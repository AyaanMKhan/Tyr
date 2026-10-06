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
import { scaffold, readConfig, appendLog } from "../core/scaffold.js";
import { countPatterns, readTyrIgnore, TYR_IGNORE_FILE } from "../core/ignore.js";
import { TYR_VERSION } from "../core/version.js";
import { printJson, readGlobals, verbosityOf, type GlobalOptions } from "../core/globals.js";
import { createReporter } from "../ui/reporter.js";
import type {
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
    color?: boolean;
}

export function registerInitCommand(program: Command) {
    program
        .command("init")
        .description("Initialize Tyr in the current project")
        .option("-s, --start", "Initialize, then start the background process")
        .option("-f, --force", "Re-initialize even if .tyr already exists")
        .option("--no-color", "Disable colored output")
        .addHelpText("after", `
Finds the project root (the git toplevel, or the nearest directory with a
manifest), scans files, detects the toolchain and writes .tyr/ there.

Examples:
  $ tyr init                Initialize the current project
  $ tyr init --force        Re-initialize, overwriting .tyr/
  $ tyr init --start        Initialize, then start the background process
  $ tyr init --no-color     Plain output, e.g. for logs
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
          git: { isRepo: boolean; branch: string | null; headCommit: string | null };
          project: ProjectProfile;
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
            if (!options.force) {
                reporter.blank();
                reporter.warn("Project is already initialized (.tyr/tyr.json exists).");
                reporter.info("Re-run with --force to overwrite the existing configuration.");
                reporter.stop();
                return { ok: false, root, error: "Project is already initialized (.tyr/tyr.json exists)" };
            }
            reporter.info("Existing configuration found - overwriting (--force).");
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
        const project = await profileProject(root, scan.files);
        profileTask.succeed(`Project type: ${project.primaryLanguage ?? "unknown"}`);

        reportProject(reporter, project);

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
        const paths = await scaffold(snapshot, TYR_VERSION);
        writeTask.succeed("Configuration created");
        reporter.debug(`Wrote ${paths.configFile}`);
        reporter.debug(`Wrote ${paths.stateFile}`);
        reporter.success("State initialized");
        reporter.success("Logging initialized");

        await appendLog(root, "info", `tyr init completed - ${scan.files.length} files indexed`);

        reporter.blank();
        reporter.done("Tyr initialized successfully.");

        if (options.start) {
            reporter.blank();
            reporter.warn("--start was requested, but the background process is not implemented yet.");
            await appendLog(root, "warn", "--start requested but background process is unimplemented");
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
                headCommit: git.headCommit?.hash ?? null,
            },
            project,
        };
    } catch (error) {
        // Any throw here means `.tyr` may be incomplete, so say so plainly
        // rather than reporting a success the user does not actually have.
        reporter.stop();
        reporter.blank();
        reporter.error(`Initialization failed: ${describeError(error)}`);
        return { ok: false, root, error: describeError(error) };
    }
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
function reportProject(reporter: Reporter, project: ProjectProfile): void {
    if (project.frameworks.length) {
        reporter.success(`Frameworks: ${project.frameworks.join(", ")}`);
    }

    if (project.packageManager) {
        reporter.success(`Package manager: ${project.packageManager.name}`);
    } else {
        reporter.muted("Package manager: none detected");
    }

    reportCommand(reporter, "Build", project.build);
    reportCommand(reporter, "Tests", project.test);
    reportCommand(reporter, "Linter", project.lint);
    reportCommand(reporter, "Formatter", project.format);
    reportCommand(reporter, "Type checker", project.typecheck);

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

function reportCommand(reporter: Reporter, label: string, command: ProjectCommand | null): void {
    if (command) {
        reporter.success(`${label}: ${command.tool}`);
    } else {
        reporter.muted(`${label}: none detected`);
    }
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
