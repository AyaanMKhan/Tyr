// Engine event bus (PLANNING.md 2.10, cli/engine/ENGINE.md).
//
// The journal (`.tyr/state/events.jsonl`, cli/core/events.ts) is the single
// source of truth for what happened. This module gives the engine a typed
// view of it:
//
//   journal ──followEvents──▶ normalizeEvent ──▶ EventBus.dispatch ──▶ handlers
//
// normalizeEvent is a pure mapping from a TyrEvent to the EngineEvent union
// in model.ts. It validates the payload it reads; anything it does not
// recognise, and any payload that does not have the expected shape, becomes
// `{ type: "other" }`. Every engine event keeps the journal event as `raw`,
// so nothing is lost by normalization.
//
// EventBus is an in-process fan-out. Handlers may be sync or async; a handler
// that throws or returns a rejected promise is reported to the optional
// `onError` hook and never affects other handlers or the dispatcher. Handlers
// run in subscription order; one unsubscribed during a dispatch is not called
// for the rest of it, one subscribed during a dispatch first sees the next
// event.
//
// publish() only appends to the journal; it deliberately does NOT dispatch
// locally. The journal follower attached with attachJournal delivers the
// event back to the bus like any other appender's, so every subscriber sees
// one ordering — the journal's — whether an event came from this process,
// the CLI, a Claude Code hook or the file watcher. Dispatching locally too
// would deliver our own events twice, or out of order relative to events
// other processes appended in between. The cost is the follower's latency.
//
// Public API:
//   normalizeEvent(event)               -> EngineEvent                 pure, never throws
//   new EventBus({ onError? })          .subscribe(filter, handler) -> unsubscribe
//                                       .dispatch(engineEvent)
//   attachJournal(root, bus, opts?)     -> Promise<JournalDetach>      never throws
//   publish(root, input, opts?)         -> Promise<TyrEvent | null>    never throws
//
// Like cli/core this module never prints and never throws for normal
// conditions.

import {
    appendEvent,
    type AppendEventOptions,
    type TyrEvent,
    type TyrEventInput,
} from "../core/events.js";
import { followEvents, type FollowEventsOptions } from "../core/event-stream.js";
import {
    CHECK_FAILED_KIND,
    CHECK_KINDS,
    CHECK_PASSED_KIND,
    type CheckOutcome,
    type CheckReason,
    type CheckRun,
    type ClaudeToolEvent,
    type EngineEvent,
    type EngineEventType,
} from "./model.js";

/* -------------------------------------------------------------------------
 * Normalization
 * ---------------------------------------------------------------------- */

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string, or null for anything else (missing, wrong type). */
function strOrNull(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}

/** A list of strings; undefined when missing, null when malformed. */
function stringList(value: unknown): string[] | undefined | null {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;
    return [...value];
}

const CHECK_OUTCOMES: readonly CheckOutcome[] = ["passed", "failed", "timeout", "error", "cancelled"];
const CHECK_REASONS: readonly CheckReason[] = ["idle", "commit", "claude-stop", "manual", "startup"];

/** Structural check of a CheckRun as journaled in check.passed / check.failed data.run. */
function isCheckRun(value: unknown): value is CheckRun {
    if (!isObject(value)) return false;
    const v = value;
    const trigger = v.trigger;
    return (
        typeof v.id === "string" &&
        typeof v.kind === "string" &&
        (CHECK_KINDS as readonly string[]).includes(v.kind) &&
        typeof v.command === "string" &&
        typeof v.cwd === "string" &&
        isObject(trigger) &&
        typeof trigger.reason === "string" &&
        (CHECK_REASONS as readonly string[]).includes(trigger.reason) &&
        (trigger.eventId === undefined || typeof trigger.eventId === "string") &&
        typeof v.startedAt === "string" &&
        typeof v.finishedAt === "string" &&
        typeof v.durationMs === "number" &&
        typeof v.outcome === "string" &&
        (CHECK_OUTCOMES as readonly string[]).includes(v.outcome) &&
        (v.exitCode === null || typeof v.exitCode === "number") &&
        (v.signal === null || typeof v.signal === "string") &&
        typeof v.stdout === "string" &&
        typeof v.stderr === "string" &&
        typeof v.outputTruncated === "boolean" &&
        (v.error === undefined || typeof v.error === "string") &&
        (v.headCommit === null || typeof v.headCommit === "string")
    );
}

