// Project identification: what the project is written in, what runs it, and
// which commands Tyr can invoke on it.
//
// Every detector here is total. A missing manifest, an unreadable directory or
// a malformed `package.json` are all normal outcomes for a project we know
// nothing about, so failures degrade to null/empty rather than throwing. This
// module is also silent — the reporter owns every line of user-facing output.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
    LanguageStat,
    PackageManagerInfo,
    ProjectCommand,
    ProjectProfile,
} from "./types.js";

/* -------------------------------------------------------------------------
 * Language tables
 * ---------------------------------------------------------------------- */

/** File extension -> display name. Extensions not listed stay unclassified. */
const LANGUAGE_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
    [".ts", "TypeScript"],
    [".tsx", "TypeScript"],
    [".mts", "TypeScript"],
    [".cts", "TypeScript"],
    [".js", "JavaScript"],
    [".jsx", "JavaScript"],
    [".mjs", "JavaScript"],
    [".cjs", "JavaScript"],
    [".py", "Python"],
    [".pyi", "Python"],
    [".go", "Go"],
    [".rs", "Rust"],
    [".java", "Java"],
    [".kt", "Kotlin"],
    [".kts", "Kotlin"],
    [".c", "C"],
    [".h", "C"],
    [".cpp", "C++"],
    [".cc", "C++"],
    [".cxx", "C++"],
    [".hpp", "C++"],
    [".cs", "C#"],
    [".rb", "Ruby"],
    [".php", "PHP"],
    [".swift", "Swift"],
    [".sh", "Shell"],
    [".bash", "Shell"],
    [".zsh", "Shell"],
    [".html", "HTML"],
    [".css", "CSS"],
    [".scss", "CSS"],
    [".sass", "CSS"],
    [".less", "CSS"],
    [".sql", "SQL"],
    [".md", "Markdown"],
    [".json", "JSON"],
    [".yml", "YAML"],
    [".yaml", "YAML"],
]);

/**
 * Docs and data formats. They still show up in `languages` for completeness,
 * but a repo of three `.ts` files and forty `.md` files is a TypeScript
 * project, so they can never win the primary-language decision.
 */
const SUPPORTING_LANGUAGES: ReadonlySet<string> = new Set([
    "Markdown",
    "JSON",
    "YAML",
]);

/** Extensions that imply JSX, which is a strong React signal. */
const JSX_EXTENSIONS: readonly string[] = [".tsx", ".jsx"];

/* -------------------------------------------------------------------------
 * Root context — read the filesystem once, answer every question from memory
 * ---------------------------------------------------------------------- */

/** The slice of `package.json` we care about, normalized so nothing is optional. */
interface PackageJson {
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    /** Corepack's `"pnpm@9.0.0"` declaration, when present. */
    packageManager: string | null;
}

/**
 * One readdir of the project root plus the handful of small manifests we grep.
 * Threading this through the detectors keeps `tyr init` to a single pass over
 * the root instead of dozens of stat calls.
 */
interface RootContext {
    root: string;
    /** Root entry names keyed by lowercase name, so lookups ignore case. */
    entries: ReadonlyMap<string, string>;
    pkg: PackageJson | null;
    /** Text of marker manifests, keyed by lowercase filename. */
    markers: ReadonlyMap<string, string>;
}

/**
 * Manifests we read in full because detection needs their contents. Everything
 * else is answered by filename alone, which is why lockfiles are absent here.
 */
const MARKER_FILES: readonly string[] = [
    "pyproject.toml",
    "requirements.txt",
    "Pipfile",
    "setup.py",
    "setup.cfg",
    "Cargo.toml",
    "go.mod",
    "Gemfile",
    "composer.json",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
];

async function readTextFile(file: string): Promise<string | null> {
    try {
        return await fs.readFile(file, "utf8");
    } catch {
        // Missing, unreadable or a directory — all "not found" as far as we care.
        return null;
    }
}

/** Keep only the string-valued members of a JSON object, ignoring junk. */
function stringRecord(value: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    if (typeof value !== "object" || value === null) return out;
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
        if (typeof entryValue === "string") out[key] = entryValue;
    }
    return out;
}

