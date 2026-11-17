// Diff review (PLANNING.md 2.11): cheap heuristic rules over the working-tree
// diff. Leaked secrets, deleted or skipped tests, risky patterns and changes
// too large to review properly.
//
// Pure: reviewDiff() reads `ctx.diff` (stats + patch text) and nothing else.
// It never throws; a rule that fails is skipped and the rest still run.
//
// How the rules work:
// - The unified patch is parsed into files and hunks, with new-file line
//   numbers for added lines, so line rules report file + line.
// - Line rules only look at ADDED lines. Removed lines are used only to
//   count deleted test cases.
// - Binary files and the file a truncated patch was cut inside are skipped
//   by the patch rules. The size rules still see them through the stats.
// - An added line containing `tyr-ignore` suppresses every finding on that
//   line; `tyr-ignore: diff/todo, eval` suppresses only the rules it names.
// - Secrets are never copied into a finding. Titles show the first four
//   characters and "…", and line excerpts in other findings are redacted.
//
// Adding a rule: write a DiffRule (or use lineRule() for a regex over added
// lines) and append it to DIFF_RULES. Rule ids are stable and start "diff/".

import type { DiffFileStat, DiffResult, DiffStatus } from "../core/git-diff.js";
import type { FindingSeverity } from "../core/reports.js";
import {
    MAX_FINDINGS_PER_DETECTOR,
    compareFindings,
    dedupeFindings,
    makeFinding,
    type EngineFinding,
    type ReviewContext,
} from "./findings.js";

/* -------------------------------------------------------------------------
 * Options
 * ---------------------------------------------------------------------- */

export interface DiffReviewThresholds {
    /** Total added + removed lines above which the change counts as large. */
    maxChangedLines: number;
    /** Number of changed files above which the change counts as large. */
    maxFiles: number;
    /** Added + removed lines in one file above which that file is flagged. */
    maxFileChangedLines: number;
}

export const DEFAULT_DIFF_REVIEW_THRESHOLDS: Readonly<DiffReviewThresholds> = {
    maxChangedLines: 800,
    maxFiles: 40,
    maxFileChangedLines: 500,
};

export interface DiffReviewOptions {
    thresholds?: Partial<DiffReviewThresholds>;
    /**
     * Rule ids to skip. "diff/todo" and "todo" both work; a trailing "*"
     * matches a prefix ("diff/secret-*").
     */
    disabledRules?: readonly string[];
}

/* -------------------------------------------------------------------------
 * Parsed patch
 * ---------------------------------------------------------------------- */

export interface PatchLine {
    kind: "add" | "remove" | "context";
    text: string;
    /** Line number in the new file (add/context) or the old file (remove). */
    line: number;
}

export interface PatchHunk {
    oldStart: number;
    newStart: number;
    lines: PatchLine[];
}

export interface PatchFile {
    /** Path after the change (for a deletion, the deleted path). */
    path: string;
    oldPath?: string;
    status: "added" | "deleted" | "modified" | "renamed" | "copied";
    binary: boolean;
    /** The patch was cut inside this file; its hunks are incomplete. */
    truncated: boolean;
    hunks: PatchHunk[];
}

/**
 * Parse `git diff` output into files and hunks. Tolerant: anything it does
 * not recognize is ignored. When `truncated`, the last file is marked so.
 */