function normalizeFileChanged(base: Base, data: Json): EngineEvent {
    const added = stringList(data.added);
    const modified = stringList(data.modified);
    const removed = stringList(data.removed);
    if (added === null || modified === null || removed === null) return other(base);
    if (added === undefined && modified === undefined && removed === undefined) return other(base);
    const lists = { added: added ?? [], modified: modified ?? [], removed: removed ?? [] };
    const listed = lists.added.length + lists.modified.length + lists.removed.length;
    // Lists are capped in the journal (FS_EVENT_MAX_PATHS); total is the real count.
    const total =
        typeof data.total === "number" && Number.isFinite(data.total) ? Math.max(data.total, listed) : listed;
    return { ...base, type: "file.changed", ...lists, total, cause: data.cause === "git" ? "git" : "edit" };
}

function normalizeGitHead(base: Base, data: Json): EngineEvent {
    if (data.commitChanged !== true) return other(base);
    const current = data.current;
    if (!isObject(current)) return other(base);
    const previous = isObject(data.previous) ? data.previous : {};
    return {
        ...base,
        type: "commit.made",
        commit: strOrNull(current.commit),
        previousCommit: strOrNull(previous.commit),
        branch: strOrNull(current.branch),
        branchChanged: data.branchChanged === true,
    };
}

function normalizeClaudeTool(base: Base, data: Json, phase: "use" | "result"): EngineEvent {
    const event: ClaudeToolEvent = {
        ...base,
        type: "claude.tool",
        phase,
        sessionId: strOrNull(data.sessionId),
        tool: strOrNull(data.tool),
    };
    if (phase === "result" && typeof data.success === "boolean") event.success = data.success;
    return event;
}

type Base = { id: string; ts: string; raw: TyrEvent };

function other(base: Base): EngineEvent {
    return { ...base, type: "other" };
}

/**
 * Map a journal event to an engine event. Pure; never throws. Unknown kinds
 * and malformed payloads become `{ type: "other" }` with `raw` attached.
 */
export function normalizeEvent(event: TyrEvent): EngineEvent {
    const base: Base = {
        id: typeof event?.id === "string" ? event.id : "",
        ts: typeof event?.ts === "string" ? event.ts : "",
        raw: event,
    };
    try {
        const data = event?.data;
        if (!isObject(data)) return other(base);
        switch (event.kind) {
            case "fs.changed":
                return normalizeFileChanged(base, data);
            case "git.head":
                return normalizeGitHead(base, data);
            case "claude.tool_use":
                return normalizeClaudeTool(base, data, "use");
            case "claude.tool_result":
                return normalizeClaudeTool(base, data, "result");
            case "claude.stop":
            case "claude.session_end":
                return {
                    ...base,
                    type: "claude.stop",
                    sessionId: strOrNull(data.sessionId),
                    sessionEnded: event.kind === "claude.session_end",
                };
            case CHECK_PASSED_KIND:
            case CHECK_FAILED_KIND:
                return isCheckRun(data.run) ? { ...base, type: "check.result", run: data.run } : other(base);
            default:
                return other(base);
        }
    } catch {
        // Getters or proxies in a hand-built event; the journal never produces these.
        return other(base);
    }
}

/* -------------------------------------------------------------------------
 * Bus
 * ---------------------------------------------------------------------- */

/** The event type(s) a subscription receives; "*" is every event. */
export type EventFilter = EngineEventType | "*" | readonly EngineEventType[];

/** Narrows the handler's event to the subscribed type. */
export type EventOfType<T extends EngineEventType> = Extract<EngineEvent, { type: T }>;

export type EventHandler<E extends EngineEvent = EngineEvent> = (event: E) => void | Promise<void>;

