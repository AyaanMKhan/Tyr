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
