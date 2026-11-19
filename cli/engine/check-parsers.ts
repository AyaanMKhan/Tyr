// Check output parsers (PLANNING.md 2.11): turn a CheckRun's stdout/stderr
// into EngineFindings with file, line, rule and severity.
//
// A set of small parsers, each recognizing one tool's output format from the
// text itself (with run.command as a hint). Every parser that recognizes its
// format contributes; the generic `path:line:col: error: msg` parser only
// runs when no specific one found anything. A failed or timed-out run that
// nothing could explain yields a single summary finding with the output tail.
//
// Pure and total: no I/O, never throws.

import * as path from "node:path";
import type { FindingSeverity } from "../core/reports.js";
import type { CheckRun } from "./model.js";
import { MAX_FINDINGS_PER_DETECTOR, dedupeFindings, makeFinding, type EngineFinding, type FindingInput } from "./findings.js";

/** What a parser extracts; source, checkKind and fingerprint are added by parseCheckRun. */
export interface ParsedIssue {
    severity: FindingSeverity;
    title: string;
    detail?: string;
    /** As printed by the tool; relativized by parseCheckRun. */
    file?: string;
    line?: number;
    column?: number;
    rule?: string;
}

export interface CheckOutputParser {
    name: string;
    /** Cheap test: does this output (or command) look like this tool's? */
    detect(text: string, command: string): boolean;
    parse(lines: readonly string[], command: string): ParsedIssue[];
}

/** Lines of output kept in the fallback summary finding. */
export const FALLBACK_TAIL_LINES = 20;

const MAX_TITLE_LENGTH = 300;
const MAX_DETAIL_LINES = 12;

/* -------------------------------------------------------------------------
 * Text helpers
 * ---------------------------------------------------------------------- */

// CSI sequences (colors, cursor movement), OSC sequences (hyperlinks, titles)
// and the remaining two-character escapes.
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]|\u009b[0-?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
    return text.replace(ANSI_PATTERN, "");
}

/** ANSI-free lines; a carriage return keeps only what was drawn last on that line. */
function toLines(text: string): string[] {
    return stripAnsi(text)
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map((line) => {
            const cr = line.lastIndexOf("\r");
            return cr >= 0 ? line.slice(cr + 1) : line;
        });
}

function clip(text: string, max = MAX_TITLE_LENGTH): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function joinDetail(lines: readonly string[]): string | undefined {
    const kept = lines.map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
    if (kept.length === 0) return undefined;
    // Drop common indentation so the detail reads cleanly.
    const indent = Math.min(...kept.map((l) => l.length - l.trimStart().length));
    return kept
        .slice(0, MAX_DETAIL_LINES)
        .map((l) => l.slice(indent))
        .join("\n");
}