export function parsePatch(patch: string, truncated = false): PatchFile[] {
    const files: PatchFile[] = [];
    let file: PatchFile | null = null;
    let hunk: PatchHunk | null = null;
    let oldLeft = 0;
    let newLeft = 0;
    let oldLine = 0;
    let newLine = 0;

    const lines = patch.split("\n");
    // A trailing newline leaves one empty element that is not a line.
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

    for (const raw of lines) {
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;

        if (hunk !== null && (oldLeft > 0 || newLeft > 0)) {
            const tag = line.charAt(0);
            if (tag === "+") {
                hunk.lines.push({ kind: "add", text: line.slice(1), line: newLine });
                newLine += 1;
                newLeft -= 1;
                continue;
            }
            if (tag === "-") {
                hunk.lines.push({ kind: "remove", text: line.slice(1), line: oldLine });
                oldLine += 1;
                oldLeft -= 1;
                continue;
            }
            if (tag === " " || line === "") {
                hunk.lines.push({ kind: "context", text: line.slice(1), line: newLine });
                oldLine += 1;
                newLine += 1;
                oldLeft -= 1;
                newLeft -= 1;
                continue;
            }
            if (tag === "\\") continue; // "\ No newline at end of file"
            // Anything else ends the hunk early (malformed input); fall through.
            hunk = null;
        } else if (line.startsWith("\\")) {
            continue;
        }

        if (line.startsWith("diff --git ")) {
            file = { path: pathFromGitHeader(line.slice("diff --git ".length)), status: "modified", binary: false, truncated: false, hunks: [] };
            files.push(file);
            hunk = null;
            oldLeft = newLeft = 0;
            continue;
        }
        if (line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) {
            // Combined diff of an unmerged path: not reviewed.
            file = null;
            hunk = null;
            continue;
        }
        if (file === null) continue;

        const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (header !== null) {
            oldLine = Number(header[1]);
            newLine = Number(header[3]);
            oldLeft = header[2] === undefined ? 1 : Number(header[2]);
            newLeft = header[4] === undefined ? 1 : Number(header[4]);
            // An empty side ("-0,0") starts counting at line 1 on the other.
            if (oldLine === 0) oldLine = 1;
            if (newLine === 0) newLine = 1;
            hunk = { oldStart: Number(header[1]), newStart: Number(header[3]), lines: [] };
            file.hunks.push(hunk);
            continue;
        }
        if (file.hunks.length > 0) continue;

        if (line.startsWith("new file mode")) file.status = "added";
        else if (line.startsWith("deleted file mode")) file.status = "deleted";
        else if (line.startsWith("rename from ")) {
            file.status = "renamed";
            file.oldPath = unquotePath(line.slice("rename from ".length));
        } else if (line.startsWith("rename to ")) file.path = unquotePath(line.slice("rename to ".length));
        else if (line.startsWith("copy from ")) {
            file.status = "copied";
            file.oldPath = unquotePath(line.slice("copy from ".length));
        } else if (line.startsWith("copy to ")) file.path = unquotePath(line.slice("copy to ".length));
        else if (line.startsWith("Binary files ") || line === "GIT binary patch") file.binary = true;
        else if (line.startsWith("+++ ")) {
            const target = stripPrefix(unquotePath(line.slice(4).replace(/\t$/, "")), "b/");
            if (target !== null) file.path = target;
        } else if (line.startsWith("--- ")) {
            const source = stripPrefix(unquotePath(line.slice(4).replace(/\t$/, "")), "a/");
            if (source !== null && file.status === "deleted") file.path = source;
        }
    }

    if (truncated && files.length > 0) files[files.length - 1].truncated = true;
    return files;
}

function stripPrefix(value: string, prefix: string): string | null {
    if (value === "/dev/null") return null;
    return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

/** `a/<p> b/<p>` (same path both sides); for renames, later headers win. */
function pathFromGitHeader(rest: string): string {
    if (rest.startsWith('"')) {
        const match = /^"((?:[^"\\]|\\.)*)" /.exec(rest);
        const after = match === null ? "" : rest.slice(match[0].length);
        return stripPrefix(unquotePath(after), "b/") ?? "";
    }
    if ((rest.length - 5) % 2 === 0 && rest.startsWith("a/")) {
        const half = (rest.length - 5) / 2;
        const a = rest.slice(2, 2 + half);
        if (rest.slice(2 + half) === ` b/${a}`) return a;
    }
    const at = rest.lastIndexOf(" b/");
    return at === -1 ? rest : unquotePath(rest.slice(at + 3));
}

/** Undo git's C-style quoting of unusual paths. */
function unquotePath(value: string): string {
    if (!(value.length >= 2 && value.startsWith('"') && value.endsWith('"'))) return value;
    const body = value.slice(1, -1);
    const bytes: number[] = [];
    const simple: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, "\\": 92, '"': 34 };
    for (let i = 0; i < body.length; i += 1) {
        const ch = body[i];
        if (ch !== "\\") {
            bytes.push(...Buffer.from(ch, "utf8"));
            continue;
        }
        const next = body[i + 1] ?? "";
        const octal = /^[0-7]{3}/.exec(body.slice(i + 1));
        if (octal !== null) {
            bytes.push(parseInt(octal[0], 8));
            i += 3;
        } else if (next in simple) {
            bytes.push(simple[next]);
            i += 1;
        } else {
            bytes.push(92);
        }
    }
    return Buffer.from(bytes).toString("utf8");
}

/* -------------------------------------------------------------------------
 * Rule registry
 * ---------------------------------------------------------------------- */

/** A finding as a rule reports it; source, rule and fingerprint are added. */
export interface RuleHit {
    severity: FindingSeverity;
    title: string;
    detail?: string;
    file?: string;
    line?: number;
}

