// The figlet "Tyr" banner. It is decoration for a person at a terminal, so it
// is only drawn on interactive output: never on `--version`, never on parse
// errors, and never when stdout is piped or captured by CI.

import figlet from "figlet";

/** True when a human is plausibly looking at `stream`. */
export function isInteractive(stream: NodeJS.WriteStream): boolean {
    return stream.isTTY === true && process.env.TERM !== "dumb";
}

/** The banner followed by a blank line, ready to write as-is. */
export function bannerText(): string {
    return figlet.textSync("Tyr") + "\n\n";
}

/** Writes the banner to stdout when stdout is interactive. */
export function printBanner(): void {
    if (isInteractive(process.stdout)) {
        process.stdout.write(bannerText());
    }
}

/**
 * Commands whose stdout is data meant for scripts (`tyr config get` inside
 * `$(...)`, `tyr config path | xargs $EDITOR`). The banner is TTY-only
 * already, but even on a terminal a value preceded by five lines of ASCII
 * art is noise, and copying it out of the scrollback becomes a chore.
 */
const plainCommands = new WeakSet<object>();

/** Never draw the banner for `command` or any of its subcommands. */
export function withoutBanner<T extends object>(command: T): T {
    plainCommands.add(command);
    return command;
}

/** False when `command` or one of its ancestors opted out via withoutBanner(). */
export function wantsBanner(command: { parent?: unknown } | null): boolean {
    for (let current = command; current !== null && current !== undefined; current = current.parent as typeof command) {
        if (plainCommands.has(current)) return false;
    }
    return true;
}
