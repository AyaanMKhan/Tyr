// Console reporter: the animated UI behind `tyr init`.
//
// Deliberately dependency-free -- the spinner, the colours and the terminal
// capability detection are all hand-rolled ANSI so the CLI stays at two
// runtime dependencies. Everything funnels through a single write stream so
// the "one spinner owns the current line" invariant is easy to hold.

import { Reporter, TaskHandle } from "../core/types.js";

/* -------------------------------------------------------------------------
 * ANSI vocabulary
 * ---------------------------------------------------------------------- */

// Named once so no escape sequence is ever inlined at a call site.
const SGR = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    cyan: "\x1b[36m",
} as const;

const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";
/** Erase from the cursor to the end of the line. */
const CLEAR_TO_EOL = "\x1b[K";
/** Return to column 0 without emitting a newline. */
const LINE_START = "\r";

const SPINNER_INTERVAL_MS = 80;

interface Glyphs {
    success: string;
    failure: string;
    skip: string;
    warn: string;
    frames: readonly string[];
}

const UNICODE_GLYPHS: Glyphs = {
    success: "✓",
    failure: "✗",
    skip: "-",
    warn: "!",
    frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};

// CP437-safe stand-ins for legacy Windows consoles, where the braille frames
// and the check/cross marks render as mojibake.
const ASCII_GLYPHS: Glyphs = {
    success: "√",
    failure: "x",
    skip: "-",
    warn: "!",
    frames: ["|", "/", "-", "\\"],
};

/* -------------------------------------------------------------------------
 * Process-wide cursor safety net
 * ---------------------------------------------------------------------- */

// A hidden cursor outlives the process that hid it, so an un-restored cursor
// is a real bug the user has to fix with `reset`. Track every stream we have
// hidden and restore them on any exit path, including Ctrl-C.
const cursorHiddenOn = new Set<NodeJS.WriteStream>();
let exitHooksRegistered = false;

function restoreAllCursors(): void {
    for (const stream of cursorHiddenOn) {
        stream.write(CURSOR_SHOW);
    }
    cursorHiddenOn.clear();
}

function registerExitHooks(): void {
    if (exitHooksRegistered) {
        return;
    }
    exitHooksRegistered = true;

    process.on("exit", restoreAllCursors);

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
        const onSignal = (): void => {
            restoreAllCursors();
            // Unhook only ourselves -- never `removeAllListeners`, which would
            // silently steal signals another module legitimately owns -- then
            // re-raise so the default behaviour still terminates the process.
            process.off(signal, onSignal);
            process.kill(process.pid, signal);
        };
        process.on(signal, onSignal);
    }
}

/* -------------------------------------------------------------------------
 * Capability detection
 * ---------------------------------------------------------------------- */