function int(value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

function commandMentions(command: string, ...words: string[]): boolean {
    return words.some((w) => new RegExp(`(^|[\\s/"'=])${w}([\\s"']|$)`).test(command));
}

const IS_WINDOWS_ABS = /^[A-Za-z]:\//;

/**
 * Normalize a path printed by a tool: "/" separators, no file:// prefix, and
 * root-relative when it lies under cwd. Paths outside cwd are left as printed
 * (with "/" separators).
 */
export function relativizePath(file: string, cwd: string): string {
    let p = file
        .trim()
        .replace(/^file:\/\//, "")
        .replace(/\\/g, "/");
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1); // file:///C:/...
    const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
    if (root === "") return p;
    const windows = IS_WINDOWS_ABS.test(root);
    const absolute = p.startsWith("/") || IS_WINDOWS_ABS.test(p);
    const resolved = path.posix.normalize(absolute ? p : `${root}/${p}`);
    const a = windows ? resolved.toLowerCase() : resolved;
    const r = windows ? root.toLowerCase() : root;
    if (a.startsWith(`${r}/`)) return resolved.slice(root.length + 1);
    if (!absolute) {
        const normalized = path.posix.normalize(p);
        return normalized.startsWith("./") ? normalized.slice(2) : normalized;
    }
    return p;
}

/* -------------------------------------------------------------------------
 * TypeScript (tsc)
 * ---------------------------------------------------------------------- */

const TSC_PLAIN = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/;
const TSC_PRETTY = /^(.+?):(\d+):(\d+) - (error|warning) (TS\d+): (.*)$/;

export const tscParser: CheckOutputParser = {
    name: "tsc",
    detect: (text) => /\b(error|warning) TS\d+:/.test(text),
    parse(lines) {
        const out: ParsedIssue[] = [];
        for (let i = 0; i < lines.length; i++) {
            const m = TSC_PLAIN.exec(lines[i]) ?? TSC_PRETTY.exec(lines[i]);
            if (!m) continue;
            // Continuation lines (elaborations) are indented right below.
            const more: string[] = [];
            for (let j = i + 1; j < lines.length && /^ {2,}\S/.test(lines[j]) && !TSC_PLAIN.test(lines[j]); j++) {
                more.push(lines[j]);
            }
            out.push({
                severity: m[4] === "warning" ? "warning" : "error",
                title: clip(m[6]),
                detail: joinDetail(more),
                file: m[1].trim(),
                line: int(m[2]),
                column: int(m[3]),
                rule: m[5],
            });
        }
        return out;
    },
};

/* -------------------------------------------------------------------------
 * ESLint (stylish, unix, compact)
 * ---------------------------------------------------------------------- */

const ESLINT_STYLISH = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.*?)(?:\s{2,}([@\w][\w@/.-]*))?\s*$/;
const ESLINT_UNIX = /^(.+?):(\d+):(\d+): (.*) \[(Error|Warning)(?:\/([^\]]+))?\]$/;
const ESLINT_COMPACT = /^(.+?): line (\d+), col (\d+), (Error|Warning) - (.*?)(?: \(([@\w][\w@/.-]*)\))?$/;

export const eslintParser: CheckOutputParser = {
    name: "eslint",
    detect: (text, command) =>
        commandMentions(command, "eslint") ||
        /^\s+\d+:\d+\s+(error|warning)\s+/m.test(text) ||
        / \[(Error|Warning)\/[^\]]+\]$/m.test(text) ||
        /: line \d+, col \d+, (Error|Warning) - /.test(text),
    parse(lines) {
        const out: ParsedIssue[] = [];
        let currentFile: string | undefined;
        for (const line of lines) {
            let m = ESLINT_UNIX.exec(line);
            if (m) {
                out.push(issue(m[5], m[4], m[1], m[2], m[3], m[6]));
                continue;
            }
            m = ESLINT_COMPACT.exec(line);
            if (m) {
                out.push(issue(m[4], m[5], m[1], m[2], m[3], m[6]));
                continue;
            }
            m = ESLINT_STYLISH.exec(line);
            if (m && currentFile) {
                out.push(issue(m[3], m[4], currentFile, m[1], m[2], m[5]));
                continue;
            }
            // Stylish prints each file path unindented on its own line.
            if (/^\S/.test(line) && !/^✖|^\d+ problems?/.test(line) && /[\\/.]/.test(line) && !/\s{2,}/.test(line)) {
                currentFile = line.trim();
            } else if (line.trim() === "") {
                currentFile = undefined;
            }
        }
        return out;

        function issue(sev: string, msg: string, file: string, l: string, c: string, rule?: string): ParsedIssue {
            return {
                severity: sev.toLowerCase() === "warning" ? "warning" : "error",
                title: clip(msg),
                file: file.trim(),
                line: int(l),
                column: int(c),
                rule: rule || undefined,
            };
        }
    },
};

/* -------------------------------------------------------------------------
 * node:test — TAP reporter
 * ---------------------------------------------------------------------- */

const TAP_NOT_OK = /^(\s*)not ok \d+(?: -)? ?(.*?)\s*$/;

/** Unquote a one-line YAML scalar: 'it''s' or "x". */
function yamlScalar(value: string): string {
    const v = value.trim();
    if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
        try {
            return JSON.parse(v) as string;
        } catch {
            return v.slice(1, -1);
        }
    }
    return v;
}