async function readPackageJson(root: string): Promise<PackageJson | null> {
    const text = await readTextFile(path.join(root, "package.json"));
    if (text === null) return null;

    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        // A half-written manifest should not sink the whole init run.
        return null;
    }
    if (typeof parsed !== "object" || parsed === null) return null;

    const raw = parsed as Record<string, unknown>;
    const declared = raw["packageManager"];
    return {
        scripts: stringRecord(raw["scripts"]),
        dependencies: stringRecord(raw["dependencies"]),
        devDependencies: stringRecord(raw["devDependencies"]),
        packageManager: typeof declared === "string" ? declared : null,
    };
}

async function readRootEntries(root: string): Promise<Map<string, string>> {
    const index = new Map<string, string>();
    let names: string[];
    try {
        names = await fs.readdir(root);
    } catch {
        // Unreadable root: every lookup simply reports "absent".
        return index;
    }
    // Sorted so that a case-collision (README.md / readme.md) resolves the same
    // way on every run and on every platform.
    for (const name of names.sort()) {
        const lower = name.toLowerCase();
        if (!index.has(lower)) index.set(lower, name);
    }
    return index;
}

async function buildContext(root: string): Promise<RootContext> {
    const entries = await readRootEntries(root);

    const present = MARKER_FILES.filter((file) => entries.has(file.toLowerCase()));
    const [pkg, texts] = await Promise.all([
        readPackageJson(root),
        Promise.all(
            present.map(async (file) => {
                const actual = entries.get(file.toLowerCase()) ?? file;
                return [file.toLowerCase(), await readTextFile(path.join(root, actual))] as const;
            }),
        ),
    ]);

    const markers = new Map<string, string>();
    for (const [key, text] of texts) {
        if (text !== null) markers.set(key, text);
    }
    return { root, entries, pkg, markers };
}

/** Actual on-disk name of a root entry, matched case-insensitively. */
function entryOf(ctx: RootContext, name: string): string | null {
    return ctx.entries.get(name.toLowerCase()) ?? null;
}

/** First root entry whose lowercase name matches, e.g. `.eslintrc*`. */
function entryMatching(ctx: RootContext, ...patterns: RegExp[]): string | null {
    for (const [lower, actual] of ctx.entries) {
        for (const pattern of patterns) {
            if (pattern.test(lower)) return actual;
        }
    }
    return null;
}

function markerText(ctx: RootContext, name: string): string | null {
    return ctx.markers.get(name.toLowerCase()) ?? null;
}

/** True when a marker manifest exists and matches — used for TOML sections. */
function markerHas(ctx: RootContext, name: string, pattern: RegExp): boolean {
    const text = markerText(ctx, name);
    return text !== null && pattern.test(text);
}

/** Evidence filename when a TOML section like `[tool.ruff]` is present. */
function tomlSection(ctx: RootContext, file: string, section: string): string | null {
    const pattern = new RegExp(`^\\s*\\[\\s*${section}\\s*[.\\]]`, "m");
    return markerHas(ctx, file, pattern) ? entryOf(ctx, file) : null;
}

function hasDep(pkg: PackageJson | null, name: string): boolean {
    if (pkg === null) return false;
    return Object.hasOwn(pkg.dependencies, name) || Object.hasOwn(pkg.devDependencies, name);
}

/** Python manifests are line-based enough that a word match is good enough. */
const PYTHON_MANIFESTS: readonly string[] = [
    "requirements.txt",
    "pyproject.toml",
    "Pipfile",
    "setup.py",
    "setup.cfg",
];

/** Evidence file naming a Python package, or null. Avoids a TOML parser. */
function pythonDep(ctx: RootContext, name: string): string | null {
    const pattern = new RegExp(`(^|[^a-z0-9_.-])${name}([^a-z0-9_-]|$)`, "im");
    for (const file of PYTHON_MANIFESTS) {
        const text = markerText(ctx, file);
        if (text !== null && pattern.test(text)) return entryOf(ctx, file);
    }
    return null;
}

/** Evidence Java build file matching a pattern (JUnit, Spring, ...). */
function javaBuildFile(ctx: RootContext, pattern: RegExp): string | null {
    for (const file of ["pom.xml", "build.gradle", "build.gradle.kts"]) {
        const text = markerText(ctx, file);
        if (text !== null && pattern.test(text)) return entryOf(ctx, file);
    }
    return null;
}

