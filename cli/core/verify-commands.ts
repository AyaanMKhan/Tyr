// Command verification: do the commands `tyr init` detected actually run here?
//
// Detection only proves a project *intends* to use a tool; it says nothing
// about whether that tool is installed. This module checks each command
// without running it for real — builds and test suites are slow and have side
// effects. Instead:
//
// - `npm|pnpm|yarn|bun run <script>` (and `npm test`): the package manager
//   must resolve on PATH and the script must exist in package.json. Nothing is
//   spawned; a corepack shim may try to download a package manager on first
//   use, which is exactly the kind of side effect we are avoiding.
// - `npx <tool> ...` and bare tools (`pytest`, `cargo test`, `ruff check .`):
//   the executable must resolve, first from `node_modules/.bin` under the root
//   and then from PATH, and answer a cheap probe like `<tool> --version`.
// - Anything with shell syntax (pipes, `&&`, quotes, variables) is skipped
//   rather than guessed at.
//
// Like the detectors, everything here is total and silent: verifyCommands()
// never throws and never prints. PATH, the platform and the process spawner
// are all injectable so tests stay deterministic without real tools installed.

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type {
    CommandKind,
    CommandProbe,
    CommandVerification,
    ProjectCommand,
    ProjectProfile,
} from "./types.js";

/* -------------------------------------------------------------------------
 * Options
 * ---------------------------------------------------------------------- */

/** What a probe process did. `code` is null when it was killed or never ran. */
export interface SpawnResult {
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    /** Spawn-level failure, e.g. ENOENT or EACCES. */
    error?: NodeJS.ErrnoException;
}

export type Spawner = (
    file: string,
    args: readonly string[],
    options: { cwd: string; timeoutMs: number },
) => Promise<SpawnResult>;

export interface VerifyOptions {
    /** PATH to search. Defaults to `process.env.PATH`. */
    path?: string;
    /** Windows executable extensions. Defaults to `process.env.PATHEXT`. */
    pathExt?: string;
    /** Defaults to `process.platform`; only Windows changes the lookup. */
    platform?: NodeJS.Platform;
    /** Process runner for `--version` probes. Defaults to a real spawn. */
    spawn?: Spawner;
    /** Per-probe time limit. Defaults to 5 seconds. */
    timeoutMs?: number;
    /** When false, resolve executables but never spawn them. Defaults to true. */
    probe?: boolean;
}

const DEFAULT_TIMEOUT_MS = 5000;

/** Probe output beyond this is noise; one version line is all we keep. */
const MAX_OUTPUT_CHARS = 64 * 1024;

const COMMAND_KINDS: readonly CommandKind[] = ["build", "test", "lint", "format", "typecheck"];

/** Package managers whose `run <script>` we check against package.json. */
const SCRIPT_RUNNERS: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn", "bun"]);

/** Package-runner wrappers that execute a locally installed binary. */
const PACKAGE_EXECUTORS: ReadonlySet<string> = new Set(["npx", "pnpx", "bunx"]);

/**
 * Arguments that make a tool print something cheap and exit 0. Tools absent
 * here get `--version`; a null entry means "resolve only, never spawn" for
 * tools with no harmless flag (gofmt treats every flag as a formatting option).
 */
const PROBE_ARGS: Readonly<Record<string, readonly string[] | null>> = {
    go: ["version"],
    gofmt: null,
};