export interface RuleInput {
    diff: DiffResult;
    /** Patch files that rules may read: not binary, not truncated. */
    files: readonly PatchFile[];
    /** Every changed file from the stats (including binary and truncated ones). */
    stats: readonly DiffFileStat[];
    thresholds: Readonly<DiffReviewThresholds>;
}

export interface DiffRule {
    /** Stable id, "diff/<name>". */
    id: string;
    /** One line for docs and `tyr` help output. */
    summary: string;
    check(input: RuleInput): RuleHit[];
}

/** Context for a line rule: one added line of one file. */
interface AddedLine {
    file: PatchFile;
    text: string;
    line: number;
}

/**
 * A rule over added lines. `match` returns null for no finding, or the
 * finding fields (file and line are filled in).
 */
function lineRule(
    id: string,
    summary: string,
    options: {
        appliesTo?: (path: string) => boolean;
        match: (added: AddedLine) => Omit<RuleHit, "file" | "line"> | null;
    },
): DiffRule {
    return {
        id,
        summary,
        check(input) {
            const hits: RuleHit[] = [];
            for (const file of input.files) {
                if (file.status === "deleted") continue;
                if (options.appliesTo !== undefined && !options.appliesTo(file.path)) continue;
                for (const hunk of file.hunks) {
                    for (const entry of hunk.lines) {
                        if (entry.kind !== "add") continue;
                        const hit = options.match({ file, text: entry.text, line: entry.line });
                        if (hit !== null) hits.push({ ...hit, file: file.path, line: entry.line });
                    }
                }
            }
            return hits;
        },
    };
}

/** A line rule driven by one regex; the excerpt goes into the detail, redacted. */
function patternRule(
    id: string,
    summary: string,
    severity: FindingSeverity,
    pattern: RegExp,
    title: string,
    appliesTo?: (path: string) => boolean,
    detail?: string,
): DiffRule {
    return lineRule(id, summary, {
        appliesTo,
        match: ({ text }) =>
            pattern.test(text) ? { severity, title, detail: withExcerpt(detail, text) } : null,
    });
}

function withExcerpt(detail: string | undefined, text: string): string {
    const excerpt = excerptOf(text);
    return detail === undefined ? excerpt : `${detail}\n${excerpt}`;
}

/** The line, trimmed, redacted and capped, for a finding's detail. */
function excerptOf(text: string): string {
    const clean = redactSecrets(text.trim());
    return clean.length > 160 ? `${clean.slice(0, 159)}…` : clean;
}

/* -------------------------------------------------------------------------
 * Paths
 * ---------------------------------------------------------------------- */

function baseName(path: string): string {
    const slash = path.lastIndexOf("/");
    return slash === -1 ? path : path.slice(slash + 1);
}

function dirName(path: string): string {
    const slash = path.lastIndexOf("/");
    return slash === -1 ? "" : path.slice(0, slash);
}

