// cli/integrations/notify.ts — deliver notifications to the user's targets
// (PLANNING.md 2.15, setting `notifications.targets`).
//
// Targets:
//   terminal  journaled as a `notification` event; `tyr watch` shows it
//             highlighted and rings the terminal bell. The daemon has no
//             terminal of its own, so the journal is how it reaches one.
//   desktop   a native OS notification (cli/integrations/desktop.ts)
//
// Every notification is journaled, whatever the targets, so `tyr watch`
// and the history always show what Tyr said and where it went; the event's
// `data.targets` says whether a terminal should ring for it.
//
// Other spellings in the setting (`slack`, `webhook:https://…`) are reported
// as unsupported and skipped: Slack and webhooks are not built yet.
//
// A Notifier deduplicates: the same `key` is not delivered again within the
// cooldown, and at most `maxPerWindow` notifications go out per window, so a
// flapping check cannot flood the desktop. Nothing here throws.

import { appendEvent, type TyrEvent } from "../core/events.js";
import { showDesktopNotification, type DesktopResult, type ShowDesktopOptions } from "./desktop.js";

export type NotifyTarget = "terminal" | "desktop";
export const NOTIFY_TARGETS: readonly NotifyTarget[] = ["terminal", "desktop"];

export type NotificationSeverity = "info" | "warning" | "error";

export interface TyrNotification {
    title: string;
    message: string;
    severity: NotificationSeverity;
    /** Dedupe identity: the same key within the cooldown is dropped. */
    key: string;
    /** Extra structured data recorded with the journal event. */
    data?: Record<string, unknown>;
}

/** The `notification` event kind in the journal. */
export const NOTIFICATION_EVENT_KIND = "notification";

export const DEFAULT_COOLDOWN_MS = 10 * 60_000;
export const DEFAULT_WINDOW_MS = 60_000;
export const DEFAULT_MAX_PER_WINDOW = 5;

export interface ParsedTargets {
    targets: NotifyTarget[];
    /** Entries Tyr cannot deliver to (yet), as written. */
    unsupported: string[];
}

/** Normalize the setting: lower-case, deduplicated, known targets first-seen order. */
export function parseTargets(raw: readonly string[]): ParsedTargets {
    const targets: NotifyTarget[] = [];
    const unsupported: string[] = [];
    for (const entry of raw) {
        const value = entry.trim().toLowerCase();
        if (value === "") continue;
        if ((NOTIFY_TARGETS as readonly string[]).includes(value)) {
            if (!targets.includes(value as NotifyTarget)) targets.push(value as NotifyTarget);
        } else if (!unsupported.includes(entry.trim())) {
            unsupported.push(entry.trim());
        }
    }
    return { targets, unsupported };
}

export type TargetResult = { target: string; ok: true } | { target: string; ok: false; reason: string };

export interface DeliveryResult {
    /** False when dropped by dedupe or the rate limit (nothing was sent). */
    sent: boolean;
    dropped?: "duplicate" | "rate-limited" | "no-targets";
    results: TargetResult[];
    event: TyrEvent | null;
}

export interface DeliverDeps {
    /** Journal writer; default appendEvent. */
    journal?: (root: string, input: Parameters<typeof appendEvent>[1]) => Promise<TyrEvent | null>;
    /** Desktop delivery; default showDesktopNotification. */
    desktop?: (note: { title: string; message: string; urgency?: "low" | "normal" | "critical" }, options?: ShowDesktopOptions) => Promise<DesktopResult>;
    desktopOptions?: ShowDesktopOptions;
}

/**
 * Send one notification to `targets` now, without dedupe. Desktop delivery
 * happens first so the journal event can record whether it worked.
 */