/** package.json evidence when the dep is declared, else a matching config file. */
function depOrConfig(ctx: RootContext, dep: string | null, ...patterns: RegExp[]): string | null {
    if (dep !== null && hasDep(ctx.pkg, dep)) return entryOf(ctx, "package.json") ?? "package.json";
    return patterns.length === 0 ? null : entryMatching(ctx, ...patterns);
}

/* -------------------------------------------------------------------------
 * Languages
 * ---------------------------------------------------------------------- */

/** Extension histogram over the discovery file list — never re-walks the tree. */
function countExtensions(files: string[], root: string): Map<string, number> {
    const counts = new Map<string, number>();
    const base = path.resolve(root);
    for (const file of files) {
        const absolute = path.resolve(base, file);
        // Defensive: discovery only ever hands us files under the root.
        if (absolute !== base && !absolute.startsWith(base + path.sep)) continue;
        const extension = path.extname(absolute).toLowerCase();
        if (extension === "") continue;
        counts.set(extension, (counts.get(extension) ?? 0) + 1);
    }
    return counts;
}

function buildLanguageStats(counts: ReadonlyMap<string, number>): LanguageStat[] {
    const byLanguage = new Map<string, number>();
    for (const [extension, count] of counts) {
        const name = LANGUAGE_BY_EXTENSION.get(extension);
        if (name === undefined) continue;
        byLanguage.set(name, (byLanguage.get(name) ?? 0) + count);
    }

    let total = 0;
    for (const count of byLanguage.values()) total += count;
    if (total === 0) return [];

    const stats: LanguageStat[] = [];
    for (const [name, fileCount] of byLanguage) {
        // Share of classified files only; unknown extensions never dilute it.
        stats.push({ name, fileCount, percentage: Math.round((fileCount / total) * 1000) / 10 });
    }
    // Name is the tie-breaker so repeated runs serialize identically.
    stats.sort((a, b) => b.fileCount - a.fileCount || a.name.localeCompare(b.name));
    return stats;
}

function pickPrimaryLanguage(languages: readonly LanguageStat[]): string | null {
    for (const language of languages) {
        if (!SUPPORTING_LANGUAGES.has(language.name)) return language.name;
    }
    return null;
}

/**
 * Classify the discovered files by extension.
 * `root` is used only to discard anything that somehow sits outside the project.
 */
export async function detectLanguages(files: string[], root: string): Promise<LanguageStat[]> {
    return buildLanguageStats(countExtensions(files, root));
}

/* -------------------------------------------------------------------------
 * Package manager
 * ---------------------------------------------------------------------- */

/** Package managers that can run npm scripts. */
const NODE_PACKAGE_MANAGERS: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn", "bun"]);

/** Lockfiles, most specific first — bun and pnpm before the generic ones. */
const NODE_LOCKFILES: ReadonlyArray<readonly [string, string]> = [
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
];

/** Non-JS manifests, checked after the JS ecosystem and after poetry. */
const OTHER_MANIFESTS: ReadonlyArray<readonly [string, string]> = [
    ["uv.lock", "uv"],
    ["Pipfile.lock", "pipenv"],
    ["requirements.txt", "pip"],
    ["Cargo.toml", "cargo"],
    ["go.mod", "go"],
    ["Gemfile", "bundler"],
    ["composer.json", "composer"],
];

export async function detectPackageManager(
    root: string,
    ctx?: RootContext,
): Promise<PackageManagerInfo | null> {
    const context = ctx ?? (await buildContext(root));

    // Corepack's `packageManager` field is an explicit declaration by the
    // project, so it outranks whatever lockfile happens to be lying around.
    const declared = context.pkg?.packageManager ?? null;
    if (declared !== null) {
        const name = (/^([a-zA-Z]+)/.exec(declared.trim())?.[1] ?? "").toLowerCase();
        if (NODE_PACKAGE_MANAGERS.has(name)) {
            return { name, evidence: entryOf(context, "package.json") ?? "package.json" };
        }
    }

    for (const [file, name] of NODE_LOCKFILES) {
        const evidence = entryOf(context, file);
        if (evidence !== null) return { name, evidence };
    }

    // A manifest with no lockfile still means npm by default.
    const manifest = entryOf(context, "package.json");
    if (manifest !== null) return { name: "npm", evidence: manifest };

    const poetryLock = entryOf(context, "poetry.lock");
    if (poetryLock !== null) return { name: "poetry", evidence: poetryLock };
    const poetrySection = tomlSection(context, "pyproject.toml", "tool\\.poetry");
    if (poetrySection !== null) return { name: "poetry", evidence: poetrySection };

    for (const [file, name] of OTHER_MANIFESTS) {
        const evidence = entryOf(context, file);
        if (evidence !== null) return { name, evidence };
    }
    return null;
}

