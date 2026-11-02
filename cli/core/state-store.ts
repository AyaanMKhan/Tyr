// The only place that read-modify-writes `.tyr/state/state.json` after init.
//
// Every update runs under withTyrLock(), so `tyr stop`'s cleanup, the
// daemon's own shutdown and `tyr init --force` cannot overwrite each other's
// changes. Lifecycle transitions are named functions with their guards built
// in, rather than ad-hoc `{ ...state, status }` spreads at each call site.
//
// Status lifecycle:
//   initialized --markRunning--> running --markStopped--> stopped
//                                    \-----markError----> error
//   stopped / error --markRunning--> running   (a new run)

import { withTyrLock, type TyrLockOptions } from "./lock.js";
import { readState, writeState } from "./scaffold.js";
import type { TyrState } from "./types.js";

/**
 * Read state.json, pass it to `mutate`, and write the result, all under the
 * `.tyr/` lock. `mutate` returns null to leave the file untouched.
 *
 * Returns the state as stored after the call (the old one when `mutate`
 * declined), or null when there is no readable state.json at all.
 */
export async function updateState(
    root: string,
    mutate: (state: TyrState) => TyrState | null,
    owner = "state update",
    lockOptions?: TyrLockOptions,
): Promise<TyrState | null> {
    return withTyrLock(
        root,
        owner,
        async () => {
            const current = await readState(root);
            if (current === null) return null;
            const next = mutate(current);
            if (next === null) return current;
            await writeState(root, next);
            // writeState stamps updatedAt; read back so callers see what is on disk.
            return (await readState(root)) ?? next;
        },
        lockOptions,
    );
}

/**
 * updateState() for a guarded transition: resolves to the new state when the
 * transition applied, or null when there was no state or the guard refused.
 */
async function transition(
    root: string,
    owner: string,
    mutate: (state: TyrState) => TyrState | null,
): Promise<TyrState | null> {
    let applied = false;
    const result = await updateState(
        root,
        (state) => {
            const next = mutate(state);
            applied = next !== null;
            return next;
        },
        owner,
    );
    return applied ? result : null;
}

function nextRunCount(state: TyrState): number {
    return (typeof state.runCount === "number" && Number.isFinite(state.runCount) ? state.runCount : 0) + 1;
}

/** A background process with `pid` has started: one more run. */
export function markRunning(root: string, pid: number, at: Date = new Date()): Promise<TyrState | null> {
    const startedAt = at.toISOString();
    return transition(root, "daemon start", (state) => ({
        ...state,
        status: "running",
        pid,
        startedAt,
        runCount: nextRunCount(state),
        lastRunAt: startedAt,
    }));
}

export interface EndRunGuard {
    /**
     * The pid whose run is ending. The transition is refused when state.json
     * says a *different* pid is running, so a daemon shutting down late cannot
     * clobber the newer daemon that replaced it.
     */
    ownerPid?: number;
    /** Only flip a state that is currently "running" (cleanup after a crash or kill). */
    onlyIfRunning?: boolean;
}

function endRun(root: string, status: "stopped" | "error", guard: EndRunGuard, owner: string): Promise<TyrState | null> {
    return transition(root, owner, (state) => {
        if (guard.onlyIfRunning && state.status !== "running") return null;
        if (
            guard.ownerPid !== undefined &&
            state.status === "running" &&
            typeof state.pid === "number" &&
            state.pid !== guard.ownerPid
        ) {
            return null;
        }
        return { ...state, status, pid: null };
    });
}

/** The run ended normally. Resolves to null when the guard refused or there is no state. */
export function markStopped(root: string, guard: EndRunGuard = {}): Promise<TyrState | null> {
    return endRun(root, "stopped", guard, "daemon stop");
}

/**
 * The run ended in failure. The message itself belongs in tyr.log (the caller
 * logs it); state.json records only the status.
 */
export function markError(root: string, guard: EndRunGuard = {}): Promise<TyrState | null> {
    return endRun(root, "error", guard, "daemon error");
}

/** Count a run that is not a daemon start (e.g. a one-shot `tyr run`). Status is untouched. */
export function recordRun(root: string, at: Date = new Date()): Promise<TyrState | null> {
    const lastRunAt = at.toISOString();
    return transition(root, "record run", (state) => ({ ...state, runCount: nextRunCount(state), lastRunAt }));
}
