// Monorepo awareness: does this project hold more than one package, and where
// do they live?
//
// Declared workspaces win, in this order: pnpm (`pnpm-workspace.yaml`), npm or
// yarn (`package.json` `workspaces`), then Cargo (`[workspace] members`). With
// no declaration, manifests sitting below the root still describe a set of
// nested packages, so those are reported as `nested`.
//
// Member globs are resolved against the discovery file list rather than a new
// walk: a directory is a member only when a glob matches it *and* it holds the
// manifest that tool expects. That list is already ignore-filtered, so
// `node_modules` and friends can never turn up as packages.
//
// Like project.ts, this module is total and silent: malformed manifests are
// normal input, failures degrade to null, and nothing is printed.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { WorkspaceInfo, WorkspacePackage, WorkspaceTool } from "./types.js";

/* -------------------------------------------------------------------------
 * Manifest index — which directories hold which manifests
 * ---------------------------------------------------------------------- */

/** Package manifests we recognise, in the order a directory's "main" one is chosen. */
const PACKAGE_MANIFESTS: readonly string[] = ["package.json", "Cargo.toml", "pyproject.toml", "go.mod"];

/**
 * Directory segments that hold test data rather than real packages. Only the
 * undeclared `nested` scan skips them; an explicit workspace glob is trusted.
 */
const FIXTURE_SEGMENTS: ReadonlySet<string> = new Set(["fixtures", "__fixtures__", "testdata"]);

/** Root-relative POSIX directory ("." for the root) -> manifest names it contains. */
type ManifestIndex = ReadonlyMap<string, ReadonlySet<string>>;

function buildManifestIndex(root: string, files: readonly string[]): ManifestIndex {
    const base = path.resolve(root);
    const index = new Map<string, Set<string>>();
    for (const file of files) {
        const absolute = path.resolve(base, file);
        // Defensive: discovery only ever hands us files under the root.
        if (!absolute.startsWith(base + path.sep)) continue;
        const name = path.basename(absolute);
        if (!PACKAGE_MANIFESTS.includes(name)) continue;

        const relative = path.relative(base, path.dirname(absolute)).split(path.sep).join("/");
        const dir = relative === "" ? "." : relative;
        let names = index.get(dir);
        if (names === undefined) {
            names = new Set();
            index.set(dir, names);
        }
        names.add(name);
    }
    return index;
}

function manifestPath(dir: string, manifest: string): string {
    return dir === "." ? manifest : `${dir}/${manifest}`;
}

/* -------------------------------------------------------------------------
 * Member globs
 * ---------------------------------------------------------------------- */