/* -------------------------------------------------------------------------
 * Frameworks
 * ---------------------------------------------------------------------- */

/** npm package -> display name. Meta-frameworks come first so they win. */
const NODE_FRAMEWORKS: ReadonlyArray<readonly [string, string]> = [
    ["next", "Next.js"],
    ["nuxt", "Nuxt"],
    ["@sveltejs/kit", "SvelteKit"],
    ["@angular/core", "Angular"],
    ["astro", "Astro"],
    ["react-native", "React Native"],
    ["expo", "React Native"],
    ["electron", "Electron"],
    ["@nestjs/core", "NestJS"],
    ["react", "React"],
    ["vue", "Vue"],
    ["svelte", "Svelte"],
    ["solid-js", "Solid"],
    ["express", "Express"],
    ["fastify", "Fastify"],
    ["koa", "Koa"],
    ["hono", "Hono"],
    ["tailwindcss", "Tailwind CSS"],
    ["vite", "Vite"],
    ["webpack", "Webpack"],
];

/** Root marker file (lowercase pattern) -> display name. */
const MARKER_FRAMEWORKS: ReadonlyArray<readonly [RegExp, string]> = [
    [/^next\.config\./, "Next.js"],
    [/^nuxt\.config\./, "Nuxt"],
    [/^svelte\.config\./, "Svelte"],
    [/^angular\.json$/, "Angular"],
    [/^astro\.config\./, "Astro"],
    [/^nest-cli\.json$/, "NestJS"],
    [/^tailwind\.config\./, "Tailwind CSS"],
    [/^vite\.config\./, "Vite"],
    [/^webpack\.config\./, "Webpack"],
    [/^manage\.py$/, "Django"],
    [/^artisan$/, "Laravel"],
];

/** Frameworks that already explain the presence of JSX files. */
const JSX_FRAMEWORKS: ReadonlySet<string> = new Set([
    "React",
    "React Native",
    "Next.js",
    "Solid",
    "Vue",
    "Nuxt",
    "Svelte",
    "SvelteKit",
    "Astro",
    "Angular",
]);

export async function detectFrameworks(
    root: string,
    ctx?: RootContext,
    hasJsx = false,
): Promise<string[]> {
    const context = ctx ?? (await buildContext(root));
    const found: string[] = [];
    const add = (name: string): void => {
        if (!found.includes(name)) found.push(name);
    };

    for (const [dep, name] of NODE_FRAMEWORKS) {
        if (hasDep(context.pkg, dep)) add(name);
    }
    for (const [pattern, name] of MARKER_FRAMEWORKS) {
        if (entryMatching(context, pattern) !== null) add(name);
    }
    // `.tsx`/`.jsx` files with no declared dependency still point at React,
    // unless another JSX-flavoured framework already explains them.
    if (hasJsx && !found.some((name) => JSX_FRAMEWORKS.has(name))) add("React");

    if (pythonDep(context, "django") !== null) add("Django");
    if (pythonDep(context, "flask") !== null) add("Flask");
    if (pythonDep(context, "fastapi") !== null) add("FastAPI");
    if (markerHas(context, "Gemfile", /\brails\b/i)) add("Rails");
    if (markerHas(context, "composer.json", /laravel\/framework/i)) add("Laravel");
    if (javaBuildFile(context, /springframework|spring-boot/i) !== null) add("Spring");

    // SvelteKit always drags in Svelte; listing both is noise.
    return found.includes("SvelteKit") ? found.filter((name) => name !== "Svelte") : found;
}

/* -------------------------------------------------------------------------
 * Docs
 * ---------------------------------------------------------------------- */

/** Root README spellings, best first. Matched case-insensitively. */
const README_CANDIDATES: readonly string[] = [
    "README.md",
    "README.markdown",
    "README.rst",
    "README.txt",
    "README",
];

