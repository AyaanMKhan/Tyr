// cli/agents/coordinate.ts — coordinating with and correcting a live Claude
// Code session (PLANNING.md 2.14).
//
// Tyr already watches a session through hooks (cli/core/claude-hooks.ts) and
// checks its work in the background (cli/engine/). This module closes the
// loop: what Tyr finds goes back to Claude, through the same hooks.
//
//   engine.json problems ─┐
//   findings.json (error+) ┼─▶ corrections queue ─▶ hook reply ─▶ Claude Code
//   queueCorrection(user)  ┘   .tyr/state/corrections.json
//
// The queue
//   A Correction is one actionable message ("typecheck failed: src/a.ts:12
//   ..."). Each has a fingerprint, so the same problem is queued once.
//   Corrections derived from state (source "check" / "review") are resolved,
//   i.e. dropped, as soon as their problem is gone, and a problem that comes
//   back later is queued again ("re-opened"); a problem that stays open is
//   delivered once and never nagged about again. "user" and "agent"
//   corrections stay until cleared (the queue is capped).
//
// The reply (Claude Code hooks, https://code.claude.com/docs/en/hooks)
//   UserPromptSubmit, SessionStart, PostToolUse
//       {"hookSpecificOutput":{"hookEventName":<event>,"additionalContext":<text>}}
//       adds the pending corrections to Claude's context.
//   Stop
//       {"decision":"block","reason":<text>} makes Claude keep going with the
//       reason as its instructions. Only in mode "block", only for error or
//       critical corrections, and at most `maxStopBlocks` times in a row per
//       session (counted in corrections.json, and never past the limit when
//       Claude Code says the stop hook is already active).
//   Anything else, subagent events, and mode "off": no reply.
//
// The mode is the `agents.correct` setting: off | context (default) | block.
//
// Conventions: nothing here prints. Readers never throw; writers throw only
// what the lock and the disk throw. respondToHook() never throws at all: it
// runs inside `tyr hook`, where any failure must mean "say nothing".

