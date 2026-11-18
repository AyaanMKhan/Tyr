// cli/integrations/desktop.ts — show a desktop notification (PLANNING.md 2.15).
//
// One small, platform-specific command per OS, never through a shell:
//
//   win32   powershell.exe -EncodedCommand: a WinRT toast (Windows 10+),
//           shown under PowerShell's own app id so no registration is needed
//   darwin  osascript: `display notification` (Notification Center)
//   linux   notify-send (libnotify); other Unixes try it too
//
// Title and message never become code: on Windows they travel in environment
// variables and are XML-escaped inside the script; osascript gets them as
// `argv`; notify-send gets them as arguments after `--`. The spawner is
// injectable so tests never pop anything up.
//
// showDesktopNotification never throws: a missing binary, a non-zero exit or
// a timeout becomes { ok: false, reason }.

import { spawn } from "node:child_process";

export interface DesktopNotification {
    title: string;
    message: string;
    /** "critical" asks for an urgent notification where the platform supports it. */
    urgency?: "low" | "normal" | "critical";
}

export interface SpawnSpec {
    command: string;
    args: string[];
    /** Extra environment variables for the child. */
    env?: Record<string, string>;
}

export type SpawnOutcome = { code: number | null; stderr: string; error?: string; timedOut?: boolean };

/** Runs a command and resolves when it exits (or fails to start). Never rejects. */
export type DesktopSpawner = (spec: SpawnSpec, timeoutMs: number) => Promise<SpawnOutcome>;

export type DesktopResult = { ok: true } | { ok: false; reason: string };

export const DESKTOP_TIMEOUT_MS = 15_000;
/** Platforms truncate anyway; keep the payload small and predictable. */
export const DESKTOP_TITLE_CHARS = 120;
export const DESKTOP_MESSAGE_CHARS = 400;

/** PowerShell's AppUserModelID: lets an unregistered script show a toast. */
export const WINDOWS_TOAST_APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

const WINDOWS_SCRIPT = [
    "$ErrorActionPreference = 'Stop'",
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
    "$t = [Security.SecurityElement]::Escape($env:TYR_NOTIFY_TITLE)",
    "$m = [Security.SecurityElement]::Escape($env:TYR_NOTIFY_MESSAGE)",
    "$s = if ($env:TYR_NOTIFY_URGENT -eq '1') { ' scenario=\"urgent\"' } else { '' }",
    "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
    "$xml.LoadXml(\"<toast$s><visual><binding template='ToastGeneric'><text>$t</text><text>$m</text></binding></visual></toast>\")",
    "$toast = New-Object Windows.UI.Notifications.ToastNotification $xml",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:TYR_NOTIFY_APP_ID).Show($toast)",
].join("\n");

const APPLESCRIPT = ["on run argv", "display notification (item 2 of argv) with title (item 1 of argv)", "end run"];

function clip(text: string, max: number): string {
    const flat = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
    const chars = Array.from(flat);
    return chars.length <= max ? flat : chars.slice(0, max - 1).join("") + "…";
}

/** The command that shows `note` on `platform`; null when there is no known way. */
export function desktopCommand(note: DesktopNotification, platform: NodeJS.Platform = process.platform): SpawnSpec | null {
    const title = clip(note.title, DESKTOP_TITLE_CHARS) || "Tyr";
    const message = clip(note.message, DESKTOP_MESSAGE_CHARS) || " ";
    switch (platform) {
        case "win32":
            return {
                command: "powershell.exe",
                args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(WINDOWS_SCRIPT, "utf16le").toString("base64")],
                env: {
                    TYR_NOTIFY_TITLE: title,
                    TYR_NOTIFY_MESSAGE: message,
                    TYR_NOTIFY_URGENT: note.urgency === "critical" ? "1" : "0",
                    TYR_NOTIFY_APP_ID: WINDOWS_TOAST_APP_ID,
                },
            };
        case "darwin":
            return { command: "osascript", args: [...APPLESCRIPT.flatMap((line) => ["-e", line]), title, message] };
        case "cygwin":
            return null;
        default:
            // Linux and the BSDs: libnotify is the common denominator.
            return { command: "notify-send", args: ["--app-name=Tyr", `--urgency=${note.urgency ?? "normal"}`, "--", title, message] };
    }
}

export const defaultDesktopSpawner: DesktopSpawner = (spec, timeoutMs) =>
    new Promise((resolve) => {
        let stderr = "";
        let settled = false;
        const finish = (outcome: SpawnOutcome): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(outcome);
        };
        let child;
        try {
            child = spawn(spec.command, spec.args, {
                env: { ...process.env, ...spec.env },
                stdio: ["ignore", "ignore", "pipe"],
                windowsHide: true,
            });
        } catch (error) {
            resolve({ code: null, stderr: "", error: error instanceof Error ? error.message : String(error) });
            return;
        }
        const timer = setTimeout(() => {
            child.kill();
            finish({ code: null, stderr, timedOut: true });
        }, timeoutMs);
        timer.unref?.();
        child.stderr?.on("data", (chunk: Buffer) => {
            if (stderr.length < 4096) stderr += chunk.toString("utf8");
        });
        child.on("error", (error: NodeJS.ErrnoException) =>
            finish({ code: null, stderr, error: error.code === "ENOENT" ? `${spec.command} not found` : error.message }),
        );
        child.on("close", (code) => finish({ code, stderr }));
    });

export interface ShowDesktopOptions {
    platform?: NodeJS.Platform;
    spawner?: DesktopSpawner;
    timeoutMs?: number;
}

export async function showDesktopNotification(note: DesktopNotification, options: ShowDesktopOptions = {}): Promise<DesktopResult> {
    const platform = options.platform ?? process.platform;
    const spec = desktopCommand(note, platform);
    if (spec === null) return { ok: false, reason: `desktop notifications are not supported on ${platform}` };
    let outcome: SpawnOutcome;
    try {
        outcome = await (options.spawner ?? defaultDesktopSpawner)(spec, options.timeoutMs ?? DESKTOP_TIMEOUT_MS);
    } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    if (outcome.error !== undefined) {
        const hint = platform === "linux" && /not found/.test(outcome.error) ? " (install libnotify / notify-send)" : "";
        return { ok: false, reason: `${outcome.error}${hint}` };
    }
    if (outcome.timedOut) return { ok: false, reason: `${spec.command} timed out` };
    if (outcome.code !== 0) {
        const detail = outcome.stderr.replace(/\s+/g, " ").trim().slice(0, 200);
        return { ok: false, reason: `${spec.command} exited with ${outcome.code}${detail !== "" ? `: ${detail}` : ""}` };
    }
    return { ok: true };
}