function extension(path: string): string {
    const name = baseName(path);
    const dot = name.lastIndexOf(".");
    return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** Test files: *.test.*, *.spec.*, test_*.py, *_test.go/py, tests/, __tests__/. */
export function isTestPath(path: string): boolean {
    const name = baseName(path);
    return (
        /(^|\/)(tests?|__tests__|spec|specs|e2e)\//.test(path) ||
        /\.(test|spec|e2e)\.[^.]+$/.test(name) ||
        /^test_.+\.py$/.test(name) ||
        /_test\.(go|py)$/.test(name) ||
        /(Test|Tests|Spec)\.(java|kt|cs|swift)$/.test(name)
    );
}

const JS_EXTENSIONS = new Set(["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts", "vue", "svelte"]);
const TS_EXTENSIONS = new Set(["ts", "tsx", "mts", "cts"]);
const DOC_EXTENSIONS = new Set(["md", "markdown", "mdx", "rst", "txt", "adoc"]);

const isJsPath = (path: string): boolean => JS_EXTENSIONS.has(extension(path));
const isTsPath = (path: string): boolean => TS_EXTENSIONS.has(extension(path)) && !path.endsWith(".d.ts");
const isDocPath = (path: string): boolean => DOC_EXTENSIONS.has(extension(path));
const isLockPath = (path: string): boolean => LOCKFILE_MANIFESTS[baseName(path)] !== undefined;
/** Code and config, not prose or lockfiles. */
const isSourceLike = (path: string): boolean => !isDocPath(path) && !isLockPath(path);
const isNonTestJs = (path: string): boolean => isJsPath(path) && !isTestPath(path);

/** Lockfile name -> the manifest(s) it is generated from. */
const LOCKFILE_MANIFESTS: Record<string, readonly string[]> = {
    "package-lock.json": ["package.json"],
    "npm-shrinkwrap.json": ["package.json"],
    "yarn.lock": ["package.json"],
    "pnpm-lock.yaml": ["package.json", "pnpm-workspace.yaml"],
    "bun.lockb": ["package.json"],
    "bun.lock": ["package.json"],
    "Cargo.lock": ["Cargo.toml"],
    "poetry.lock": ["pyproject.toml"],
    "uv.lock": ["pyproject.toml"],
    "Pipfile.lock": ["Pipfile"],
    "Gemfile.lock": ["Gemfile", "gems.rb"],
    "composer.lock": ["composer.json"],
    "go.sum": ["go.mod"],
    "mix.lock": ["mix.exs"],
    "Podfile.lock": ["Podfile"],
    "packages.lock.json": [".csproj"],
};

const MANIFEST_NAMES = new Set([
    "package.json",
    "pnpm-workspace.yaml",
    "Cargo.toml",
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "requirements.txt",
    "Pipfile",
    "Gemfile",
    "gems.rb",
    "composer.json",
    "go.mod",
    "mix.exs",
    "Podfile",
    "build.gradle",
    "build.gradle.kts",
    "pom.xml",
]);

function isManifestPath(path: string): boolean {
    const name = baseName(path);
    return MANIFEST_NAMES.has(name) || /^requirements[-_.].*\.txt$/.test(name) || name.endsWith(".csproj");
}

function isCiPath(path: string): boolean {
    return (
        /^\.github\/(workflows|actions)\//.test(path) ||
        /^\.circleci\//.test(path) ||
        /^\.buildkite\//.test(path) ||
        /^\.gitlab-ci\.ya?ml$/.test(path) ||
        /^\.gitlab\/ci\//.test(path) ||
        /^\.travis\.ya?ml$/.test(path) ||
        /^azure-pipelines\.ya?ml$/.test(path) ||
        /^bitbucket-pipelines\.ya?ml$/.test(path) ||
        /^\.drone\.ya?ml$/.test(path) ||
        baseName(path) === "Jenkinsfile"
    );
}

/** .env, .env.local, .env.production...; not .env.example and friends. */
function isEnvFile(path: string): boolean {
    const name = baseName(path);
    return /^\.env(\..+)?$/.test(name) && !/\.(example|sample|template|dist|defaults?)$/i.test(name);
}

/* -------------------------------------------------------------------------
 * Secrets
 * ---------------------------------------------------------------------- */

/** First four characters then "…": enough to find the key, useless to an attacker. */
export function maskSecret(secret: string): string {
    return `${secret.slice(0, 4)}…`;
}

interface SecretPattern {
    id: string;
    label: string;
    pattern: RegExp;
    /** Index of the capture group holding the secret (default 0). */
    group?: number;
    accept?: (match: RegExpExecArray) => boolean;
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
    { id: "diff/secret-aws-key", label: "AWS access key ID", pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
    {
        id: "diff/secret-private-key",
        label: "private key block",
        pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g,
    },
    {
        id: "diff/secret-github-token",
        label: "GitHub token",
        pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g,
    },
    {
        id: "diff/secret-slack-token",
        label: "Slack token",
        pattern: /\b(?:xox[abposr]-[A-Za-z0-9-]{10,}|https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,})/g,
    },
    { id: "diff/secret-anthropic-key", label: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
    {
        id: "diff/secret-openai-key",
        label: "OpenAI-style API key",
        pattern: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g,
        // Require letters and digits, so "sk-some-long-css-class-name" passes.
        accept: (m) => /[0-9]/.test(m[0]) && /[A-Za-z]{2}/.test(m[0].slice(3)),
    },
    {
        id: "diff/secret-jwt",
        label: "JSON Web Token",
        pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    },
    {
        id: "diff/secret-assignment",
        label: "hard-coded credential",
        pattern:
            /\b[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|private[_-]?key)[A-Za-z0-9_.-]*["']?\s*(?::=|=>|[:=])\s*[rbuf]?["'`]([^"'`\s]{12,})["'`]/gi,
        group: 1,
        accept: (m) => looksLikeSecretValue(m[1] ?? ""),
    },
];

/** Literal values that are placeholders or identifiers rather than credentials. */
function looksLikeSecretValue(value: string): boolean {
    if (/\$\{|\{\{|%\(|<[^>]*>|^\$[A-Z_]/.test(value)) return false;
    if (/(?:example|changeme|placeholder|your[_-]|dummy|redacted|xxxx|\*\*\*)/i.test(value)) return false;
    if (/^(.)\1+$/.test(value)) return false;
    // Mixed character classes: identifiers like "password_confirmation" don't count.
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(value)).length;
    return classes >= 2;
}

interface SecretHit {
    id: string;
    label: string;
    secret: string;
}

function findSecrets(text: string): SecretHit[] {
    const hits: SecretHit[] = [];
    for (const spec of SECRET_PATTERNS) {
        spec.pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = spec.pattern.exec(text)) !== null) {
            if (match[0].length === 0) spec.pattern.lastIndex += 1;
            if (spec.accept !== undefined && !spec.accept(match)) continue;
            hits.push({ id: spec.id, label: spec.label, secret: match[spec.group ?? 0] ?? match[0] });
        }
    }
    return hits;
}

/** Replace anything secret-shaped in `text` with its mask. */
export function redactSecrets(text: string): string {
    let out = text;
    for (const hit of findSecrets(text)) {
        if (hit.id === "diff/secret-private-key") continue; // the marker itself is not secret
        out = out.split(hit.secret).join(maskSecret(hit.secret));
    }
    return out;
}

function secretRule(spec: SecretPattern): DiffRule {
    return lineRule(spec.id, `Added line contains a ${spec.label}`, {
        match: ({ text }) => {
            const hit = findSecrets(text).find((h) => h.id === spec.id);
            if (hit === undefined) return null;
            if (spec.id === "diff/secret-private-key") {
                return {
                    severity: "critical",
                    title: "Private key block added",
                    detail: "A private key is being committed. Remove it and rotate the key.",
                };
            }
            return {
                severity: "critical",
                title: `Possible ${spec.label} added (${maskSecret(hit.secret)})`,
                detail: `Secrets in the repository leak with every clone. Move it to the environment or a secret store, and rotate it if it was ever pushed.`,
            };
        },
    });
}

const envFileRule: DiffRule = {
    id: "diff/secret-env-file",
    summary: "A .env file is being added",
    check(input) {
        const hits: RuleHit[] = [];
        const added = new Set<DiffStatus>(["A", "C", "R"]);
        for (const stat of input.stats) {
            if (added.has(stat.status) && isEnvFile(stat.path)) {
                hits.push({
                    severity: "critical",
                    title: `Environment file ${stat.path} added`,
                    detail: ".env files usually hold credentials. Add it to .gitignore and commit a .env.example instead.",
                    file: stat.path,
                });
            }
        }
        for (const path of input.diff.untracked ?? []) {
            if (isEnvFile(path)) {
                hits.push({
                    severity: "critical",
                    title: `Environment file ${path} is untracked and not ignored`,
                    detail: "It will be picked up by the next `git add .`. Add it to .gitignore.",
                    file: path,
                });
            }
        }
        return hits;
    },
};

/* -------------------------------------------------------------------------
 * Tests
 * ---------------------------------------------------------------------- */

const TEST_CASE = /^\s*(?:(?:it|test|specify)(?:\.(?:each|concurrent|only|skip|todo)\S*)?\s*\(|(?:async\s+)?def\s+test_\w*|#\[(?:[\w:]+::)?test\]|func\s+Test\w*\s*\()/;

const deletedTestFileRule: DiffRule = {
    id: "diff/deleted-test-file",
    summary: "A test file is deleted",
    check(input) {
        return input.stats
            .filter((stat) => stat.status === "D" && isTestPath(stat.path))
            .map((stat) => ({
                severity: "warning" as const,
                title: `Test file ${stat.path} deleted`,
                detail: "Make sure the behaviour it covered is still tested.",
                file: stat.path,
            }));
    },
};

const removedTestCasesRule: DiffRule = {
    id: "diff/removed-test-cases",
    summary: "More test cases are removed from a test file than added",
    check(input) {
        const hits: RuleHit[] = [];
        for (const file of input.files) {
            if (file.status === "deleted" || !isTestPath(file.path)) continue;
            let removed = 0;
            let added = 0;
            let firstRemoval: number | undefined;
            for (const hunk of file.hunks) {
                for (const entry of hunk.lines) {
                    if (!TEST_CASE.test(entry.text)) continue;
                    if (entry.kind === "remove") {
                        removed += 1;
                        // Point at where the removal happened in the new file.
                        firstRemoval ??= Math.max(1, hunk.newStart);
                    } else if (entry.kind === "add") {
                        added += 1;
                    }
                }
            }
            if (removed > added) {
                const net = removed - added;
                hits.push({
                    severity: "warning",
                    title: `${net} test case${net === 1 ? "" : "s"} removed from ${file.path}`,
                    detail: `${removed} removed, ${added} added.`,
                    file: file.path,
                    line: firstRemoval,
                });
            }
        }
        return hits;
    },
};

const testFocusRule = lineRule("diff/test-focus", "A focused test (.only) is added, so the rest of the suite is skipped", {
    appliesTo: isTestPath,
    match: ({ text }) =>
        /\b(?:it|test|describe|context|suite)\.only\s*\(|\b(?:fit|fdescribe)\s*\(/.test(text)
            ? { severity: "warning", title: "Focused test added (.only)", detail: excerptOf(text) }
            : null,
});

const testSkipRule = lineRule("diff/test-skip", "A skipped test is added", {
    appliesTo: isTestPath,
    match: ({ text }) =>
        /\b(?:it|test|describe|context|suite)\.skip\s*\(|\b(?:xit|xdescribe|xtest)\s*\(|@pytest\.mark\.skip|@unittest\.skip|\bt\.Skip(?:f|Now)?\s*\(|#\[ignore\]/.test(
            text,
        )
            ? { severity: "warning", title: "Skipped test added", detail: excerptOf(text) }
            : null,
});

/* -------------------------------------------------------------------------
 * Risky patterns
 * ---------------------------------------------------------------------- */

const evalRule = patternRule(
    "diff/eval",
    "Strings evaluated as code (eval, new Function)",
    "warning",
    /(?<![.\w$])eval\s*\(|\bnew\s+Function\s*\(/,
    "Code evaluated from a string (eval, new Function)",
    (p) => isSourceLike(p) && !isTestPath(p),
    "Evaluating strings as code runs whatever reaches it.",
);

const execInterpolatedRule = patternRule(
    "diff/exec-interpolated",
    "child_process exec with a template or concatenated command string",
    "error",
    /\b(?:exec|execSync)\s*\(\s*(?:`[^`]*\$\{|["'][^"']*["']\s*\+|[\w.]+\s*\+\s*["'`])/,
    "Shell command built from interpolated strings",
    isJsPath,
    "exec() hands the string to a shell, so interpolated values can inject commands. Use execFile/spawn with an argument array.",
);

const rmRfRule = lineRule("diff/rm-rf", "Recursive forced delete (rm -rf) added to a script", {
    appliesTo: isSourceLike,
    match: ({ text }) => {
        const match = /\brm\s+(?:-[a-zA-Z]*(?:r[a-zA-Z]*f|f[a-zA-Z]*r)[a-zA-Z]*|-r\s+-f|-f\s+-r|--recursive\s+--force|--force\s+--recursive)\s+(.*)$/.exec(text);
        if (match === null) return null;
        const target = (match[1] ?? "").trim();
        // A bare root, home, or an unquoted variable followed by "/" ("$DIR/"
        // wipes / when DIR is empty).
        const dangerous = /^(?:\/\*?|~\/?\*?|\$HOME\/?\*?|"?\$\{?\w+\}?"?\/\*?|\*)(?:\s|$|;|&|\|)/.test(target);
        return {
            severity: dangerous ? "error" : "warning",
            title: dangerous
                ? "Recursive forced delete of a root, home or variable path added"
                : "Recursive forced delete (rm -rf) added",
            detail: excerptOf(text),
        };
    },
});

const noVerifyRule = patternRule(
    "diff/no-verify",
    "--no-verify added (skips git hooks)",
    "warning",
    /(?:^|\s)--no-verify\b/,
    "--no-verify added: git hooks are skipped",
    isSourceLike,
);

const tlsRule = patternRule(
    "diff/tls-verify-disabled",
    "TLS certificate verification disabled",
    "error",
    /\brejectUnauthorized\s*:\s*false\b|\bverify\s*=\s*False\b|NODE_TLS_REJECT_UNAUTHORIZED["']?\s*[:=]\s*["']?0|\bInsecureSkipVerify\s*:\s*true\b|\bstrictSSL\s*:\s*false\b|\bCURLOPT_SSL_VERIFYPEER\s*,\s*(?:false|0)\b/,
    "TLS certificate verification disabled",
    isSourceLike,
    "Connections accept any certificate, so they can be intercepted.",
);

const tsIgnoreRule = patternRule(
    "diff/ts-ignore",
    "Type checking suppressed (ts-ignore, ts-nocheck)",
    "warning",
    /@ts-(?:ignore|nocheck)\b/,
    "Type checking suppressed (ts-ignore)",
    isJsPath,
);

const eslintDisableRule = patternRule(
    "diff/eslint-disable",
    "Lint rule disabled inline (eslint directive)",
    "warning",
    /(?:\/\/|\/\*)\s*eslint-disable(?:-next-line|-line)?\b/,
    "Lint rule disabled inline (eslint directive)",
    isJsPath,
);

const anyCastRule = patternRule(
    "diff/any-cast",
    "Cast to any added in TypeScript",
    "info",
    /\bas\s+any\b|<any>\s*[\w(]/,
    "Cast to `any` added",
    isTsPath,
);

const todoRule = patternRule(
    "diff/todo",
    "TODO, FIXME or XXX added", // tyr-ignore: todo
    "info",
    /\b(?:TODO|FIXME|XXX)\b/, // tyr-ignore: todo
    "TODO/FIXME added", // tyr-ignore: todo
    isSourceLike,
);

const consoleLogRule = patternRule(
    "diff/console-log",
    "console.log added in non-test source",
    "info",
    /\bconsole\.log\s*\(/,
    "console.log added",
    isNonTestJs,
);

const debuggerRule = lineRule("diff/debugger", "debugger statement or breakpoint added in non-test source", {
    appliesTo: (p) => !isTestPath(p) && (isJsPath(p) || extension(p) === "py"),
    match: ({ text, file }) => {
        const found = isJsPath(file.path)
            ? /^\s*debugger\s*;?\s*(?:\/\/.*)?$/.test(text)
            : /^\s*(?:breakpoint\(\)|(?:import\s+i?pdb\s*;\s*)?i?pdb\.set_trace\(\))/.test(text);
        return found ? { severity: "info", title: "Debugger statement added", detail: excerptOf(text) } : null;
    },
});

/* -------------------------------------------------------------------------
 * Size and sensitive files
 * ---------------------------------------------------------------------- */

const largeChangeRule: DiffRule = {
    id: "diff/large-change",
    summary: "The change as a whole is too large to review well",
    check({ diff, thresholds }) {
        const changed = diff.totals.additions + diff.totals.deletions;
        if (changed <= thresholds.maxChangedLines) return [];
        return [
            {
                severity: "warning",
                title: `Large change: ${changed} lines changed`,
                detail: `${diff.totals.additions} added, ${diff.totals.deletions} removed across ${diff.totals.files} files (threshold ${thresholds.maxChangedLines}). Consider splitting it.`,
            },
        ];
    },
};

const manyFilesRule: DiffRule = {
    id: "diff/many-files",
    summary: "The change touches too many files to review well",
    check({ diff, thresholds }) {
        const files = diff.files.length;
        if (files <= thresholds.maxFiles) return [];
        return [
            {
                severity: "warning",
                title: `Large change: ${files} files changed`,
                detail: `Threshold ${thresholds.maxFiles}. Consider splitting it.`,
            },
        ];
    },
};

const largeFileRule: DiffRule = {
    id: "diff/large-file-change",
    summary: "One file has a very large change",
    check({ stats, thresholds }) {
        return stats
            .filter((s) => !s.binary && !isLockPath(s.path) && s.additions + s.deletions > thresholds.maxFileChangedLines)
            .map((s) => ({
                severity: "warning" as const,
                title: `Large change to ${s.path}: ${s.additions + s.deletions} lines`,
                detail: `${s.additions} added, ${s.deletions} removed (threshold ${thresholds.maxFileChangedLines}).`,
                file: s.path,
            }));
    },
};

const lockfileRule: DiffRule = {
    id: "diff/lockfile-without-manifest",
    summary: "A lockfile changed but its manifest did not",
    check({ stats }) {
        const changed = stats.map((s) => s.path);
        const hits: RuleHit[] = [];
        for (const stat of stats) {
            const manifests = LOCKFILE_MANIFESTS[baseName(stat.path)];
            if (manifests === undefined || stat.status === "D") continue;
            const dir = dirName(stat.path);
            // Workspaces: a manifest change anywhere below the lockfile counts.
            const covered = changed.some((p) => {
                const inside = dir === "" || p.startsWith(`${dir}/`);
                const name = baseName(p);
                return inside && manifests.some((m) => (m.startsWith(".") ? name.endsWith(m) : name === m));
            });
            if (!covered) {
                hits.push({
                    severity: "warning",
                    title: `${stat.path} changed without ${manifests[0]}`,
                    detail: "Dependencies moved without a manifest change. Check it is an intended update and not an accidental reinstall.",
                    file: stat.path,
                });
            }
        }
        return hits;
    },
};

const ciConfigRule: DiffRule = {
    id: "diff/ci-config",
    summary: "CI or workflow configuration changed",
    check({ stats }) {
        return stats
            .filter((s) => isCiPath(s.path))
            .map((s) => ({
                severity: "info" as const,
                title: `CI configuration changed: ${s.path}`,
                detail: "CI runs with repository secrets; review it closely.",
                file: s.path,
            }));
    },
};

const manifestRule: DiffRule = {
    id: "diff/dependency-manifest",
    summary: "A dependency manifest changed",
    check({ stats }) {
        return stats
            .filter((s) => isManifestPath(s.path))
            .map((s) => ({
                severity: "info" as const,
                title: `Dependency manifest changed: ${s.path}`,
                detail: "Check new or upgraded dependencies.",
                file: s.path,
            }));
    },
};

/* -------------------------------------------------------------------------
 * Registry and entry point
 * ---------------------------------------------------------------------- */

export const DIFF_RULES: readonly DiffRule[] = [
    ...SECRET_PATTERNS.map(secretRule),
    envFileRule,
    deletedTestFileRule,
    removedTestCasesRule,
    testFocusRule,
    testSkipRule,
    evalRule,
    execInterpolatedRule,
    rmRfRule,
    noVerifyRule,
    tlsRule,
    tsIgnoreRule,
    eslintDisableRule,
    anyCastRule,
    todoRule,
    consoleLogRule,
    debuggerRule,
    largeChangeRule,
    manyFilesRule,
    largeFileRule,
    lockfileRule,
    ciConfigRule,
    manifestRule,
];

function normalizeRuleId(id: string): string {
    const trimmed = id.trim();
    return trimmed.startsWith("diff/") ? trimmed : `diff/${trimmed}`;
}

function isDisabled(ruleId: string, disabled: readonly string[]): boolean {
    return disabled.some((entry) => {
        const id = normalizeRuleId(entry);
        return id.endsWith("*") ? ruleId.startsWith(id.slice(0, -1)) : id === ruleId;
    });
}

/**
 * Suppressions from added lines: file -> line -> rule ids, or "*" for all.
 * `tyr-ignore` alone suppresses everything on the line.
 */
function collectSuppressions(files: readonly PatchFile[]): Map<string, Map<number, Set<string>>> {
    const out = new Map<string, Map<number, Set<string>>>();
    for (const file of files) {
        for (const hunk of file.hunks) {
            for (const entry of hunk.lines) {
                if (entry.kind !== "add") continue;
                const match = /\btyr-ignore\b(?:\s*:\s*([\w./*-]+(?:\s*,\s*[\w./*-]+)*))?/.exec(entry.text);
                if (match === null) continue;
                const rules = new Set<string>(
                    match[1] === undefined ? ["*"] : match[1].split(",").map((r) => normalizeRuleId(r)),
                );
                let lines = out.get(file.path);
                if (lines === undefined) out.set(file.path, (lines = new Map()));
                lines.set(entry.line, rules);
            }
        }
    }
    return out;
}

function resolveThresholds(partial: Partial<DiffReviewThresholds> | undefined): DiffReviewThresholds {
    const out = { ...DEFAULT_DIFF_REVIEW_THRESHOLDS };
    for (const key of Object.keys(out) as (keyof DiffReviewThresholds)[]) {
        const value = partial?.[key];
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) out[key] = Math.floor(value);
    }
    return out;
}

/**
 * Run every enabled rule over `ctx.diff`. Most severe first, deduplicated,
 * at most MAX_FINDINGS_PER_DETECTOR. Never throws.
 */
export function reviewDiff(ctx: ReviewContext, opts: DiffReviewOptions = {}): EngineFinding[] {
    try {
        const diff = ctx.diff;
        const thresholds = resolveThresholds(opts.thresholds);
        const disabled = opts.disabledRules ?? [];
        const parsed = parsePatch(typeof diff.patch === "string" ? diff.patch : "", diff.truncated === true);
        const files = parsed.filter((f) => !f.binary && !f.truncated);
        const input: RuleInput = { diff, files, stats: Array.isArray(diff.files) ? diff.files : [], thresholds };
        const suppressions = collectSuppressions(files);

        const findings: EngineFinding[] = [];
        for (const rule of DIFF_RULES) {
            if (isDisabled(rule.id, disabled)) continue;
            let hits: RuleHit[];
            try {
                hits = rule.check(input);
            } catch {
                continue;
            }
            for (const hit of hits) {
                if (hit.file !== undefined && hit.line !== undefined) {
                    const rules = suppressions.get(hit.file)?.get(hit.line);
                    if (rules !== undefined && (rules.has("*") || rules.has(rule.id))) continue;
                }
                findings.push(makeFinding({ source: "diff", rule: rule.id, ...hit }));
            }
        }
        return dedupeFindings(findings).sort(compareFindings).slice(0, MAX_FINDINGS_PER_DETECTOR);
    } catch {
        return [];
    }
}
