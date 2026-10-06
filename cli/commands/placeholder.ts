// Shared output for commands that are not implemented yet, so they still
// honor `--quiet` and `--json` like the real ones.

import { Command } from "commander";
import { printJson, readGlobals } from "../core/globals.js";

export function reportPlaceholder(command: Command, message: string, extra: Record<string, unknown> = {}): void {
    const globals = readGlobals(command);
    if (globals.json) {
        printJson({ command: command.name(), implemented: false, ...extra });
        return;
    }
    if (!globals.quiet) {
        console.log(message);
    }
}