import { randomUUID, createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { redactSecrets } from "../core/claude-hooks.js";
import { withTyrLock, type TyrLockOptions } from "../core/lock.js";
import type { FindingSeverity } from "../core/reports.js";
import { readJsonFile, resolveTyrPaths, toJsonDocument, writeFileAtomic } from "../core/scaffold.js";
import { resolveSettings } from "../core/settings.js";
import { CORRECT_MODES, type CorrectMode } from "../core/settings-types.js";
import { compareFindings, SEVERITY_RANK, type EngineFinding } from "../engine/findings.js";
import type { EngineState, Problem } from "../engine/model.js";
import { openProblems, readEngineState } from "../engine/repo-state.js";
import { readFindingsState, type FindingsState } from "../engine/review.js";

export { CORRECT_MODES, type CorrectMode };

/* -------------------------------------------------------------------------
 * Model
 * ---------------------------------------------------------------------- */

/** Where a correction came from. "check" and "review" are derived from engine state. */
export type CorrectionSource = "check" | "review" | "agent" | "user";

export const CORRECTION_SOURCES: readonly CorrectionSource[] = ["check", "review", "agent", "user"];

/** Sources that correctionsFromState() owns: it adds, refreshes and resolves them. */
const DERIVED_SOURCES: ReadonlySet<CorrectionSource> = new Set(["check", "review"]);

export interface Correction {
    id: string;
    createdAt: string;
    /** Only this Claude Code session gets it; absent means any session. */
    sessionId?: string;
    source: CorrectionSource;
    severity: FindingSeverity;
    /** One concise, actionable paragraph (bounded by MAX_CORRECTION_CHARS). */
    message: string;
    /** Dedupe key: one correction per fingerprint. */
    fingerprint: string;
    /** First time it reached a session. */
    deliveredAt?: string;
    /** How many hook replies carried it. */
    deliveries: number;
}

/** What a caller supplies to queue a correction. */
export interface CorrectionInput {
    message: string;
    source?: CorrectionSource;
    severity?: FindingSeverity;
    sessionId?: string;
    /** Default: hash of source + message. */
    fingerprint?: string;
}

export const CORRECTIONS_STATE_VERSION = 1;

export interface SessionCorrectionState {
    /** Stop hooks blocked in a row, reset by a prompt, a session start or a natural stop. */
    stopBlocks: number;
    updatedAt: string;
}

/** Contents of `.tyr/state/corrections.json`. */
export interface CorrectionsState {
    version: typeof CORRECTIONS_STATE_VERSION;
    updatedAt: string;
    corrections: Correction[];
    /** Per Claude Code session id. */
    sessions: Record<string, SessionCorrectionState>;
}

/** Longest single correction message. */
export const MAX_CORRECTION_CHARS = 600;
/** Default bound on the whole text Tyr hands to Claude in one reply. */
export const MAX_REPLY_CHARS = 4000;
/** Corrections kept in the queue; the oldest delivered ones go first. */
export const MAX_QUEUED_CORRECTIONS = 200;
/** Sessions whose stop counter is remembered. */
export const MAX_TRACKED_SESSIONS = 50;
/** Default for how many Stops in a row Tyr may block in one session. */
export const DEFAULT_MAX_STOP_BLOCKS = 2;
/** At most this many review findings become corrections per pass. */
export const MAX_DERIVED_FINDINGS = 10;
/** Check findings quoted in a problem's correction. */
const MAX_LOCATIONS_PER_PROBLEM = 3;
/** Lock wait inside a hook: well under the hook's own deadline. */
export const HOOK_LOCK_TIMEOUT_MS = 1500;

export function emptyCorrectionsState(now: Date = new Date(0)): CorrectionsState {
    return { version: CORRECTIONS_STATE_VERSION, updatedAt: now.toISOString(), corrections: [], sessions: {} };
}

/* -------------------------------------------------------------------------
 * Storage
 * ---------------------------------------------------------------------- */

export function correctionsFile(root: string): string {
    return path.join(resolveTyrPaths(root).stateDir, "corrections.json");
}

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseCorrection(value: unknown): Correction | null {
    if (!isObject(value)) return null;
    const { id, createdAt, source, severity, message, fingerprint } = value;
    if (typeof id !== "string" || typeof createdAt !== "string" || typeof message !== "string") return null;
    if (typeof fingerprint !== "string" || !CORRECTION_SOURCES.includes(source as CorrectionSource)) return null;
    if (typeof severity !== "string" || !(severity in SEVERITY_RANK)) return null;
    const out: Correction = {
        id,
        createdAt,
        source: source as CorrectionSource,
        severity: severity as FindingSeverity,
        message,
        fingerprint,
        deliveries: typeof value.deliveries === "number" && Number.isFinite(value.deliveries) ? value.deliveries : 0,
    };
    if (typeof value.sessionId === "string" && value.sessionId !== "") out.sessionId = value.sessionId;
    if (typeof value.deliveredAt === "string") out.deliveredAt = value.deliveredAt;
    return out;
}

/** The queue, or an empty one when the file is missing, malformed or from another version. Never throws. */
export async function readCorrections(root: string): Promise<CorrectionsState> {
    const read = await readJsonFile(correctionsFile(root));
    if (read.kind !== "ok" || read.value.version !== CORRECTIONS_STATE_VERSION) return emptyCorrectionsState();
    const { updatedAt, corrections, sessions } = read.value;
    const cleanSessions: Record<string, SessionCorrectionState> = {};
    if (isObject(sessions)) {
        for (const [id, entry] of Object.entries(sessions)) {
            if (isObject(entry) && typeof entry.stopBlocks === "number" && typeof entry.updatedAt === "string") {
                cleanSessions[id] = { stopBlocks: entry.stopBlocks, updatedAt: entry.updatedAt };
            }
        }
    }
    return {
        version: CORRECTIONS_STATE_VERSION,
        updatedAt: typeof updatedAt === "string" ? updatedAt : new Date(0).toISOString(),
        corrections: Array.isArray(corrections) ? corrections.map(parseCorrection).filter((c): c is Correction => c !== null) : [],
        sessions: cleanSessions,
    };
}

async function writeCorrections(root: string, state: CorrectionsState): Promise<void> {
    const file = correctionsFile(root);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, toJsonDocument(state));
}

