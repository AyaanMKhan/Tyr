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
} from "../core/discovery.js";
import { collectGitInfo } from "../core/git.js";
import { profileProject } from "../core/project.js";
import { scaffold, readConfig, appendLog } from "../core/scaffold.js";
import { createReporter } from "../ui/reporter.js";
import type {
    DiscoveryResult,
    GitInfo,
    InitSnapshot,
    ProjectCommand,
    ProjectProfile,
    Reporter,
} from "../core/types.js";

/** Schema/tool version stamped into `.tyr/tyr.json`. Keep in sync with index.ts. */
const TYR_VERSION = "1.0.0";

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
        .action(async (options: InitOptions) => {
            const ok = await runInit(options);
            if (!ok) {
                // Signal failure to shells and CI without killing the process
                // mid-write, which process.exit() would risk.
                process.exitCode = 1;
            }
        });
}

/** Returns false when initialization did not complete. */
async function runInit(options: InitOptions): Promise<boolean> {
    const reporter = createReporter({
        // `--no-color` gives us `color: false`; anything else stays auto-detected.
        color: options.color === false ? false : undefined,
    });

    reporter.header("Initializing Tyr...");
    reporter.blank();

    try {
        /* ---------------------------------------------------------------
         * Phase 1 — discovery, git, and identification
         * ------------------------------------------------------------ */

        const rootTask = reporter.task("Locating project root...");
        const root = await findProjectRoot();
        rootTask.succeed(`Project root: ${root}`);

        if (await isInitialized(root)) {
            if (!options.force) {
                reporter.blank();
                reporter.warn("Project is already initialized (.tyr/tyr.json exists).");
                reporter.info("Re-run with --force to overwrite the existing configuration.");
                reporter.stop();
                return false;
            }
            reporter.info("Existing configuration found - overwriting (--force).");
        }

        const git = await reportGit(reporter, root);

        const scanTask = reporter.task("Scanning project files...");
        const scan = await scanProject(root);
        scanTask.succeed(`Files scanned: ${scan.files.length}`);

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
        };

        const snapshot: InitSnapshot = { discovery, git, project };

        /* ---------------------------------------------------------------
         * Phase 2 — write `.tyr/`
         * ------------------------------------------------------------ */

        reporter.blank();
        reporter.header("Creating .tyr...");

        const writeTask = reporter.task("Writing configuration...");
        await scaffold(snapshot, TYR_VERSION);
        writeTask.succeed("Configuration created");
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
        return true;
    } catch (error) {
        // Any throw here means `.tyr` may be incomplete, so say so plainly
        // rather than reporting a success the user does not actually have.
        reporter.stop();
        reporter.blank();
        reporter.error(`Initialization failed: ${describeError(error)}`);
        return false;
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
