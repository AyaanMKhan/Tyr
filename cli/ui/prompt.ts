// Minimal interactive prompts on top of node:readline.
//
// Commands must call `canPrompt()` first and fall back to a non-interactive
// default when it is false: piped stdin, CI and `--json` runs have nobody to
// answer, and blocking on a question there would hang the process.

import { createInterface } from "node:readline/promises";

export interface PromptIO {
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
}

/** True when both ends are a terminal and the caller did not ask for JSON. */
export function canPrompt(options: { json?: boolean } = {}): boolean {
    if (options.json) return false;
    if (process.env.CI) return false;
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Asks a free-text question. An empty answer returns `defaultValue`, which is
 * shown in brackets. Ctrl-D (end of input) also returns the default.
 */
export async function ask(question: string, defaultValue = "", io: PromptIO = {}): Promise<string> {
    const rl = createInterface({
        input: io.input ?? process.stdin,
        output: io.output ?? process.stdout,
        terminal: false,
    });
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    try {
        const answer = await new Promise<string>((resolve) => {
            rl.once("close", () => resolve(""));
            rl.question(`${question}${suffix} `).then(resolve, () => resolve(""));
        });
        const trimmed = answer.trim();
        return trimmed === "" ? defaultValue : trimmed;
    } finally {
        rl.close();
    }
}

/** Yes/no question. Accepts y/yes/n/no in any case; anything else returns the default. */
export async function confirm(question: string, defaultYes: boolean, io: PromptIO = {}): Promise<boolean> {
    const answer = await ask(`${question} ${defaultYes ? "(Y/n)" : "(y/N)"}`, "", io);
    if (/^y(es)?$/i.test(answer)) return true;
    if (/^no?$/i.test(answer)) return false;
    return defaultYes;
}