/** One glob segment -> regex source. `*` and `?` never cross a `/`. */
function segmentSource(segment: string): string {
    let out = "";
    for (const char of segment) {
        if (char === "*") out += "[^/]*";
        else if (char === "?") out += "[^/]";
        else out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return out;
}

/**
 * Compile a workspace member pattern to a regex over `dir + "/"`. Returns null
 * for patterns that could escape the root (absolute or `..`), which no tool
 * we read would resolve inside this project anyway.
 */
function compileMember(pattern: string): RegExp | null {
    const trimmed = pattern.trim().replace(/^(\.\/)+/, "").replace(/\/+$/, "");
    if (trimmed === "" || trimmed.startsWith("/")) return null;

    const segments = trimmed.split("/").filter((segment) => segment !== "");
    if (segments.includes("..")) return null;

    // Every piece carries its own trailing slash, so `**` can match zero
    // segments without leaving a doubled or dangling separator behind.
    let source = "";
    for (const segment of segments) {
        source += segment === "**" ? "(?:[^/]+/)*" : `${segmentSource(segment)}/`;
    }
    return new RegExp(`^${source}$`);
}

/**
 * Apply member patterns in order — includes add, `!` negations remove — over
 * the directories that hold `manifest`. The root only matches a literal `.`,
 * so `*` never sweeps the workspace root in as one of its own members.
 */
function resolveMembers(patterns: readonly string[], index: ManifestIndex, manifest: string): string[] {
    const candidates: string[] = [];
    for (const [dir, names] of index) {
        if (names.has(manifest)) candidates.push(dir);
    }

    const members = new Set<string>();
    for (const raw of patterns) {
        const negated = raw.trim().startsWith("!");
        const pattern = negated ? raw.trim().slice(1) : raw;
        const regex = compileMember(pattern);
        if (regex === null) continue;
        for (const dir of candidates) {
            if (dir === "." ? pattern.trim() !== "." : !regex.test(`${dir}/`)) continue;
            if (negated) members.delete(dir);
            else members.add(dir);
        }
    }
    return [...members].sort();
}

/* -------------------------------------------------------------------------
 * Small manifest readers — no YAML or TOML parser, on purpose
 * ---------------------------------------------------------------------- */

async function readTextFile(file: string): Promise<string | null> {
    try {
        return await fs.readFile(file, "utf8");
    } catch {
        // Missing, unreadable or a directory — all "not found" as far as we care.
        return null;
    }
}

function parseJsonObject(text: string | null): Record<string, unknown> | null {
    if (text === null) return null;
    try {
        const parsed: unknown = JSON.parse(text);
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

function stringArray(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    return value.filter((item): item is string => typeof item === "string");
}

/** Drop a `#` comment that sits outside quotes. Shared by the TOML and YAML readers. */
function stripComment(line: string): string {
    let quote: string | null = null;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (quote !== null) {
            if (char === "\\" && quote === '"') i++;
            else if (char === quote) quote = null;
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (char === "#") {
            return line.slice(0, i);
        }
    }
    return line;
}

/** Every quoted string in a fragment, in order. */
function quotedStrings(fragment: string): string[] {
    const out: string[] = [];
    for (const match of fragment.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)) {
        out.push(match[1] ?? match[2] ?? "");
    }
    return out;
}

/** Comment-free body of one TOML table (`[workspace]`), or null when absent. */
function tomlTable(text: string, table: string): string | null {
    let body: string[] | null = null;
    for (const raw of text.split(/\r?\n/)) {
        const line = stripComment(raw);
        const header = /^\s*\[\s*([^\]]+?)\s*\]/.exec(line);
        if (header !== null && !line.trimStart().startsWith("[[")) {
            if (body !== null) break;
            if (header[1] === table) body = [];
            continue;
        }
        // An array-of-tables header (`[[bin]]`) also ends the table.
        if (line.trimStart().startsWith("[[") && body !== null) break;
        if (body !== null) body.push(line);
    }
    return body === null ? null : body.join("\n");
}

/** `key = [ ... ]` inside a table, multi-line arrays included. */
function tomlStringArray(text: string, table: string, key: string): string[] | null {
    const body = tomlTable(text, table);
    if (body === null) return null;
    const match = new RegExp(`^\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`, "m").exec(body);
    return match === null ? null : quotedStrings(match[1] ?? "");
}

/** `key = "value"` inside a table. */
function tomlString(text: string, table: string, key: string): string | null {
    const body = tomlTable(text, table);
    if (body === null) return null;
    const match = new RegExp(`^\\s*${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|'[^']*')`, "m").exec(body);
    return match === null ? null : (quotedStrings(match[1] ?? "")[0] ?? null);
}

/** A YAML scalar as written in a list item: quotes and trailing comment removed. */
function yamlScalar(raw: string): string {
    const value = stripComment(raw).trim();
    return quotedStrings(value)[0] ?? value;
}

/**
 * The `packages:` list from `pnpm-workspace.yaml`, in block (`- "a"`) or flow
 * (`["a", "b"]`) form. Null when the key is missing or not a list.
 */
function parsePnpmPackages(text: string): string[] | null {
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex((line) => /^packages\s*:/.test(line));
    if (start === -1) return null;

    const inline = stripComment((lines[start] ?? "").replace(/^packages\s*:/, "")).trim();
    if (inline.startsWith("[")) {
        const close = inline.indexOf("]");
        if (close === -1) return null;
        return inline
            .slice(1, close)
            .split(",")
            .map(yamlScalar)
            .filter((item) => item !== "");
    }
    if (inline !== "") return null;

    const items: string[] = [];
    for (const line of lines.slice(start + 1)) {
        if (stripComment(line).trim() === "") continue;
        // Back at column zero means the next top-level key has started.
        if (!/^\s/.test(line) && !line.startsWith("-")) break;
        const item = /^\s*-\s*(.*)$/.exec(line);
        if (item === null) break;
        const value = yamlScalar(item[1] ?? "");
        if (value !== "") items.push(value);
    }
    return items;
}

/** Best-effort package name from whichever manifest defines it. */
function packageName(manifest: string, text: string | null): string | null {
    if (text === null) return null;
    switch (manifest) {
        case "package.json": {
            const name = parseJsonObject(text)?.["name"];
            return typeof name === "string" && name !== "" ? name : null;
        }
        case "Cargo.toml":
            return tomlString(text, "package", "name");
        case "pyproject.toml":
            return tomlString(text, "project", "name") ?? tomlString(text, "tool.poetry", "name");
        case "go.mod":
            return /^\s*module\s+(\S+)/m.exec(text)?.[1] ?? null;
        default:
            return null;
    }
}

/* -------------------------------------------------------------------------
 * Detection
 * ---------------------------------------------------------------------- */

/** Read each member's manifest for its name; sorted by path. */
async function describePackages(
    root: string,
    members: ReadonlyArray<readonly [string, string]>,
): Promise<WorkspacePackage[]> {
    const packages = await Promise.all(
        members.map(async ([dir, manifest]) => {
            const relative = manifestPath(dir, manifest);
            const text = await readTextFile(path.join(root, ...relative.split("/")));
            return { name: packageName(manifest, text), path: dir, manifest: relative };
        }),
    );
    return packages.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function declared(
    root: string,
    tool: WorkspaceTool,
    evidence: string,
    members: readonly string[],
    manifest: string,
): Promise<WorkspaceInfo | null> {
    // A declaration that matches nothing is not a monorepo worth reporting.
    if (members.length === 0) return null;
    const packages = await describePackages(
        root,
        members.map((dir) => [dir, manifest] as const),
    );
    return { tool, evidence, packages };
}

async function detectPnpm(root: string, index: ManifestIndex): Promise<WorkspaceInfo | null> {
    const text = await readTextFile(path.join(root, "pnpm-workspace.yaml"));
    if (text === null) return null;
    const patterns = parsePnpmPackages(text);
    if (patterns === null) return null;
    return declared(root, "pnpm", "pnpm-workspace.yaml", resolveMembers(patterns, index, "package.json"), "package.json");
}

async function detectNodeWorkspaces(
    root: string,
    index: ManifestIndex,
    hasYarnLock: boolean,
): Promise<WorkspaceInfo | null> {
    const pkg = parseJsonObject(await readTextFile(path.join(root, "package.json")));
    if (pkg === null) return null;

    // npm takes a plain array; yarn classic also accepts `{ packages: [...] }`.
    const raw = pkg["workspaces"];
    const patterns =
        stringArray(raw) ??
        (typeof raw === "object" && raw !== null ? stringArray((raw as Record<string, unknown>)["packages"]) : null);
    if (patterns === null) return null;

    const declaredManager = pkg["packageManager"];
    const yarn =
        hasYarnLock || (typeof declaredManager === "string" && declaredManager.trim().startsWith("yarn"));
    return declared(
        root,
        yarn ? "yarn" : "npm",
        "package.json",
        resolveMembers(patterns, index, "package.json"),
        "package.json",
    );
}

async function detectCargo(root: string, index: ManifestIndex): Promise<WorkspaceInfo | null> {
    const text = await readTextFile(path.join(root, "Cargo.toml"));
    if (text === null) return null;
    const members = tomlStringArray(text, "workspace", "members");
    if (members === null) return null;

    // `exclude` behaves like trailing negations; a root `[package]` is itself
    // a member of the workspace it declares.
    const exclude = tomlStringArray(text, "workspace", "exclude") ?? [];
    const patterns = [...members, ...exclude.map((pattern) => `!${pattern}`)];
    if (tomlTable(text, "package") !== null) patterns.unshift(".");
    return declared(root, "cargo", "Cargo.toml", resolveMembers(patterns, index, "Cargo.toml"), "Cargo.toml");
}

async function detectNested(root: string, index: ManifestIndex): Promise<WorkspaceInfo | null> {
    const members: Array<readonly [string, string]> = [];
    for (const [dir, names] of index) {
        if (dir === ".") continue;
        if (dir.split("/").some((segment) => FIXTURE_SEGMENTS.has(segment))) continue;
        const manifest = PACKAGE_MANIFESTS.find((name) => names.has(name));
        if (manifest !== undefined) members.push([dir, manifest]);
    }
    if (members.length === 0) return null;
    return { tool: "nested", evidence: "nested manifests", packages: await describePackages(root, members) };
}

/**
 * Describe the project's multi-package layout, or null for a single package.
 * `files` is the discovery list (absolute or root-relative); it is the only
 * source of truth for which directories exist, so nothing here walks the tree.
 */
export async function detectWorkspaces(root: string, files: string[]): Promise<WorkspaceInfo | null> {
    try {
        const base = path.resolve(root);
        const index = buildManifestIndex(base, files);
        const hasYarnLock = files.some((file) => path.resolve(base, file) === path.join(base, "yarn.lock"));

        return (
            (await detectPnpm(base, index)) ??
            (await detectNodeWorkspaces(base, index, hasYarnLock)) ??
            (await detectCargo(base, index)) ??
            (await detectNested(base, index))
        );
    } catch {
        // Every reader above is already defensive; this is the last backstop
        // so a surprise in one manifest can never sink `tyr init`.
        return null;
    }
}