/**
 * Read corrections.json, pass it to `mutate`, and write the (pruned, stamped)
 * result, all under the `.tyr/` lock. `mutate` returns null to leave the file
 * alone. Resolves to the state as stored after the call.
 */
export async function updateCorrections(
    root: string,
    mutate: (state: CorrectionsState) => CorrectionsState | null,
    now: Date = new Date(),
    lockOptions?: TyrLockOptions,
): Promise<CorrectionsState> {
    return withTyrLock(
        root,
        "corrections update",
        async () => {
            const current = await readCorrections(root);
            const next = mutate(current);
            if (next === null) return current;
            const stored = prune({ ...next, version: CORRECTIONS_STATE_VERSION, updatedAt: now.toISOString() });
            await writeCorrections(root, stored);
            return stored;
        },
        lockOptions,
    );
}

/** Cap the queue (oldest delivered first, then oldest) and the session table. */
function prune(state: CorrectionsState): CorrectionsState {
    let corrections = state.corrections;
    if (corrections.length > MAX_QUEUED_CORRECTIONS) {
        const excess = corrections.length - MAX_QUEUED_CORRECTIONS;
        const victims = [...corrections]
            .sort((a, b) => Number(a.deliveredAt === undefined) - Number(b.deliveredAt === undefined) || a.createdAt.localeCompare(b.createdAt))
            .slice(0, excess);
        const drop = new Set(victims.map((c) => c.id));
        corrections = corrections.filter((c) => !drop.has(c.id));
    }
    let sessions = state.sessions;
    const ids = Object.keys(sessions);
    if (ids.length > MAX_TRACKED_SESSIONS) {
        const keep = ids.sort((a, b) => sessions[b]!.updatedAt.localeCompare(sessions[a]!.updatedAt)).slice(0, MAX_TRACKED_SESSIONS);
        sessions = Object.fromEntries(keep.map((id) => [id, state.sessions[id]!]));
    }
    return { ...state, corrections, sessions };
}

/* -------------------------------------------------------------------------
 * Queue API
 * ---------------------------------------------------------------------- */