export async function detectDocs(
    root: string,
    ctx?: RootContext,
): Promise<{ readme: string | null; claudeMd: string | null }> {
    const context = ctx ?? (await buildContext(root));

    let readme: string | null = null;
    for (const candidate of README_CANDIDATES) {
        const actual = entryOf(context, candidate);
        if (actual !== null) {
            readme = actual;
            break;
        }
    }
    // Root entries are already relative paths, so the on-disk name is the answer.
    return { readme, claudeMd: entryOf(context, "CLAUDE.md") };
}

/* -------------------------------------------------------------------------
 * Commands
 * ---------------------------------------------------------------------- */

type CommandCategory = "build" | "test" | "lint" | "format" | "typecheck";

/** Script names that count as each category, checked in order. */
const SCRIPT_ALIASES: Readonly<Record<CommandCategory, readonly string[]>> = {
    build: ["build"],
    test: ["test"],
    lint: ["lint"],
    format: ["format", "fmt", "prettier"],
    typecheck: ["typecheck", "type-check", "tsc", "check-types"],
};

/** A tool proven by deps or config files, plus how to run it without a script. */
interface ToolMatch {
    tool: string;
    /** Command to use when no npm script covers the category; null when unknown. */
    fallback: string | null;
    evidence: string;
}

/** Recognisable binaries inside a script body, for display purposes. */
const SCRIPT_TOOLS: ReadonlyArray<readonly [RegExp, string]> = [
    [/\btsc\b/, "tsc"],
    [/\bnext\b/, "Next.js"],
    [/\bvite\b/, "Vite"],
    [/\btsup\b/, "tsup"],
    [/\bwebpack\b/, "Webpack"],
    [/\brollup\b/, "Rollup"],
    [/\besbuild\b/, "esbuild"],
    [/\bparcel\b/, "Parcel"],
    [/\bbabel\b/, "Babel"],
    [/\bjest\b/, "Jest"],
    [/\bvitest\b/, "Vitest"],
    [/\bmocha\b/, "Mocha"],
    [/\bplaywright\b/, "Playwright"],
    [/\bcypress\b/, "Cypress"],
    [/\beslint\b/, "ESLint"],
    [/\bbiome\b/, "Biome"],
    [/\bprettier\b/, "Prettier"],
    [/\bruff\b/, "Ruff"],
    [/\bblack\b/, "Black"],
    [/\bmypy\b/, "mypy"],
    [/\bpytest\b/, "pytest"],
    [/\bcargo\b/, "cargo"],
    [/\bgofmt\b/, "gofmt"],
    [/\bgo (build|test)\b/, "go"],
    [/\bgradle\b/, "Gradle"],
    [/\bmvn\b/, "Maven"],
    [/\bmake\b/, "make"],
];

/** Wrapper words that say nothing about which tool actually runs. */
const RUNNER_TOKENS: ReadonlySet<string> = new Set([
    "npx",
    "npm",
    "pnpm",
    "pnpx",
    "yarn",
    "bun",
    "bunx",
    "run",
    "exec",
    "cross-env",
    "dotenv",
    "node",
    "&&",
]);

/** Best-effort tool name for a script body like `"npx tsc"` -> `"tsc"`. */
function toolFromScript(body: string): string | null {
    for (const [pattern, tool] of SCRIPT_TOOLS) {
        if (pattern.test(body)) return tool;
    }
    for (const token of body.trim().split(/\s+/)) {
        if (token === "" || RUNNER_TOKENS.has(token)) continue;
        if (token.startsWith("-") || token.includes("=")) continue;
        return token;
    }
    return null;
}

function findScript(pkg: PackageJson | null, aliases: readonly string[]): string | null {
    if (pkg === null) return null;
    for (const alias of aliases) {
        if (Object.hasOwn(pkg.scripts, alias)) return alias;
    }
    return null;
}

/** `<pm> run <script>`, with npm's built-in `test` shortcut spelled naturally. */
function scriptCommand(packageManager: string, script: string): string {
    if (packageManager === "npm" && script === "test") return "npm test";
    return `${packageManager} run ${script}`;
}

function buildTool(ctx: RootContext): ToolMatch | null {
    const cargo = entryOf(ctx, "Cargo.toml");
    if (cargo !== null) return { tool: "cargo", fallback: "cargo build", evidence: cargo };
    const goMod = entryOf(ctx, "go.mod");
    if (goMod !== null) return { tool: "go", fallback: "go build ./...", evidence: goMod };
    const makefile = entryOf(ctx, "Makefile");
    if (makefile !== null) return { tool: "make", fallback: "make", evidence: makefile };
    return null;
}

