// Interactive review of detected commands, for `tyr init --interactive`.
//
// Detection guesses; the user knows. This module walks each command slot,
// shows what was detected, and lets the user keep it (Enter), replace it
// (type a command) or clear it (type `-`). Empty slots accept a new command.
//
// Like the detectors it is silent and does no terminal I/O of its own: the
// question/confirm functions and the line printer are injected, so tests can
// script the answers and `init.ts` decides whether prompting is safe at all.

import type { CommandKind, CommandProbe, CommandVerification, ProjectCommand, ProjectProfile } from "./types.js";

/** Typed at a prompt to empty the slot. */
export const CLEAR_TOKEN = "-";

/**
 * `evidence` recorded for a command the user typed. ProjectCommand.evidence
 * normally names the file that proved a command; "user" marks provenance
 * without changing the tyr.json shape.
 */
export const USER_EVIDENCE = "user";

/** Asks a question; an empty answer must come back as `defaultValue`. */
export type AskFn = (question: string, defaultValue: string) => Promise<string>;
export type ConfirmFn = (question: string, defaultYes: boolean) => Promise<boolean>;

/** Slots in display order, with the labels `tyr init` already prints. */
export const COMMAND_SLOTS: readonly { kind: CommandKind; label: string }[] = [
    { kind: "build", label: "Build" },
    { kind: "test", label: "Tests" },
    { kind: "lint", label: "Linter" },
    { kind: "format", label: "Formatter" },
    { kind: "typecheck", label: "Type checker" },
];

export interface EditCommandsOptions {
    ask: AskFn;
    /** When given, a final "Write this configuration?" question is asked. */
    confirm?: ConfirmFn;
    /** Probe results to show beside detected commands; null under `--no-verify`. */
    checks?: CommandVerification | null;
    /** Prints one informational line. Defaults to a no-op. */
    say?: (line: string) => void;
}

export interface EditCommandsResult {
    /** A copy of the input profile with the edits applied. */
    project: ProjectProfile;
    /** Slots the user replaced or filled, i.e. those worth re-verifying. */
    changed: CommandKind[];
    /** Slots the user emptied. */
    cleared: CommandKind[];
    /** False when the final confirmation was declined; nothing should be written. */
    confirmed: boolean;
}

/** Packaged-binary runners whose next argument is the real tool. */
const EXECUTORS: ReadonlySet<string> = new Set(["npx", "pnpx", "bunx"]);

/**
 * Display name for a hand-typed command: its first token, skipping leading
 * `VAR=value` assignments and `npx`-style runners, without any directory.
 * `npx eslint .` -> "eslint", `./gradlew build` -> "gradlew".
 */
export function toolFromCommand(command: string): string {
    const tokens = command.trim().split(/\s+/).filter((token) => token !== "");
    let index = 0;
    while (index < tokens.length - 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index++;
    if (EXECUTORS.has(tokens[index]) && index + 1 < tokens.length) {
        const bin = tokens.slice(index + 1).find((token) => !token.startsWith("-"));
        if (bin !== undefined) return bin;
    }
    const head = tokens[index] ?? command.trim();
    return head.split(/[\\/]/).pop() || head;
}

/** A ProjectCommand for something the user typed. */
export function userCommand(command: string): ProjectCommand {
    const trimmed = command.trim();
    return { tool: toolFromCommand(trimmed), command: trimmed, evidence: USER_EVIDENCE };
}

function describeProbe(probe: CommandProbe | null | undefined): string {
    return probe ? ` (${probe.status}: ${probe.detail})` : "";
}

/**
 * Walk every command slot and apply the user's answers. Never mutates
 * `profile`. Answers are trimmed; Enter keeps the slot as it is.
 */
export async function editCommands(
    profile: ProjectProfile,
    options: EditCommandsOptions,
): Promise<EditCommandsResult> {
    const say = options.say ?? (() => {});
    const project: ProjectProfile = { ...profile };
    const changed: CommandKind[] = [];
    const cleared: CommandKind[] = [];

    say(`Review detected commands: Enter keeps, a new command replaces, "${CLEAR_TOKEN}" clears.`);

    for (const { kind, label } of COMMAND_SLOTS) {
        const current = profile[kind];
        if (current) {
            say(`${label}: ${current.command}${describeProbe(options.checks?.[kind])}`);
        } else {
            say(`${label}: none detected`);
        }

        const answer = (await options.ask(`${label} command`, current?.command ?? "")).trim();

        if (answer === CLEAR_TOKEN) {
            if (current) {
                project[kind] = null;
                cleared.push(kind);
            }
            continue;
        }
        if (answer === "" || answer === current?.command) {
            continue;
        }
        project[kind] = userCommand(answer);
        changed.push(kind);
    }

    const confirmed = options.confirm ? await options.confirm("Write this configuration?", true) : true;
    return { project, changed, cleared, confirmed };
}