function oneLine(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

function bound(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** The stored form of a message: one line, secrets masked, bounded. */
export function cleanMessage(text: string): string {
    return bound(redactSecrets(oneLine(text)), MAX_CORRECTION_CHARS);
}

function defaultFingerprint(source: CorrectionSource, message: string): string {
    return createHash("sha1").update(`${source}\u0000${message}`).digest("hex").slice(0, 16);
}

function newCorrection(input: Required<Pick<CorrectionInput, "message">> & CorrectionInput, now: Date): Correction {
    const source = input.source ?? "user";
    const message = cleanMessage(input.message);
    const correction: Correction = {
        id: randomUUID(),
        createdAt: now.toISOString(),
        source,
        severity: input.severity ?? "error",
        message,
        fingerprint: input.fingerprint ?? defaultFingerprint(source, message),
        deliveries: 0,
    };
    if (input.sessionId !== undefined && input.sessionId !== "") correction.sessionId = input.sessionId;
    return correction;
}

export interface QueueOptions {
    now?: Date;
    lockOptions?: TyrLockOptions;
    /**
     * When a correction with the same fingerprint was already delivered,
     * queue it again (reset its delivery). Default false: it stays delivered.
     */
    requeue?: boolean;
}

/**
 * Queue a correction for the next hook reply (source "user" unless given, so
 * `tyr run` or a CLI command can use it as is). Deduped by fingerprint: an
 * undelivered duplicate is refreshed in place, a delivered one is left alone
 * unless `requeue`. Resolves to the stored correction, or null for a blank
 * message.
 */
export async function queueCorrection(root: string, input: CorrectionInput, options: QueueOptions = {}): Promise<Correction | null> {
    if (oneLine(input.message) === "") return null;
    const now = options.now ?? new Date();
    const candidate = newCorrection(input, now);
    let stored: Correction = candidate;
    await updateCorrections(
        root,
        (state) => {
            const existing = state.corrections.find((c) => c.fingerprint === candidate.fingerprint);
            if (existing === undefined) {
                return { ...state, corrections: [...state.corrections, candidate] };
            }
            if (existing.deliveredAt !== undefined && !options.requeue) {
                stored = existing;
                return null;
            }
            const refreshed: Correction = {
                ...existing,
                message: candidate.message,
                severity: candidate.severity,
                ...(options.requeue ? { createdAt: candidate.createdAt } : {}),
            };
            if (options.requeue) delete refreshed.deliveredAt;
            stored = refreshed;
            return { ...state, corrections: state.corrections.map((c) => (c.id === existing.id ? refreshed : c)) };
        },
        now,
        options.lockOptions,
    );
    return stored;
}

/** Most severe first, then oldest. */
export function compareCorrections(a: Correction, b: Correction): number {
    return SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.createdAt.localeCompare(b.createdAt);
}

/** True when `correction` may go to `sessionId` (undefined: any session). */
function forSession(correction: Correction, sessionId: string | undefined): boolean {
    return sessionId === undefined || correction.sessionId === undefined || correction.sessionId === sessionId;
}

/** Undelivered corrections for `sessionId` (all sessions when omitted), most severe first. */
export function pendingIn(state: CorrectionsState, sessionId?: string): Correction[] {
    return state.corrections.filter((c) => c.deliveredAt === undefined && forSession(c, sessionId)).sort(compareCorrections);
}

/** Undelivered corrections for `sessionId`, most severe first. Never throws. */
export async function pendingCorrections(root: string, sessionId?: string): Promise<Correction[]> {
    return pendingIn(await readCorrections(root), sessionId);
}

/** Pure: stamp `ids` as delivered at `now` and count the delivery. */
export function applyDelivered(state: CorrectionsState, ids: readonly string[], now: Date): CorrectionsState {
    const wanted = new Set(ids);
    if (wanted.size === 0) return state;
    return {
        ...state,
        corrections: state.corrections.map((c) =>
            wanted.has(c.id) ? { ...c, deliveredAt: c.deliveredAt ?? now.toISOString(), deliveries: c.deliveries + 1 } : c,
        ),
    };
}

/** Mark corrections delivered. Resolves to how many matched. */
export async function markDelivered(root: string, ids: readonly string[], options: { now?: Date; lockOptions?: TyrLockOptions } = {}): Promise<number> {
    const now = options.now ?? new Date();
    let count = 0;
    await updateCorrections(
        root,
        (state) => {
            const wanted = new Set(ids);
            count = state.corrections.filter((c) => wanted.has(c.id)).length;
            return count === 0 ? null : applyDelivered(state, ids, now);
        },
        now,
        options.lockOptions,
    );
    return count;
}

export interface ClearFilter {
    ids?: readonly string[];
    source?: CorrectionSource;
    /** Only corrections already delivered. */
    deliveredOnly?: boolean;
}

/** Remove corrections (all of them without a filter). Resolves to how many were removed. */
export async function clearCorrections(root: string, filter: ClearFilter = {}, options: { now?: Date; lockOptions?: TyrLockOptions } = {}): Promise<number> {
    const ids = filter.ids === undefined ? null : new Set(filter.ids);
    const matches = (c: Correction): boolean =>
        (ids === null || ids.has(c.id)) &&
        (filter.source === undefined || c.source === filter.source) &&
        (!filter.deliveredOnly || c.deliveredAt !== undefined);
    let removed = 0;
    await updateCorrections(
        root,
        (state) => {
            const kept = state.corrections.filter((c) => !matches(c));
            removed = state.corrections.length - kept.length;
            return removed === 0 ? null : { ...state, corrections: kept };
        },
        options.now,
        options.lockOptions,
    );
    return removed;
}

/* -------------------------------------------------------------------------
 * Derivation from engine state
 * ---------------------------------------------------------------------- */

/** A correction derived from state: always has its fingerprint. */
export interface DerivedCorrection {
    source: "check" | "review";
    severity: FindingSeverity;
    message: string;
    fingerprint: string;
}

export interface DerivedCorrections {
    corrections: DerivedCorrection[];
    /**
     * The sources this derivation speaks for: existing corrections of these
     * sources that it did not produce are resolved. "review" is absent when
     * findings.json could not be read, so a missing file resolves nothing.
     */
    authoritative: Array<"check" | "review">;
}

function location(finding: Pick<EngineFinding, "file" | "line">): string {
    if (finding.file === undefined) return "";
    return finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`;
}

function describeFinding(finding: EngineFinding): string {
    const where = location(finding);
    return where === "" ? oneLine(finding.title) : `${where} ${oneLine(finding.title)}`;
}

function problemMessage(problem: Problem, state: EngineState, findings: readonly EngineFinding[]): string {
    const parts: string[] = [problem.title || `${problem.kind} failed`];
    if (problem.regression) parts[0] += " (a regression: it passed before)";

    const related = findings.filter((f) => f.source === "check" && f.checkKind === problem.kind).sort(compareFindings);
    let body: string;
    if (related.length > 0) {
        body = related.slice(0, MAX_LOCATIONS_PER_PROBLEM).map(describeFinding).join("; ");
        if (related.length > MAX_LOCATIONS_PER_PROBLEM) body += `; +${related.length - MAX_LOCATIONS_PER_PROBLEM} more`;
    } else {
        const lines = (problem.detail ?? "")
            .split(/\r?\n/)
            .map(oneLine)
            .filter((l) => l !== "");
        body = lines.slice(-3).join(" | ");
    }
    const command = state.checks[problem.kind]?.last?.command;
    let message = body === "" ? `${parts[0]}.` : `${parts[0]}: ${body}.`;
    if (command) message += ` Reproduce with \`${oneLine(command)}\`.`;
    return message;
}

/**
 * Pure: corrections for the current open problems and the error/critical
 * review findings. Problems are keyed by the run that opened them, so a
 * problem that closes and opens again is a new correction. A failing check
 * that never passed is a "warning" (pre-existing); a regression is an "error".
 * Check findings are folded into their problem's message for file:line
 * detail rather than queued one by one.
 */
export function deriveCorrections(engine: EngineState, findings: FindingsState | null): DerivedCorrections {
    const all = findings?.findings ?? [];
    const corrections: DerivedCorrection[] = openProblems(engine).map((problem) => ({
        source: "check",
        severity: problem.regression ? "error" : "warning",
        message: cleanMessage(problemMessage(problem, engine, all)),
        fingerprint: `problem:${problem.key}:${problem.firstSeenRunId}`,
    }));

    if (findings !== null) {
        const serious = all
            .filter((f) => f.source !== "check" && SEVERITY_RANK[f.severity] >= SEVERITY_RANK.error)
            .sort(compareFindings)
            .slice(0, MAX_DERIVED_FINDINGS);
        const seen = new Set<string>();
        for (const finding of serious) {
            const fingerprint = `finding:${finding.fingerprint}`;
            if (seen.has(fingerprint)) continue;
            seen.add(fingerprint);
            const detail = finding.detail === undefined ? "" : ` ${oneLine(finding.detail)}`;
            corrections.push({
                source: "review",
                severity: finding.severity,
                message: cleanMessage(`${describeFinding(finding)}.${detail}`),
                fingerprint,
            });
        }
    }

    return { corrections, authoritative: findings === null ? ["check"] : ["check", "review"] };
}

/**
 * Pure: fold a derivation into the queue. New fingerprints are queued;
 * undelivered ones are refreshed; delivered ones are left alone (no nagging);
 * derived corrections whose problem is gone are dropped. `changed` is false
 * when the result equals the input.
 */
export function syncDerived(
    state: CorrectionsState,
    derived: DerivedCorrections,
    now: Date,
): { state: CorrectionsState; changed: boolean; added: Correction[]; resolved: Correction[] } {
    const authoritative = new Set<CorrectionSource>(derived.authoritative);
    const byFingerprint = new Map(derived.corrections.map((c) => [c.fingerprint, c]));
    const existing = new Set(state.corrections.map((c) => c.fingerprint));
    const resolved: Correction[] = [];
    let changed = false;

    const kept: Correction[] = [];
    for (const correction of state.corrections) {
        const fresh = byFingerprint.get(correction.fingerprint);
        if (fresh === undefined) {
            if (DERIVED_SOURCES.has(correction.source) && authoritative.has(correction.source)) {
                resolved.push(correction);
                changed = true;
                continue;
            }
            kept.push(correction);
            continue;
        }
        if (correction.deliveredAt === undefined && (correction.message !== fresh.message || correction.severity !== fresh.severity)) {
            kept.push({ ...correction, message: fresh.message, severity: fresh.severity });
            changed = true;
        } else {
            kept.push(correction);
        }
    }

    const added = derived.corrections.filter((c) => !existing.has(c.fingerprint)).map((c) => newCorrection(c, now));
    if (added.length > 0) changed = true;

    return { state: changed ? { ...state, corrections: [...kept, ...added] } : state, changed, added, resolved };
}

export interface FromStateOptions {
    now?: Date;
    lockOptions?: TyrLockOptions;
}

/**
 * Derive corrections from `.tyr/state/engine.json` and findings.json and
 * fold them into the queue (see syncDerived). Writes only when something
 * changed. Resolves to what was added and resolved.
 */
export async function correctionsFromState(root: string, options: FromStateOptions = {}): Promise<{ added: Correction[]; resolved: Correction[] }> {
    const now = options.now ?? new Date();
    const derived = await readDerived(root);
    let result: { added: Correction[]; resolved: Correction[] } = { added: [], resolved: [] };
    await updateCorrections(
        root,
        (state) => {
            const synced = syncDerived(state, derived, now);
            result = { added: synced.added, resolved: synced.resolved };
            return synced.changed ? synced.state : null;
        },
        now,
        options.lockOptions,
    );
    return result;
}

async function readDerived(root: string): Promise<DerivedCorrections> {
    const [engine, findings] = await Promise.all([readEngineState(root), readFindingsState(root)]);
    return deriveCorrections(engine, findings);
}

/* -------------------------------------------------------------------------
 * Hook replies
 * ---------------------------------------------------------------------- */

/** Hook events Tyr may answer. */
export const CONTEXT_EVENTS: ReadonlySet<string> = new Set(["UserPromptSubmit", "SessionStart", "PostToolUse"]);
export const RESPONDING_EVENTS: ReadonlySet<string> = new Set([...CONTEXT_EVENTS, "Stop"]);

/** JSON Tyr prints on stdout for Claude Code. */
export type HookOutput = { decision: "block"; reason: string } | { hookSpecificOutput: { hookEventName: string; additionalContext: string } };

export interface HookResponseOptions {
    mode: CorrectMode;
    /** Stops already blocked in a row in this session. Default 0. */
    consecutiveStopBlocks?: number;
    /** Default DEFAULT_MAX_STOP_BLOCKS. */
    maxStopBlocks?: number;
    /** Bound on the reply text. Default MAX_REPLY_CHARS. */
    maxChars?: number;
}

export interface HookPlan {
    output: HookOutput;
    /** Ids of the corrections the text carries. */
    delivered: string[];
    /** True for a Stop block. */
    blocked: boolean;
}

function payloadObject(payload: unknown): Record<string, unknown> {
    return isObject(payload) ? payload : {};
}

/**
 * Lines for `corrections` under a heading and above a footer, never longer
 * than `maxChars`: items that do not fit are summarized as "+N more".
 * Returns the text and the ids it mentions.
 */
export function formatCorrections(
    corrections: readonly Correction[],
    heading: string,
    footer: string,
    maxChars: number = MAX_REPLY_CHARS,
): { text: string; ids: string[] } {
    const ids: string[] = [];
    const lines: string[] = [];
    // Room reserved for the heading, footer, and a "+N more" line.
    const reserve = heading.length + footer.length + 80;
    let used = reserve;
    for (const correction of corrections) {
        const line = `- [${correction.severity}] ${correction.message}`;
        const room = maxChars - used - 1;
        if (room < 40) break;
        const fitted = bound(line, room);
        lines.push(fitted);
        ids.push(correction.id);
        used += fitted.length + 1;
    }
    const rest = corrections.length - ids.length;
    if (rest > 0) lines.push(`- +${rest} more (run \`tyr status\`)`);
    const text = [heading, ...lines, footer].join("\n");
    return { text: bound(text, maxChars), ids };
}

function isSubagentPayload(payload: Record<string, unknown>): boolean {
    return typeof payload.agent_id === "string" && payload.agent_id !== "";
}

/**
 * Pure: what to answer `event` with, given the corrections to mention.
 * Null means print nothing. See the header for the rules.
 */
export function planHookResponse(event: string, payload: unknown, corrections: readonly Correction[], options: HookResponseOptions): HookPlan | null {
    const data = payloadObject(payload);
    if (options.mode === "off" || corrections.length === 0 || isSubagentPayload(data)) return null;
    const maxChars = Math.max(200, options.maxChars ?? MAX_REPLY_CHARS);

    if (event === "Stop") {
        if (options.mode !== "block") return null;
        const max = options.maxStopBlocks ?? DEFAULT_MAX_STOP_BLOCKS;
        let streak = Math.max(0, options.consecutiveStopBlocks ?? 0);
        // Claude is already continuing because of a stop hook: count that.
        if (data.stop_hook_active === true) streak = Math.max(streak, 1);
        if (streak >= max) return null;
        const serious = corrections.filter((c) => SEVERITY_RANK[c.severity] >= SEVERITY_RANK.error);
        if (serious.length === 0) return null;
        const { text, ids } = formatCorrections(
            [...corrections].sort(compareCorrections),
            "Tyr (this repository's background checker) found problems that should be fixed before you finish:",
            "Fix them, or tell the user why they cannot be fixed now, then finish. " + `Tyr holds a stop at most ${max} time${max === 1 ? "" : "s"} in a row.`,
            maxChars,
        );
        return { output: { decision: "block", reason: text }, delivered: ids, blocked: true };
    }

    if (!CONTEXT_EVENTS.has(event)) return null;
    const { text, ids } = formatCorrections(
        [...corrections].sort(compareCorrections),
        event === "SessionStart"
            ? "Tyr (this repository's background checker) reports open problems in the working tree:"
            : "Tyr (this repository's background checker) found new problems in the working tree:",
        "If they relate to your current work, fix them; otherwise mention them to the user rather than ignoring them.",
        maxChars,
    );
    return {
        output: { hookSpecificOutput: { hookEventName: event, additionalContext: text } },
        delivered: ids,
        blocked: false,
    };
}

/** Pure: the JSON object to print for `event`, or null. */
export function hookResponse(event: string, payload: unknown, pending: readonly Correction[], options: HookResponseOptions): HookOutput | null {
    return planHookResponse(event, payload, pending, options)?.output ?? null;
}

/* -------------------------------------------------------------------------
 * The hook handler's entry point
 * ---------------------------------------------------------------------- */

export interface RespondDeps {
    /** Default: the resolved `agents.correct` setting. */
    mode?: CorrectMode;
    now?: () => Date;
    /** Default: { timeoutMs: HOOK_LOCK_TIMEOUT_MS }. */
    lockOptions?: TyrLockOptions;
    maxStopBlocks?: number;
    maxChars?: number;
    /** Default: read engine.json + findings.json and deriveCorrections(). */
    derive?: (root: string) => Promise<DerivedCorrections>;
    /** Default: process.env, for resolving the mode. */
    env?: NodeJS.ProcessEnv;
}

/**
 * Pure step behind respondToHook: sync the derivation, pick what to mention,
 * plan the reply, and apply deliveries and the session's stop counter.
 */
export function stepHook(
    state: CorrectionsState,
    derived: DerivedCorrections,
    payload: unknown,
    options: HookResponseOptions,
    now: Date,
): { state: CorrectionsState; changed: boolean; plan: HookPlan | null } {
    const data = payloadObject(payload);
    const event = typeof data.hook_event_name === "string" ? data.hook_event_name : "";
    const sessionId = typeof data.session_id === "string" && data.session_id !== "" ? data.session_id : undefined;

    const synced = syncDerived(state, derived, now);
    let next = synced.state;
    let changed = synced.changed;

    // A new session hears about everything still open; otherwise only what it has not heard.
    const mention = event === "SessionStart" ? next.corrections.filter((c) => forSession(c, sessionId)).sort(compareCorrections) : pendingIn(next, sessionId);
    const streak = sessionId === undefined ? 0 : (next.sessions[sessionId]?.stopBlocks ?? 0);
    const plan = planHookResponse(event, payload, mention, { ...options, consecutiveStopBlocks: streak });

    if (plan !== null && plan.delivered.length > 0) {
        next = applyDelivered(next, plan.delivered, now);
        changed = true;
    }

    if (sessionId !== undefined && !isSubagentPayload(data)) {
        const sessions = { ...next.sessions };
        const had = sessions[sessionId] !== undefined;
        if (event === "Stop" && plan?.blocked) {
            const base = data.stop_hook_active === true ? Math.max(streak, 1) : streak;
            sessions[sessionId] = { stopBlocks: base + 1, updatedAt: now.toISOString() };
            next = { ...next, sessions };
            changed = true;
        } else if (had && (event === "UserPromptSubmit" || event === "SessionStart" || (event === "Stop" && data.stop_hook_active !== true))) {
            delete sessions[sessionId];
            next = { ...next, sessions };
            changed = true;
        }
    }

    return { state: next, changed, plan };
}

/**
 * Answer one Claude Code hook payload for an initialized project: the JSON to
 * print, or null to print nothing. Never throws (any failure is null).
 *
 * Fast path: events Tyr never answers return before any I/O, and a payload
 * that changes nothing returns without taking the lock.
 */
export async function respondToHook(root: string, payload: unknown, deps: RespondDeps = {}): Promise<HookOutput | null> {
    try {
        const data = payloadObject(payload);
        const event = typeof data.hook_event_name === "string" ? data.hook_event_name : "";
        if (!RESPONDING_EVENTS.has(event) || isSubagentPayload(data)) return null;

        const mode = deps.mode ?? (await resolveSettings({ root, env: deps.env })).settings.agents.correct;
        if (mode === "off") return null;

        const now = (deps.now ?? (() => new Date()))();
        const derive = deps.derive ?? readDerived;
        const derived = await derive(root);
        const options: HookResponseOptions = { mode, maxStopBlocks: deps.maxStopBlocks, maxChars: deps.maxChars };

        // Dry run without the lock: most tool calls change nothing.
        const preview = stepHook(await readCorrections(root), derived, payload, options, now);
        if (!preview.changed) return preview.plan?.output ?? null;

        let plan: HookPlan | null = null;
        await updateCorrections(
            root,
            (state) => {
                const step = stepHook(state, derived, payload, options, now);
                plan = step.plan;
                return step.changed ? step.state : null;
            },
            now,
            deps.lockOptions ?? { timeoutMs: HOOK_LOCK_TIMEOUT_MS },
        );
        return (plan as HookPlan | null)?.output ?? null;
    } catch {
        return null;
    }
}