/** Treat the conventional "unset / empty / false / 0" values as "not CI". */
function isCI(): boolean {
    const value = process.env.CI;
    return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

function detectColor(stream: NodeJS.WriteStream): boolean {
    // no-color.org: presence of the variable is the signal, whatever its value.
    if (process.env.NO_COLOR !== undefined) {
        return false;
    }
    if (process.env.TERM === "dumb") {
        return false;
    }
    return stream.isTTY === true;
}

function detectAnimation(stream: NodeJS.WriteStream): boolean {
    // Piped output and CI logs capture every redraw as literal text, so the
    // animated path is strictly opt-in on a real terminal.
    if (isCI() || process.env.TERM === "dumb") {
        return false;
    }
    return stream.isTTY === true;
}

function detectUnicode(): boolean {
    if (process.platform === "win32") {
        // Windows Terminal, VS Code and ConEmu are UTF-8; the legacy conhost
        // that ships without any of these markers is not.
        return Boolean(
            process.env.WT_SESSION ||
            process.env.ConEmuANSI === "ON" ||
            process.env.TERM_PROGRAM === "vscode" ||
            process.env.TERM,
        );
    }
    const locale = process.env.LC_ALL ?? process.env.LC_CTYPE ?? process.env.LANG ?? "";
    // An unset locale on POSIX is far more often a stripped-down env on a
    // modern UTF-8 terminal than an actual legacy single-byte console.
    return locale === "" || /utf-?8/i.test(locale);
}

/* -------------------------------------------------------------------------
 * Reporter
 * ---------------------------------------------------------------------- */

export interface ReporterOptions {
    /** Destination stream; defaults to `process.stdout`. */
    stream?: NodeJS.WriteStream;
    /** Force colour on/off. Defaults to auto-detection. */
    color?: boolean;
    /** Force spinner animation on/off. Defaults to auto-detection. */
    animate?: boolean;
}

type Outcome = "success" | "failure" | "skip";

class ConsoleReporter implements Reporter {
    private readonly stream: NodeJS.WriteStream;
    private readonly color: boolean;
    private readonly animate: boolean;
    private readonly glyphs: Glyphs;

    private current: Task | null = null;
    private timer: NodeJS.Timeout | null = null;
    private frameIndex = 0;
    private cursorHidden = false;

    constructor(options: ReporterOptions = {}) {
        this.stream = options.stream ?? process.stdout;
        this.color = options.color ?? detectColor(this.stream);
        this.animate = options.animate ?? detectAnimation(this.stream);
        this.glyphs = detectUnicode() ? UNICODE_GLYPHS : ASCII_GLYPHS;
    }

    /* ----- public API ---------------------------------------------------- */

    header(text: string): void {
        this.emit(this.paint(text, SGR.bold));
    }

    task(label: string): TaskHandle {
        // Exactly one spinner may own the current line; auto-resolving the
        // previous task keeps two in-flight tasks from garbling each other.
        this.current?.succeed();

        const task = new Task(this, label);
        this.current = task;

        if (this.animate) {
            this.hideCursor();
            this.frameIndex = 0;
            this.startTimer();
            this.render();
        }
        // Non-animated mode prints nothing up front: the resolution emits the
        // one and only line, which keeps piped logs one-line-per-task.
        return task;
    }

    success(text: string): void {
        this.emit(this.paint(this.glyphs.success, SGR.green) + " " + text);
    }

    info(text: string): void {
        this.emit(text);
    }

    muted(text: string): void {
        // Same glyph and dim styling a skipped task resolves to, so detected
        // and not-detected lines share one column.
        this.emit(this.paint(this.glyphs.skip, SGR.dim) + " " + text);
    }

    warn(text: string): void {
        this.emit(this.paint(this.glyphs.warn + " " + text, SGR.yellow));
    }

    error(text: string): void {
        this.emit(this.paint(this.glyphs.failure + " " + text, SGR.red));
    }

    blank(): void {
        this.emit("");
    }

    done(text: string): void {
        // The summary closes the run, so nothing may still be spinning under it.
        this.current?.succeed();
        this.emit(this.paint(text, SGR.bold));
    }

    stop(): void {
        // Idempotent: every step below is a no-op once already torn down.
        this.teardownSpinner();
        this.current = null;
    }

    /* ----- internals used by Task ---------------------------------------- */

    /** Redraw the live spinner after its label changed. */
    refresh(task: Task): void {
        if (this.current === task) {
            this.render();
        }
    }

    /** Replace the spinner with the task's final line. Called once per task. */
    finish(task: Task, outcome: Outcome, text: string): void {
        if (this.current === task) {
            this.teardownSpinner();
            this.current = null;
        }
        this.stream.write(this.symbolFor(outcome) + " " + text + "\n");
    }

    /* ----- rendering ------------------------------------------------------ */

    private symbolFor(outcome: Outcome): string {
        switch (outcome) {
            case "success":
                return this.paint(this.glyphs.success, SGR.green);
            case "failure":
                return this.paint(this.glyphs.failure, SGR.red);
            case "skip":
                return this.paint(this.glyphs.skip, SGR.dim);
        }
    }

    private paint(text: string, code: string): string {
        return this.color ? code + text + SGR.reset : text;
    }

    /**
     * Write a standalone line. When a spinner is live it has to surrender the
     * current row first and then resume on the fresh row underneath, otherwise
     * the two writers fight over the same columns.
     */
    private emit(line: string): void {
        const spinning = this.animate && this.current !== null;
        if (spinning) {
            this.eraseLine();
        }
        this.stream.write(line + "\n");
        if (spinning) {
            this.render();
        }
    }

    private eraseLine(): void {
        this.stream.write(LINE_START + CLEAR_TO_EOL);
    }

    private render(): void {
        if (!this.animate || this.current === null) {
            return;
        }
        const frame = this.glyphs.frames[this.frameIndex % this.glyphs.frames.length];
        // Trailing erase matters: shrinking the label would otherwise leave
        // the tail of the previous, longer label stranded on screen.
        this.stream.write(LINE_START + this.paint(frame, SGR.cyan) + " " + this.current.label + CLEAR_TO_EOL);
    }

    private startTimer(): void {
        if (this.timer !== null) {
            return;
        }
        this.timer = setInterval(() => {
            this.frameIndex += 1;
            this.render();
        }, SPINNER_INTERVAL_MS);
        // An orphaned spinner must never be the reason node refuses to exit.
        this.timer.unref();
    }

    private teardownSpinner(): void {
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.animate && this.current !== null) {
            this.eraseLine();
        }
        this.showCursor();
    }

    private hideCursor(): void {
        if (!this.animate || this.cursorHidden) {
            return;
        }
        registerExitHooks();
        this.cursorHidden = true;
        cursorHiddenOn.add(this.stream);
        this.stream.write(CURSOR_HIDE);
    }

    private showCursor(): void {
        if (!this.cursorHidden) {
            return;
        }
        this.cursorHidden = false;
        cursorHiddenOn.delete(this.stream);
        this.stream.write(CURSOR_SHOW);
    }
}

/** One in-flight line. Resolves exactly once; later calls are silent no-ops. */
class Task implements TaskHandle {
    private settled = false;

    constructor(
        private readonly reporter: ConsoleReporter,
        public label: string,
    ) {}

    succeed(text?: string): void {
        this.settle("success", text);
    }

    fail(text?: string): void {
        this.settle("failure", text);
    }

    skip(text?: string): void {
        this.settle("skip", text);
    }

    update(text: string): void {
        if (this.settled) {
            return;
        }
        this.label = text;
        this.reporter.refresh(this);
    }

    private settle(outcome: Outcome, text?: string): void {
        // Guards against a duplicate line when a caller resolves a handle the
        // reporter has already auto-resolved on its behalf.
        if (this.settled) {
            return;
        }
        this.settled = true;
        this.reporter.finish(this, outcome, text ?? this.label);
    }
}

export function createReporter(options?: ReporterOptions): Reporter {
    return new ConsoleReporter(options);
}