function testTool(ctx: RootContext): ToolMatch | null {
    const jsRunners: ReadonlyArray<readonly [string, string, RegExp, string]> = [
        ["jest", "Jest", /^jest\.config\./, "npx jest"],
        ["vitest", "Vitest", /^vitest\.config\./, "npx vitest run"],
        ["mocha", "Mocha", /^\.mocharc\./, "npx mocha"],
        ["@playwright/test", "Playwright", /^playwright\.config\./, "npx playwright test"],
        ["cypress", "Cypress", /^cypress\.config\./, "npx cypress run"],
    ];
    for (const [dep, tool, config, fallback] of jsRunners) {
        const evidence = depOrConfig(ctx, dep, config);
        if (evidence !== null) return { tool, fallback, evidence };
    }

    const pytest =
        entryOf(ctx, "pytest.ini") ??
        tomlSection(ctx, "pyproject.toml", "tool\\.pytest") ??
        pythonDep(ctx, "pytest");
    if (pytest !== null) return { tool: "pytest", fallback: "pytest", evidence: pytest };

    const cargo = entryOf(ctx, "Cargo.toml");
    if (cargo !== null) return { tool: "cargo test", fallback: "cargo test", evidence: cargo };
    const goMod = entryOf(ctx, "go.mod");
    if (goMod !== null) return { tool: "go test", fallback: "go test ./...", evidence: goMod };

    const junit = javaBuildFile(ctx, /junit/i);
    // No fallback: the invocation depends on Maven vs Gradle wiring.
    if (junit !== null) return { tool: "JUnit", fallback: null, evidence: junit };
    return null;
}

function lintTool(ctx: RootContext): ToolMatch | null {
    const eslint = depOrConfig(ctx, "eslint", /^\.eslintrc/, /^eslint\.config\./);
    if (eslint !== null) return { tool: "ESLint", fallback: "npx eslint .", evidence: eslint };

    const biome = depOrConfig(ctx, "@biomejs/biome", /^biome\.jsonc?$/);
    if (biome !== null) return { tool: "Biome", fallback: "npx biome lint .", evidence: biome };

    const ruff =
        entryMatching(ctx, /^\.?ruff\.toml$/) ??
        tomlSection(ctx, "pyproject.toml", "tool\\.ruff") ??
        pythonDep(ctx, "ruff");
    if (ruff !== null) return { tool: "Ruff", fallback: "ruff check .", evidence: ruff };

    const flake8 = entryOf(ctx, ".flake8") ?? pythonDep(ctx, "flake8");
    if (flake8 !== null) return { tool: "Flake8", fallback: "flake8", evidence: flake8 };

    const pylint = entryOf(ctx, ".pylintrc") ?? pythonDep(ctx, "pylint");
    if (pylint !== null) return { tool: "Pylint", fallback: "pylint .", evidence: pylint };

    const golangci = entryMatching(ctx, /^\.golangci\./);
    if (golangci !== null) {
        return { tool: "golangci-lint", fallback: "golangci-lint run", evidence: golangci };
    }

    // Clippy ships with the Rust toolchain, so Cargo.toml alone proves it.
    const cargo = entryOf(ctx, "Cargo.toml");
    if (cargo !== null) return { tool: "Clippy", fallback: "cargo clippy", evidence: cargo };
    return null;
}

function formatTool(ctx: RootContext): ToolMatch | null {
    const prettier = depOrConfig(ctx, "prettier", /^\.prettierrc/, /^prettier\.config\./);
    if (prettier !== null) {
        return { tool: "Prettier", fallback: "npx prettier --write .", evidence: prettier };
    }

    const biome = depOrConfig(ctx, "@biomejs/biome", /^biome\.jsonc?$/);
    if (biome !== null) return { tool: "Biome", fallback: "npx biome format .", evidence: biome };

    const black = tomlSection(ctx, "pyproject.toml", "tool\\.black") ?? pythonDep(ctx, "black");
    if (black !== null) return { tool: "Black", fallback: "black .", evidence: black };

    const rustfmt = entryMatching(ctx, /^\.?rustfmt\.toml$/) ?? entryOf(ctx, "Cargo.toml");
    if (rustfmt !== null) return { tool: "rustfmt", fallback: "cargo fmt", evidence: rustfmt };

    // gofmt ships with the Go toolchain, so a module file is proof enough.
    const goMod = entryOf(ctx, "go.mod");
    if (goMod !== null) return { tool: "gofmt", fallback: "gofmt -w .", evidence: goMod };
    return null;
}