/** Split `path:line:col` (path may contain colons, e.g. C:/). */
function splitLocation(loc: string): { file: string; line?: number; column?: number } {
    const m = /^(.*?):(\d+)(?::(\d+))?$/.exec(loc.trim());
    if (!m) return { file: loc.trim() };
    return { file: m[1], line: int(m[2]), column: int(m[3]) };
}

export const tapParser: CheckOutputParser = {
    name: "tap",
    detect: (text) => /^\s*not ok \d+/m.test(text),
    parse(lines) {
        const out: ParsedIssue[] = [];
        for (let i = 0; i < lines.length; i++) {
            const m = TAP_NOT_OK.exec(lines[i]);
            if (!m) continue;
            let name = m[2];
            if (/#\s*(TODO|SKIP)\b/i.test(name)) continue;
            name = name.replace(/\s+#.*$/, "") || "(unnamed test)";

            // Optional YAML diagnostics block: "---" ... "..."
            const fields = new Map<string, string>();
            if (lines[i + 1]?.trim() === "---") {
                let j = i + 2;
                for (; j < lines.length && lines[j].trim() !== "..."; j++) {
                    const f = /^(\s*)([A-Za-z_]+):\s?(.*)$/.exec(lines[j]);
                    if (!f) continue;
                    let value = f[3];
                    if (/^[|>][-+]?$/.test(value.trim())) {
                        const block: string[] = [];
                        const keyIndent = f[1].length;
                        for (let k = j + 1; k < lines.length; k++) {
                            const l = lines[k];
                            if (l.trim() !== "" && l.length - l.trimStart().length <= keyIndent) break;
                            block.push(l);
                            j = k;
                        }
                        value = joinDetail(block) ?? "";
                    } else {
                        value = yamlScalar(value);
                    }
                    if (!fields.has(f[2])) fields.set(f[2], value);
                }
                i = j;
            }
            // A suite that failed only because a child failed: the child is reported itself.
            if (fields.get("failureType") === "subtestsFailed") continue;
            const loc = fields.get("location");
            const where = loc ? splitLocation(loc) : undefined;
            out.push({
                severity: "error",
                title: clip(`Test failed: ${name}`),
                detail: fields.get("error") || undefined,
                file: where?.file,
                line: where?.line,
                column: where?.column,
                rule: name,
            });
        }
        return out;
    },
};

/* -------------------------------------------------------------------------
 * node:test — spec reporter
 * ---------------------------------------------------------------------- */

const SPEC_FAIL = /^(\s*)✖ (.+?) \((\d[\d.]*m?s)\)\s*$/;

export const nodeSpecParser: CheckOutputParser = {
    name: "node-test-spec",
    detect: (text) => /^\s*✖ .+ \(\d[\d.]*m?s\)\s*$/m.test(text) || /^✖ failing tests:/m.test(text),
    parse(lines) {
        const out: ParsedIssue[] = [];
        const summary = lines.findIndex((l) => /^✖ failing tests:/.test(l));
        if (summary >= 0) {
            // "test at path:l:c" / "✖ name (1ms)" / indented error, repeated.
            let loc: ReturnType<typeof splitLocation> | undefined;
            for (let i = summary + 1; i < lines.length; i++) {
                const at = /^test at (.+)$/.exec(lines[i]);
                if (at) {
                    loc = splitLocation(at[1]);
                    continue;
                }
                const m = SPEC_FAIL.exec(lines[i]);
                if (!m) continue;
                const body: string[] = [];
                let j = i + 1;
                for (; j < lines.length; j++) {
                    const l = lines[j];
                    if (/^\S/.test(l)) break;
                    if (/^\s+at /.test(l)) break;
                    body.push(l);
                }
                out.push({
                    severity: "error",
                    title: clip(`Test failed: ${m[2]}`),
                    detail: joinDetail(body),
                    file: loc?.file,
                    line: loc?.line,
                    column: loc?.column,
                    rule: m[2],
                });
                loc = undefined;
                i = j - 1;
            }
            return out;
        }
        // No summary section: use the progress lines, skipping suites (opened with ▶).
        const suites = new Set<string>();
        for (const line of lines) {
            const s = /^(\s*)▶ (.+?)\s*$/.exec(line);
            if (s) suites.add(`${s[1].length}:${s[2]}`);
        }
        for (const line of lines) {
            const m = SPEC_FAIL.exec(line);
            if (!m || suites.has(`${m[1].length}:${m[2]}`)) continue;
            out.push({ severity: "error", title: clip(`Test failed: ${m[2]}`), rule: m[2] });
        }
        return out;
    },
};

/* -------------------------------------------------------------------------
 * Jest / Vitest
 * ---------------------------------------------------------------------- */

const JEST_BULLET = /^\s*● (.+?)\s*$/;
const JEST_FAIL_FILE = /^\s*FAIL\s+(\S[^>]*?)\s*$/;
const VITEST_FAIL = /^\s*FAIL\s+(\S+?)\s+(?:>\s+(.+?))?\s*(?:\[.*\])?\s*$/;
const STACK_FRAME = /^\s*at (?:.*\()?(.+?):(\d+):(\d+)\)?\s*$/;

function firstUsefulFrame(lines: readonly string[], preferFile?: string): ParsedIssue | undefined {
    let fallback: ParsedIssue | undefined;
    for (const l of lines) {
        const m = STACK_FRAME.exec(l) ?? /^\s*❯ (.+?):(\d+):(\d+)\s*$/.exec(l);
        if (!m) continue;
        const file = m[1].replace(/^file:\/\//, "");
        if (/node_modules|^node:|^internal\//.test(file)) continue;
        const frame = { severity: "error" as const, title: "", file, line: int(m[2]), column: int(m[3]) };
        if (preferFile && file.replace(/\\/g, "/").endsWith(preferFile.replace(/\\/g, "/"))) return frame;
        fallback ??= frame;
    }
    return fallback;
}

/** Message lines of a failure block: up to the code frame or the stack. */
function failureMessage(body: readonly string[]): string | undefined {
    const msg: string[] = [];
    for (const l of body) {
        if (/^\s*(>\s*)?\d+ \|/.test(l) || /^\s+\|/.test(l) || STACK_FRAME.test(l) || /^\s*❯ /.test(l)) break;
        if (/^\s*⎯{3,}/.test(l)) break;
        msg.push(l);
    }
    return joinDetail(msg);
}

export const jestParser: CheckOutputParser = {
    name: "jest",
    detect: (text, command) =>
        commandMentions(command, "jest", "vitest") || /^\s*● .+ › /m.test(text) || /^\s*FAIL\s+\S+/m.test(text) || /^\s*[✕×] .+/m.test(text),
    parse(lines) {
        const out: ParsedIssue[] = [];

        // Jest: "FAIL path" then "● Suite › test" blocks.
        let file: string | undefined;
        for (let i = 0; i < lines.length; i++) {
            const f = JEST_FAIL_FILE.exec(lines[i]);
            if (f && !/ > /.test(lines[i])) {
                file = f[1];
                continue;
            }
            const b = JEST_BULLET.exec(lines[i]);
            if (!b || /^Console\b/.test(b[1])) continue;
            const body: string[] = [];
            let j = i + 1;
            for (; j < lines.length; j++) {
                if (JEST_BULLET.test(lines[j]) || /^\s*(FAIL|PASS)\s/.test(lines[j]) || /^Test Suites:/.test(lines[j])) break;
                body.push(lines[j]);
            }
            const frame = firstUsefulFrame(body, file);
            const name = b[1];
            out.push({
                severity: "error",
                title: clip(`Test failed: ${name}`),
                detail: failureMessage(body),
                file: frame?.file ?? file,
                line: frame?.line,
                column: frame?.column,
                rule: name,
            });
            i = j - 1;
        }
        if (out.length > 0) return out;

        // Vitest: " FAIL  path > Suite > test" followed by the error and "❯ path:l:c".
        for (let i = 0; i < lines.length; i++) {
            if (!/ > |\[ /.test(lines[i])) continue;
            const v = VITEST_FAIL.exec(lines[i]);
            if (!v) continue;
            const body: string[] = [];
            let j = i + 1;
            for (; j < lines.length; j++) {
                if (/^\s*FAIL\s/.test(lines[j]) || /^\s*⎯{3,}/.test(lines[j]) || /^\s*Test Files\s/.test(lines[j])) break;
                body.push(lines[j]);
            }
            const frame = firstUsefulFrame(body, v[1]);
            const name = v[2] ? v[2].replace(/\s+>\s+/g, " > ") : v[1];
            out.push({
                severity: "error",
                title: clip(`Test failed: ${name}`),
                detail: failureMessage(body),
                file: frame?.file ?? v[1],
                line: frame?.line,
                column: frame?.column,
                rule: name,
            });
            i = j - 1;
        }
        if (out.length > 0) return out;

        // Last resort: the per-test "✕ name (3 ms)" / "× name 3ms" lines.
        for (const line of lines) {
            const m = /^\s*[✕×] (.+?)(?:\s+\(?\d+\s?m?s\)?)?\s*$/.exec(line);
            if (m) out.push({ severity: "error", title: clip(`Test failed: ${m[1]}`), rule: m[1] });
        }
        return out;
    },
};

/* -------------------------------------------------------------------------
 * pytest
 * ---------------------------------------------------------------------- */

export const pytestParser: CheckOutputParser = {
    name: "pytest",
    detect: (text, command) => /^(FAILED|ERROR) \S+(::\S+)?( - .*)?$/m.test(text) || (commandMentions(command, "pytest") && /^E\s{2,}/m.test(text)),
    parse(lines) {
        // Failure sections: "____ TestClass.test_name ____" with "E   ..." lines and "path:line: Exc".
        const sections = new Map<string, { errors: string[]; file?: string; line?: number }>();
        let current: { errors: string[]; file?: string; line?: number } | undefined;
        for (const l of lines) {
            const h = /^_{3,} (.+?) _{3,}$/.exec(l);
            if (h) {
                current = { errors: [] };
                sections.set(h[1].replace(/^ERROR (at \w+ of )?/, ""), current);
                continue;
            }
            if (/^={3,}/.test(l)) {
                current = undefined;
                continue;
            }
            if (!current) continue;
            // Keep the indentation after "E"; joinDetail removes what is common.
            const e = /^E( .*)?$/.exec(l);
            if (e) current.errors.push(e[1] ?? "");
            const loc = /^(\S+\.py):(\d+): \S/.exec(l);
            if (loc) {
                current.file = loc[1];
                current.line = int(loc[2]);
            }
        }

        const out: ParsedIssue[] = [];
        for (const l of lines) {
            const m = /^(FAILED|ERROR) (\S+?)(?:::(\S+))?(?: - (.*))?$/.exec(l);
            if (!m) continue;
            const [, kind, file, testPath, message] = m;
            const name = testPath ? testPath.replace(/::/g, ".") : file;
            const section = sections.get(name) ?? (testPath ? sections.get(testPath.split("::").pop() ?? "") : undefined);
            const detail = section && section.errors.length > 0 ? joinDetail(section.errors) : message;
            out.push({
                severity: "error",
                title: clip(kind === "ERROR" ? `Test error: ${name}` : `Test failed: ${name}`),
                detail: detail || undefined,
                file: section?.file ?? file,
                line: section?.line,
                rule: testPath ?? file,
            });
        }
        if (out.length > 0) return out;

        // No short summary (-rN or truncated): fall back to the sections themselves.
        for (const [name, s] of sections) {
            if (s.errors.length === 0) continue;
            out.push({
                severity: "error",
                title: clip(`Test failed: ${name}`),
                detail: joinDetail(s.errors),
                file: s.file,
                line: s.line,
                rule: name,
            });
        }
        return out;
    },
};

/* -------------------------------------------------------------------------
 * Rust / cargo (rustc, clippy, cargo test)
 * ---------------------------------------------------------------------- */

export const cargoParser: CheckOutputParser = {
    name: "cargo",
    detect: (text) => /^\s*--> \S+:\d+:\d+/m.test(text) || /^test \S+ \.\.\. FAILED$/m.test(text),
    parse(lines) {
        const out: ParsedIssue[] = [];
        for (let i = 0; i < lines.length; i++) {
            const h = /^(error|warning)(?:\[([A-Za-z0-9_:-]+)\])?: (.+)$/.exec(lines[i]);
            if (!h) continue;
            // The location arrow follows within a couple of lines.
            let loc: RegExpExecArray | null = null;
            for (let j = i + 1; j <= i + 3 && j < lines.length; j++) {
                loc = /^\s*--> (.+?):(\d+):(\d+)\s*$/.exec(lines[j]);
                if (loc) break;
                if (/^(error|warning)/.test(lines[j])) break;
            }
            if (!loc) continue; // "error: could not compile", "warning: 2 warnings emitted"
            // Lint name from "= note: `#[warn(unused_variables)]` on by default" / "#[deny(clippy::x)]".
            let rule = h[2];
            for (let j = i + 1; !rule && j < lines.length && j < i + 40; j++) {
                if (/^(error|warning)/.test(lines[j])) break;
                const n = /#\[(?:warn|deny|forbid)\(([\w:]+)\)\]/.exec(lines[j]);
                if (n) rule = n[1];
            }
            out.push({
                severity: h[1] === "warning" ? "warning" : "error",
                title: clip(h[3]),
                file: loc[1],
                line: int(loc[2]),
                column: int(loc[3]),
                rule,
            });
        }

        // cargo test: "test path::name ... FAILED" plus "---- path::name stdout ----" sections.
        for (const l of lines) {
            const t = /^test (\S+) \.\.\. FAILED$/.exec(l);
            if (!t) continue;
            const name = t[1];
            const start = lines.findIndex((x) => x === `---- ${name} stdout ----`);
            const body: string[] = [];
            let file: string | undefined;
            let line: number | undefined;
            let column: number | undefined;
            if (start >= 0) {
                for (let j = start + 1; j < lines.length && !/^(----|failures:|note: run with)/.test(lines[j]); j++) {
                    const p = /panicked at (?:'.*?', )?(.+?):(\d+):(\d+):?$/.exec(lines[j]) ?? /panicked at '.*', (.+?):(\d+):(\d+)$/.exec(lines[j]);
                    if (p && !file) {
                        file = p[1];
                        line = int(p[2]);
                        column = int(p[3]);
                        continue;
                    }
                    body.push(lines[j]);
                }
            }
            out.push({
                severity: "error",
                title: clip(`Test failed: ${name}`),
                detail: joinDetail(body),
                file,
                line,
                column,
                rule: name,
            });
        }
        return out;
    },
};

/* -------------------------------------------------------------------------
 * Go (go build / go vet / go test / golangci-lint)
 * ---------------------------------------------------------------------- */

export const goParser: CheckOutputParser = {
    name: "go",
    detect: (text, command) => /^--- FAIL: /m.test(text) || /^\S+\.go:\d+:\d+: /m.test(text) || (commandMentions(command, "go") && /\.go:\d+/.test(text)),
    parse(lines, command) {
        const out: ParsedIssue[] = [];
        const lint = commandMentions(command, "golangci-lint");
        for (const l of lines) {
            const m = /^(?:vet: )?(\S+\.go):(\d+):(\d+): (.+)$/.exec(l);
            if (!m) continue;
            let msg = m[4];
            let rule: string | undefined;
            const r = lint ? /^(.*) \(([\w-]+)\)$/.exec(msg) : null;
            if (r) {
                msg = r[1];
                rule = r[2];
            }
            out.push({ severity: "error", title: clip(msg), file: m[1], line: int(m[2]), column: int(m[3]), rule });
        }

        // go test: "--- FAIL: TestX (0.00s)" with indented "file_test.go:12: message" lines.
        const failed: { name: string; at: number }[] = [];
        lines.forEach((l, at) => {
            const f = /^\s*--- FAIL: (\S+)/.exec(l);
            if (f) failed.push({ name: f[1], at });
        });
        for (const { name, at } of failed) {
            // A parent that failed only through its subtests is covered by them.
            if (failed.some((o) => o.name.startsWith(`${name}/`))) continue;
            const indent = lines[at].length - lines[at].trimStart().length;
            const body: string[] = [];
            let file: string | undefined;
            let line: number | undefined;
            for (let j = at + 1; j < lines.length; j++) {
                const l = lines[j];
                if (l.trim() === "" || l.length - l.trimStart().length <= indent) break;
                const loc = /^\s+(\S+\.go):(\d+): (.*)$/.exec(l);
                if (loc && !file) {
                    file = loc[1];
                    line = int(loc[2]);
                    body.push(loc[3]);
                } else {
                    body.push(l);
                }
            }
            out.push({ severity: "error", title: clip(`Test failed: ${name}`), detail: joinDetail(body), file, line, rule: name });
        }
        return out;
    },
};

/* -------------------------------------------------------------------------
 * Python linters and type checkers (ruff, flake8, pylint-style, mypy)
 * ---------------------------------------------------------------------- */

const PY_EXT = /\.(py|pyi|ipynb)$/;
const PY_CONCISE = /^(\S.*?):(\d+):(\d+): ([A-Z]{1,4}\d{2,4}) (?:\[\*\] )?(.*)$/;
const RUFF_FULL = /^([A-Z]{1,4}\d{2,4}) (?:\[\*\] )?(.+)$/;
const MYPY = /^(\S.*?\.pyi?):(\d+)(?::(\d+))?: (error|warning): (.*?)(?:\s{2}\[([\w-]+)\])?$/;

/** pycodestyle W-codes and pylint C/R are style warnings; everything else is an error. */
function pythonLintSeverity(code: string): FindingSeverity {
    return /^(W|C\d|R\d)/.test(code) && !/^WPS/.test(code) ? "warning" : "error";
}

export const pythonParser: CheckOutputParser = {
    name: "python-lint",
    detect: (text, command) =>
        commandMentions(command, "ruff", "flake8", "mypy", "pylint") || /^\S+\.pyi?:\d+(:\d+)?: (([A-Z]{1,4}\d{2,4}) |error: |warning: )/m.test(text),
    parse(lines, command) {
        const out: ParsedIssue[] = [];
        for (let i = 0; i < lines.length; i++) {
            const l = lines[i];
            const c = PY_CONCISE.exec(l);
            if (c && (PY_EXT.test(c[1]) || commandMentions(command, "ruff", "flake8", "pylint"))) {
                out.push({
                    severity: pythonLintSeverity(c[4]),
                    title: clip(c[5]),
                    file: c[1],
                    line: int(c[2]),
                    column: int(c[3]),
                    rule: c[4],
                });
                continue;
            }
            const t = MYPY.exec(l);
            if (t) {
                out.push({
                    severity: t[4] === "warning" ? "warning" : "error",
                    title: clip(t[5]),
                    file: t[1],
                    line: int(t[2]),
                    column: int(t[3]),
                    rule: t[6],
                });
                continue;
            }
            // ruff's "full" format: "F401 [*] `os` imported but unused" then " --> src/a.py:1:8".
            const f = RUFF_FULL.exec(l);
            const arrow = f && lines[i + 1] !== undefined ? /^\s*--> (.+?):(\d+):(\d+)\s*$/.exec(lines[i + 1]) : null;
            if (f && arrow) {
                out.push({
                    severity: pythonLintSeverity(f[1]),
                    title: clip(f[2]),
                    file: arrow[1],
                    line: int(arrow[2]),
                    column: int(arrow[3]),
                    rule: f[1],
                });
                i++;
            }
        }
        return out;
    },
};

/* -------------------------------------------------------------------------
 * Generic `path:line:col: error|warning: msg` (gcc, clang, swiftc, ...)
 * ---------------------------------------------------------------------- */

const GENERIC = /^((?:[A-Za-z]:)?[^:\s][^:]*?):(\d+)(?::(\d+))?:\s+(fatal error|error|warning):\s+(.*?)(?:\s+\[([-\w=.]+)\])?\s*$/;

export const genericParser: CheckOutputParser = {
    name: "generic",
    detect: (text) => /:\d+(:\d+)?:\s+(fatal error|error|warning):\s/.test(text),
    parse(lines) {
        const out: ParsedIssue[] = [];
        for (const l of lines) {
            const m = GENERIC.exec(l);
            if (!m) continue;
            out.push({
                severity: m[4] === "warning" ? "warning" : "error",
                title: clip(m[5]),
                file: m[1],
                line: int(m[2]),
                column: int(m[3]),
                rule: m[6]?.replace(/^-W/, "") || undefined,
            });
        }
        return out;
    },
};

/** Specific parsers, tried in order; all that recognize their format contribute. */
export const CHECK_OUTPUT_PARSERS: readonly CheckOutputParser[] = [
    tscParser,
    eslintParser,
    tapParser,
    nodeSpecParser,
    jestParser,
    pytestParser,
    cargoParser,
    goParser,
    pythonParser,
];

/* -------------------------------------------------------------------------
 * Entry point
 * ---------------------------------------------------------------------- */

function fallbackFinding(run: CheckRun, lines: readonly string[]): FindingInput {
    const status =
        run.outcome === "timeout"
            ? `timed out after ${Math.round(run.durationMs / 1000)}s`
            : run.exitCode !== null
              ? `failed (exit ${run.exitCode})`
              : `failed (${run.signal ?? "killed"})`;
    const tail = lines.filter((l) => l.trim() !== "").slice(-FALLBACK_TAIL_LINES);
    return {
        source: "check",
        checkKind: run.kind,
        severity: "error",
        title: `${run.kind} ${status}`,
        detail: tail.length > 0 ? tail.join("\n") : undefined,
        rule: run.kind,
    };
}

function runParsers(lines: readonly string[], text: string, command: string): ParsedIssue[] {
    const found: ParsedIssue[] = [];
    for (const parser of CHECK_OUTPUT_PARSERS) {
        try {
            if (parser.detect(text, command)) found.push(...parser.parse(lines, command));
        } catch {
            // A parser bug must never cost the other parsers' findings.
        }
    }
    if (found.length === 0) {
        try {
            if (genericParser.detect(text, command)) found.push(...genericParser.parse(lines, command));
        } catch {
            // ignore
        }
    }
    return found;
}

/**
 * Findings for one check run. Failed and timed-out runs always yield at least
 * one finding; passed runs yield only warnings (e.g. lint warnings); error and
 * cancelled runs yield none (the engine reports those itself).
 */
export function parseCheckRun(run: CheckRun): EngineFinding[] {
    try {
        if (run.outcome === "error" || run.outcome === "cancelled") return [];
        const text = [run.stdout ?? "", run.stderr ?? ""].filter((s) => s !== "").join("\n");
        const lines = toLines(text);
        const clean = lines.join("\n");
        const command = run.command ?? "";

        let issues = runParsers(lines, clean, command);
        if (run.outcome === "passed") issues = issues.filter((f) => f.severity === "warning" || f.severity === "info");

        const findings: EngineFinding[] = issues.map((issue) => {
            const input: FindingInput = { source: "check", checkKind: run.kind, severity: issue.severity, title: issue.title };
            if (issue.detail) input.detail = issue.detail;
            if (issue.file) input.file = relativizePath(issue.file, run.cwd ?? "");
            if (issue.line !== undefined) input.line = issue.line;
            if (issue.column !== undefined) input.column = issue.column;
            if (issue.rule) input.rule = issue.rule;
            return makeFinding(input);
        });

        // A timeout, or a failure the parsed output does not account for, gets a summary.
        const failing = run.outcome === "failed" || run.outcome === "timeout";
        const explained = findings.some((f) => f.severity === "error" || f.severity === "critical");
        if (run.outcome === "timeout" || (failing && !explained)) {
            findings.unshift(makeFinding(fallbackFinding(run, lines)));
        }
        return dedupeFindings(findings).slice(0, MAX_FINDINGS_PER_DETECTOR);
    } catch {
        return [];
    }
}