export async function deliverNotification(
    root: string,
    note: TyrNotification,
    rawTargets: readonly string[],
    deps: DeliverDeps = {},
): Promise<DeliveryResult> {
    const { targets, unsupported } = parseTargets(rawTargets);
    const results: TargetResult[] = [];
    if (targets.includes("desktop")) {
        const show = deps.desktop ?? showDesktopNotification;
        let outcome: DesktopResult;
        try {
            outcome = await show(
                { title: note.title, message: note.message, urgency: note.severity === "error" ? "critical" : "normal" },
                deps.desktopOptions,
            );
        } catch (error) {
            outcome = { ok: false, reason: error instanceof Error ? error.message : String(error) };
        }
        results.push(outcome.ok ? { target: "desktop", ok: true } : { target: "desktop", ok: false, reason: outcome.reason });
    }
    if (targets.includes("terminal")) results.push({ target: "terminal", ok: true });
    for (const entry of unsupported) results.push({ target: entry, ok: false, reason: "not supported yet (terminal and desktop are)" });

    const journal = deps.journal ?? appendEvent;
    let event: TyrEvent | null = null;
    try {
        event = await journal(root, {
            source: "tyr",
            kind: NOTIFICATION_EVENT_KIND,
            message: `${note.title}: ${note.message}`,
            data: {
                title: note.title,
                body: note.message,
                severity: note.severity,
                key: note.key,
                targets,
                delivered: results.filter((r) => r.ok).map((r) => r.target),
                failed: results.filter((r): r is Extract<TargetResult, { ok: false }> => !r.ok).map((r) => ({ target: r.target, reason: r.reason })),
                ...(note.data ?? {}),
            },
        });
    } catch {
        event = null;
    }
    // Terminal delivery *is* the journal event.
    if (targets.includes("terminal") && event === null) {
        const index = results.findIndex((r) => r.target === "terminal");
        results[index] = { target: "terminal", ok: false, reason: "could not write the event journal" };
    }
    return { sent: true, results, event };
}

export interface NotifierOptions extends DeliverDeps {
    /** Read the targets at send time, so a `tyr config set` applies without a restart. */
    targets: () => Promise<readonly string[]>;
    cooldownMs?: number;
    windowMs?: number;
    maxPerWindow?: number;
    now?: () => number;
    /** Told about failed targets (the daemon logs them). */
    onFailure?: (result: Extract<TargetResult, { ok: false }>, note: TyrNotification) => void;
}

export interface Notifier {
    notify(note: TyrNotification): Promise<DeliveryResult>;
}

/** A deduplicating, rate-limited sender for long-lived processes (the daemon). */
export function createNotifier(root: string, options: NotifierOptions): Notifier {
    const cooldown = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    const maxPerWindow = options.maxPerWindow ?? DEFAULT_MAX_PER_WINDOW;
    const now = options.now ?? Date.now;
    const lastByKey = new Map<string, number>();
    let recent: number[] = [];
    const reportedFailures = new Set<string>();

    return {
        async notify(note) {
            const at = now();
            for (const [key, ts] of lastByKey) if (at - ts >= cooldown) lastByKey.delete(key);
            if (lastByKey.has(note.key)) return { sent: false, dropped: "duplicate", results: [], event: null };
            recent = recent.filter((ts) => at - ts < windowMs);
            if (recent.length >= maxPerWindow) return { sent: false, dropped: "rate-limited", results: [], event: null };

            let raw: readonly string[];
            try {
                raw = await options.targets();
            } catch {
                raw = [];
            }
            if (raw.length === 0) return { sent: false, dropped: "no-targets", results: [], event: null };

            lastByKey.set(note.key, at);
            recent.push(at);
            const result = await deliverNotification(root, note, raw, options);
            for (const r of result.results) {
                if (r.ok) {
                    reportedFailures.delete(r.target);
                    continue;
                }
                // Log a broken target once until it works again, not on every notification.
                if (reportedFailures.has(r.target)) continue;
                reportedFailures.add(r.target);
                try {
                    options.onFailure?.(r, note);
                } catch {
                    // Observer only.
                }
            }
            return result;
        },
    };
}