export interface EventBusOptions {
    /**
     * Called when a handler throws or its promise rejects. Exceptions from
     * onError itself are swallowed.
     */
    onError?: (error: unknown, event: EngineEvent) => void;
}

interface Subscription {
    matches: (type: EngineEventType) => boolean;
    handler: EventHandler;
    active: boolean;
}

export class EventBus {
    private subscriptions: Subscription[] = [];
    private readonly onError?: (error: unknown, event: EngineEvent) => void;

    constructor(options: EventBusOptions = {}) {
        this.onError = options.onError;
    }

    /** Subscribe to one type, a list of types, or "*". Returns an idempotent unsubscribe. */
    subscribe<T extends EngineEventType>(filter: T, handler: EventHandler<EventOfType<T>>): () => void;
    subscribe<T extends EngineEventType>(filter: readonly T[], handler: EventHandler<EventOfType<T>>): () => void;
    subscribe(filter: "*", handler: EventHandler): () => void;
    subscribe(filter: EventFilter, handler: EventHandler<never>): () => void {
        let matches: (type: EngineEventType) => boolean;
        if (filter === "*") {
            matches = () => true;
        } else if (typeof filter === "string") {
            matches = (type) => type === filter;
        } else {
            const types = new Set<EngineEventType>(filter);
            matches = (type) => types.has(type);
        }
        const subscription: Subscription = { matches, handler: handler as EventHandler, active: true };
        this.subscriptions = [...this.subscriptions, subscription];
        return () => {
            if (!subscription.active) return;
            subscription.active = false;
            this.subscriptions = this.subscriptions.filter((s) => s !== subscription);
        };
    }

    /** Number of active subscriptions (for diagnostics and tests). */
    get size(): number {
        return this.subscriptions.length;
    }

    /**
     * Deliver an event to every matching handler, synchronously and in
     * subscription order. Never throws; async handlers are not awaited.
     */
    dispatch(event: EngineEvent): void {
        // Snapshot: subscribe() during dispatch takes effect from the next event.
        for (const subscription of this.subscriptions) {
            if (!subscription.active || !subscription.matches(event.type)) continue;
            try {
                const result = subscription.handler(event);
                if (isPromiseLike(result)) {
                    result.then(undefined, (error: unknown) => this.report(error, event));
                }
            } catch (error) {
                this.report(error, event);
            }
        }
    }

    private report(error: unknown, event: EngineEvent): void {
        try {
            this.onError?.(error, event);
        } catch {
            // A broken error hook must not break dispatch either.
        }
    }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
    return (
        (typeof value === "object" || typeof value === "function") &&
        value !== null &&
        typeof (value as { then?: unknown }).then === "function"
    );
}

/* -------------------------------------------------------------------------
 * Journal bridge
 * ---------------------------------------------------------------------- */

export type AttachJournalOptions = Omit<FollowEventsOptions, "onEvent">;

/**
 * Stops the follower. Idempotent; the promise resolves once the journal file
 * handle is released. Nothing is dispatched after it is called.
 */
export type JournalDetach = () => Promise<void>;

/**
 * Follow the project's journal and dispatch every event, normalized, into
 * `bus`. Options pass through to followEvents: `since` / `backlog` replay
 * history before going live, `signal` aborts like the returned detach,
 * `sources` / `kinds` filter at the journal level. Never throws.
 */
export async function attachJournal(
    root: string,
    bus: EventBus,
    opts: AttachJournalOptions = {},
): Promise<JournalDetach> {
    let closed = false;
    const follower = await followEvents(root, {
        ...opts,
        onEvent: (event) => {
            if (!closed) bus.dispatch(normalizeEvent(event));
        },
    });
    return () => {
        closed = true;
        follower.close();
        return follower.done;
    };
}

/**
 * Append an event to the journal. It is NOT dispatched locally: the journal
 * follower (attachJournal) delivers it, so all subscribers see the journal's
 * single ordering (see the header). Resolves to the stored event, or null if
 * it could not be written. Never throws.
 */
export function publish(root: string, input: TyrEventInput, opts?: AppendEventOptions): Promise<TyrEvent | null> {
    return appendEvent(root, input, opts);
}