function typecheckTool(ctx: RootContext): ToolMatch | null {
    const tsconfig = entryOf(ctx, "tsconfig.json");
    if (tsconfig !== null) return { tool: "tsc", fallback: "npx tsc --noEmit", evidence: tsconfig };

    const mypy =
        entryMatching(ctx, /^\.?mypy\.ini$/) ??
        tomlSection(ctx, "pyproject.toml", "tool\\.mypy") ??
        pythonDep(ctx, "mypy");
    if (mypy !== null) return { tool: "mypy", fallback: "mypy .", evidence: mypy };

    const pyright = entryOf(ctx, "pyrightconfig.json") ?? pythonDep(ctx, "pyright");
    if (pyright !== null) return { tool: "Pyright", fallback: "pyright", evidence: pyright };
    return null;
}

/**
 * A matching npm script always wins — it is what the project's own authors run.
 * Otherwise fall back to the config-file evidence, and when there is neither,
 * report null rather than inventing a command Tyr cannot run.
 */
function resolveCommand(
    ctx: RootContext,
    runner: string,
    category: CommandCategory,
    match: ToolMatch | null,
): ProjectCommand | null {
    const script = findScript(ctx.pkg, SCRIPT_ALIASES[category]);
    if (script !== null) {
        const body = ctx.pkg?.scripts[script] ?? "";
        // For build the script body names the real tool; for the other
        // categories the dependency/config evidence is the better witness.
        const tool =
            category === "build"
                ? toolFromScript(body) ?? match?.tool ?? runner
                : match?.tool ?? toolFromScript(body) ?? runner;
        return {
            tool,
            command: scriptCommand(runner, script),
            evidence: entryOf(ctx, "package.json") ?? "package.json",
        };
    }
    if (match !== null && match.fallback !== null) {
        return { tool: match.tool, command: match.fallback, evidence: match.evidence };
    }
    return null;
}

type CommandSet = Pick<ProjectProfile, CommandCategory>;

function detectCommands(ctx: RootContext, packageManager: PackageManagerInfo | null): CommandSet {
    // Scripts are always run by a JS package manager; a poetry/cargo project
    // that still ships a package.json falls back to npm.
    const runner =
        packageManager !== null && NODE_PACKAGE_MANAGERS.has(packageManager.name)
            ? packageManager.name
            : "npm";
    return {
        build: resolveCommand(ctx, runner, "build", buildTool(ctx)),
        test: resolveCommand(ctx, runner, "test", testTool(ctx)),
        lint: resolveCommand(ctx, runner, "lint", lintTool(ctx)),
        format: resolveCommand(ctx, runner, "format", formatTool(ctx)),
        typecheck: resolveCommand(ctx, runner, "typecheck", typecheckTool(ctx)),
    };
}

/* -------------------------------------------------------------------------
 * Orchestration
 * ---------------------------------------------------------------------- */

/**
 * Assemble the full profile. `files` comes from discovery and is reused as-is,
 * so the only filesystem work here is one readdir of the root plus a handful of
 * small manifests, all shared between the detectors.
 */
export async function profileProject(root: string, files: string[]): Promise<ProjectProfile> {
    const ctx = await buildContext(root);

    const counts = countExtensions(files, root);
    const languages = buildLanguageStats(counts);
    const hasJsx = JSX_EXTENSIONS.some((extension) => (counts.get(extension) ?? 0) > 0);

    const [packageManager, frameworks, docs] = await Promise.all([
        detectPackageManager(root, ctx),
        detectFrameworks(root, ctx, hasJsx),
        detectDocs(root, ctx),
    ]);

    const commands = detectCommands(ctx, packageManager);
    return {
        languages,
        primaryLanguage: pickPrimaryLanguage(languages),
        frameworks,
        packageManager,
        build: commands.build,
        test: commands.test,
        lint: commands.lint,
        format: commands.format,
        typecheck: commands.typecheck,
        readme: docs.readme,
        claudeMd: docs.claudeMd,
    };
}