/** Characters that mean the command needs a shell to interpret it. */
const SHELL_SYNTAX = /[|&;<>()$`"'\\*?~{}\[\]]/;

/* -------------------------------------------------------------------------
 * Command parsing
 * ---------------------------------------------------------------------- */

/** What to check for one command, decided purely from its text. */
type ProbePlan =
    | { kind: "script"; runner: string; script: string }
    | { kind: "tool"; bin: string; viaExecutor: boolean }
    | { kind: "skip"; reason: string };

function planFor(command: string): ProbePlan {
    const trimmed = command.trim();
    if (trimmed === "") return { kind: "skip", reason: "empty command" };
    if (SHELL_SYNTAX.test(trimmed)) {
        return { kind: "skip", reason: "uses shell syntax, not checked" };
    }

    const tokens = trimmed.split(/\s+/);
    const [head, ...rest] = tokens;
    // `FOO=1 cmd` sets an environment variable first; that needs a shell too.
    if (head.includes("=")) return { kind: "skip", reason: "sets environment variables, not checked" };

    if (SCRIPT_RUNNERS.has(head)) {
        // `npm test` / `npm start` are built-in shortcuts for `npm run <name>`.
        if (rest[0] === "run" && rest[1] !== undefined && !rest[1].startsWith("-")) {
            return { kind: "script", runner: head, script: rest[1] };
        }
        if (rest.length >= 1 && (rest[0] === "test" || rest[0] === "start")) {
            return { kind: "script", runner: head, script: rest[0] };
        }
        return { kind: "skip", reason: `unrecognised ${head} invocation` };
    }

    if (PACKAGE_EXECUTORS.has(head)) {
        const bin = rest.find((token) => !token.startsWith("-"));
        if (bin === undefined) return { kind: "skip", reason: `${head} without a tool name` };
        // `npx @scope/pkg` installs the package's bin, whose name we cannot know.
        if (bin.startsWith("@")) return { kind: "skip", reason: `${head} ${bin}: bin name unknown` };
        return { kind: "tool", bin, viaExecutor: true };
    }

    return { kind: "tool", bin: head, viaExecutor: false };
}

/* -------------------------------------------------------------------------
 * Executable resolution
 * ---------------------------------------------------------------------- */

interface Resolver {
    platform: NodeJS.Platform;
    pathDirs: string[];
    extensions: string[];
}

function makeResolver(options: VerifyOptions): Resolver {
    const platform = options.platform ?? process.platform;
    const isWindows = platform === "win32";
    const rawPath = options.path ?? process.env.PATH ?? "";
    const pathDirs = rawPath.split(isWindows ? ";" : ":").filter((dir) => dir !== "");
    // On Windows a bare name is never executable; it needs one of PATHEXT.
    const extensions = isWindows
        ? (options.pathExt ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
              .split(";")
              .filter((ext) => ext !== "")
        : [""];
    return { platform, pathDirs, extensions };
}

async function isExecutableFile(file: string): Promise<boolean> {
    try {
        const stats = await fs.stat(file);
        if (!stats.isFile()) return false;
        // X_OK degrades to an existence check on Windows, which is what we want.
        await fs.access(file, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/** First `dir/name<ext>` that is an executable file, or null. */
async function findIn(resolver: Resolver, dirs: readonly string[], name: string): Promise<string | null> {
    // A name that already carries an extension (`tool.exe`) is tried as-is too.
    const candidates = resolver.platform === "win32" && path.extname(name) !== ""
        ? ["", ...resolver.extensions]
        : resolver.extensions;
    for (const dir of dirs) {
        for (const ext of candidates) {
            const file = path.join(dir, name + ext);
            if (await isExecutableFile(file)) return file;
        }
    }
    return null;
}

/** Where a tool resolved from, so the detail line can say so. */
interface Resolved {
    file: string;
    source: "local" | "PATH";
}

async function resolveTool(resolver: Resolver, root: string, bin: string): Promise<Resolved | null> {
    // A path-like command (`./gradlew`, `bin/build`) is resolved against root only.
    if (bin.includes("/") || bin.includes("\\")) {
        const file = await findIn(resolver, [root], bin);
        return file === null ? null : { file, source: "local" };
    }
    const local = await findIn(resolver, [path.join(root, "node_modules", ".bin")], bin);
    if (local !== null) return { file: local, source: "local" };
    const global = await findIn(resolver, resolver.pathDirs, bin);
    return global === null ? null : { file: global, source: "PATH" };
}

/* -------------------------------------------------------------------------
 * Probing
 * ---------------------------------------------------------------------- */

/**
 * Default spawner: no shell, stdin closed, output capped, hard kill on timeout.
 * Resolves exactly once and never rejects.
 */
const realSpawn: Spawner = (file, args, { cwd, timeoutMs }) =>
    new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let settled = false;
        const finish = (result: Omit<SpawnResult, "stdout" | "stderr" | "timedOut">): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ ...result, stdout, stderr, timedOut });
        };

        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(file, [...args], {
                cwd,
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
            });
        } catch (error) {
            // spawn() throws synchronously for things like EINVAL on Windows.
            resolve({ code: null, stdout, stderr, timedOut, error: error as NodeJS.ErrnoException });
            return;
        }

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
        }, timeoutMs);

        child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
            if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk;
        });
        child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
            if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk;
        });
        child.on("error", (error) => finish({ code: null, error }));
        child.on("close", (code) => finish({ code }));
    });

function firstLine(text: string): string {
    const line = text.split(/\r?\n/).find((candidate) => candidate.trim() !== "") ?? "";
    const trimmed = line.trim();
    return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
}

/** Shared state for one verifyCommands() call. */
interface ProbeContext {
    root: string;
    resolver: Resolver;
    spawn: Spawner;
    timeoutMs: number;
    probe: boolean;
    scripts: Promise<Record<string, unknown> | null>;
    /** In-flight probes keyed by `file + args`, so `cargo build`/`cargo test` spawn once. */
    runs: Map<string, Promise<CommandProbe>>;
}

/** The `scripts` object of root package.json, or null when there is none. */
async function readScripts(root: string): Promise<Record<string, unknown> | null> {
    try {
        const parsed: unknown = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
        if (typeof parsed !== "object" || parsed === null) return null;
        const scripts = (parsed as { scripts?: unknown }).scripts;
        return typeof scripts === "object" && scripts !== null ? (scripts as Record<string, unknown>) : {};
    } catch {
        return null;
    }
}

async function probeScript(ctx: ProbeContext, runner: string, script: string): Promise<CommandProbe> {
    const [manager, scripts] = await Promise.all([
        findIn(ctx.resolver, ctx.resolver.pathDirs, runner),
        ctx.scripts,
    ]);
    if (scripts === null) return { status: "missing", detail: "package.json not found or unreadable" };
    if (typeof scripts[script] !== "string") {
        return { status: "missing", detail: `script "${script}" not found in package.json` };
    }
    if (manager === null) return { status: "missing", detail: `${runner} not found on PATH` };
    return { status: "ok", detail: `script "${script}" runs via ${runner}` };
}

async function probeTool(ctx: ProbeContext, bin: string, viaExecutor: boolean): Promise<CommandProbe> {
    const resolved = await resolveTool(ctx.resolver, ctx.root, bin);
    if (resolved === null) {
        return {
            status: "missing",
            detail: viaExecutor
                ? `${bin} not installed (not in node_modules/.bin or on PATH)`
                : `${bin} not found on PATH`,
        };
    }

    const where = resolved.source === "local" ? "node_modules/.bin" : "PATH";
    const name = path.basename(bin);
    const args = Object.hasOwn(PROBE_ARGS, name) ? PROBE_ARGS[name] : ["--version"];
    // Windows batch shims cannot be spawned without a shell, which we refuse.
    const isBatch = /\.(bat|cmd)$/i.test(resolved.file);
    if (!ctx.probe || args === null || isBatch) {
        return { status: "ok", detail: `${bin} found in ${where}` };
    }

    const key = [resolved.file, ...args].join("\0");
    let run = ctx.runs.get(key);
    if (run === undefined) {
        run = runProbe(ctx, bin, resolved.file, args, where);
        ctx.runs.set(key, run);
    }
    return run;
}

async function runProbe(
    ctx: ProbeContext,
    bin: string,
    file: string,
    args: readonly string[],
    where: string,
): Promise<CommandProbe> {
    const shown = [bin, ...args].join(" ");
    const result = await ctx.spawn(file, args, { cwd: ctx.root, timeoutMs: ctx.timeoutMs });

    if (result.timedOut) {
        return { status: "failed", detail: `"${shown}" timed out after ${ctx.timeoutMs}ms` };
    }
    if (result.error !== undefined) {
        // Resolved a moment ago, so ENOENT here means it vanished or is a broken link.
        if (result.error.code === "ENOENT") return { status: "missing", detail: `${bin} could not be started` };
        return { status: "failed", detail: `${bin} could not be started (${result.error.code ?? result.error.message})` };
    }
    if (result.code !== 0) {
        const reason = firstLine(result.stderr) || firstLine(result.stdout);
        const code = result.code === null ? "a signal" : `code ${result.code}`;
        return { status: "failed", detail: `"${shown}" exited with ${code}${reason ? `: ${reason}` : ""}` };
    }
    const version = firstLine(result.stdout) || firstLine(result.stderr);
    return { status: "ok", detail: version ? `${version} (${where})` : `${bin} found in ${where}` };
}

async function verifyOne(ctx: ProbeContext, command: ProjectCommand): Promise<CommandProbe> {
    try {
        const plan = planFor(command.command);
        switch (plan.kind) {
            case "skip":
                return { status: "skipped", detail: plan.reason };
            case "script":
                return await probeScript(ctx, plan.runner, plan.script);
            case "tool":
                return await probeTool(ctx, plan.bin, plan.viaExecutor);
        }
    } catch (error) {
        // An injected spawner or an fs oddity must not take `tyr init` down.
        const message = error instanceof Error ? error.message : String(error);
        return { status: "failed", detail: `could not verify: ${message}` };
    }
}

/* -------------------------------------------------------------------------
 * Entry point
 * ---------------------------------------------------------------------- */

/**
 * Check every command in `profile` concurrently. Slots without a command map
 * to null. Never throws; every problem becomes a `missing`, `failed` or
 * `skipped` probe.
 */
export async function verifyCommands(
    root: string,
    profile: Pick<ProjectProfile, CommandKind>,
    options: VerifyOptions = {},
): Promise<CommandVerification> {
    const ctx: ProbeContext = {
        root,
        resolver: makeResolver(options),
        spawn: options.spawn ?? realSpawn,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        probe: options.probe ?? true,
        scripts: readScripts(root),
        runs: new Map(),
    };

    const probes = await Promise.all(
        COMMAND_KINDS.map(async (kind) => {
            const command = profile[kind];
            return [kind, command === null ? null : await verifyOne(ctx, command)] as const;
        }),
    );
    return Object.fromEntries(probes) as CommandVerification;
}
