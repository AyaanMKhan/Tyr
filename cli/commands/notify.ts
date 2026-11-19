// `tyr notify [message]` — send a notification through the configured targets
// now (PLANNING.md 2.15). Mostly a test: "does a desktop toast reach me?"
//
//   tyr notify                          test message to notifications.targets
//   tyr notify "build is green" -t desktop
//
// Unlike the daemon's notifier there is no dedupe or rate limit: the user
// asked for exactly this one. Exit 1 when no target accepted it.

import { Command, Option } from "commander";
import { findProjectRoot } from "../core/discovery.js";
import { EXIT_CODES, UsageError } from "../core/errors.js";
import { printJson, readGlobals, verbosityOf } from "../core/globals.js";
import { resolveSettings } from "../core/settings.js";
import { deliverNotification, NOTIFY_TARGETS, parseTargets, type DeliveryResult, type NotificationSeverity } from "../integrations/notify.js";
import { createReporter } from "../ui/reporter.js";

interface NotifyOptions {
    target?: string[];
    title?: string;
    severity: NotificationSeverity;
}

export const DEFAULT_TEST_MESSAGE = "Notifications from Tyr reach you here.";

export function registerNotifyCommand(program: Command): void {
    program
        .command("notify")
        .description("Send a notification to your targets now (terminal, desktop) to check they work")
        .argument("[message]", "Text to send", DEFAULT_TEST_MESSAGE)
        .option("-t, --target <target...>", `Send to these targets instead of notifications.targets (${NOTIFY_TARGETS.join(", ")})`)
        .option("--title <title>", "Notification title", "Tyr")
        .addOption(new Option("--severity <level>", "How urgent it is").choices(["info", "warning", "error"]).default("info"))
        .addHelpText(
            "after",
            `
The background process sends a notification when a check regresses or starts
failing, when the diff review finds a new serious problem, and when failing
checks pass again: one per check pass at most, and the same news only once
every 10 minutes.

Targets (setting notifications.targets, env TYR_NOTIFY):
  terminal   shown highlighted in "tyr watch", which rings the bell
  desktop    a native notification (Windows toast, macOS Notification
             Center, notify-send on Linux)

Examples:
  $ tyr notify                                Test your configured targets
  $ tyr notify -t desktop                     Test the desktop target only
  $ tyr config set notifications.targets terminal,desktop`,
        )
        .action(async (message: string, options: NotifyOptions, command: Command) => {
            const globals = readGlobals(command);
            const reporter = createReporter({ verbosity: verbosityOf(globals), stream: globals.json ? process.stderr : undefined });
            const root = await findProjectRoot();
            const raw = options.target ?? (await resolveSettings({ root })).settings.notifications.targets;
            if (raw.length === 0) {
                throw new UsageError("No notification targets: notifications.targets is empty.", {
                    hint: "Pass --target desktop, or run: tyr config set notifications.targets terminal,desktop",
                });
            }
            const result = await deliverNotification(
                root,
                { title: options.title ?? "Tyr", message, severity: options.severity, key: `manual:${Date.now()}` },
                raw,
            );
            const ok = result.results.some((r) => r.ok);
            if (globals.json) {
                printJson({ ok, targets: parseTargets(raw).targets, results: result.results, eventId: result.event?.id ?? null });
            } else {
                printResults(result, reporter);
            }
            if (!ok) process.exitCode = EXIT_CODES.FAILURE;
        });
}

function printResults(result: DeliveryResult, reporter: ReturnType<typeof createReporter>): void {
    for (const r of result.results) {
        if (r.ok) {
            reporter.success(r.target === "terminal" ? "terminal: recorded; shown by tyr watch" : `${r.target}: sent`);
        } else {
            reporter.warn(`${r.target}: ${r.reason}`);
        }
    }
}
