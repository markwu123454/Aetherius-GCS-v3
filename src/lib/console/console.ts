/**
 * Console message model.
 *
 * Deliberately not the browser console: this is the operator's view of what the
 * vehicle and the link are saying, and its audience is someone standing in a
 * field deciding whether to launch.
 */

export type ConsoleLevel = "danger" | "warn" | "info" | "debug";

/** Where a line came from. Shown as a column, and filterable, because "the
 * radio dropped" and "the autopilot refused to arm" are different problems that
 * otherwise interleave into one undifferentiated stream. */
export type ConsoleSource = "vehicle" | "link" | "command" | "param" | "mavlink" | "app";

export interface ConsoleEntry {
    id: number;
    /** When the line was first seen. Repeats update `lastAt` and `count`
     * instead of appending, so this stays the first occurrence. */
    at: number;
    lastAt: number;
    level: ConsoleLevel;
    source: ConsoleSource;
    text: string;
    /** 1 unless the same line repeated inside the coalescing window. */
    count: number;
}

export const CONSOLE_LEVELS: ConsoleLevel[] = ["danger", "warn", "info", "debug"];

export const CONSOLE_LEVEL_LABELS: Record<ConsoleLevel, string> = {
    danger: "Error",
    warn: "Warning",
    info: "Info",
    debug: "Debug",
};

export const CONSOLE_LEVEL_CLASSES: Record<ConsoleLevel, string> = {
    danger: "text-state-danger",
    warn: "text-state-warn",
    info: "text-text-primary",
    debug: "text-text-helper",
};

/**
 * Levels shown before the operator touches anything.
 *
 * `debug` is off because it's routine housekeeping (message-interval requests
 * the app sends on every connect, the airspace load line) rather than
 * something that happened on the link or the vehicle — worth having, not
 * worth showing by default.
 */
export const DEFAULT_VISIBLE_LEVELS: ConsoleLevel[] = ["danger", "warn", "info"];

/**
 * MAV_SEVERITY (0-7) onto the four levels above.
 *
 * The four most severe map to one bucket on purpose. ArduPilot's use of
 * EMERGENCY through ERROR is not consistent enough to give the operator four
 * shades of red that mean anything, and a colour that appears constantly stops
 * being read at all.
 */
export function levelFromSeverity(severity: number): ConsoleLevel {
    if (severity <= 3) return "danger";
    if (severity === 4) return "warn";
    if (severity <= 6) return "info";
    return "debug";
}

export const MAV_SEVERITY_NAMES = [
    "EMERGENCY",
    "ALERT",
    "CRITICAL",
    "ERROR",
    "WARNING",
    "NOTICE",
    "INFO",
    "DEBUG",
];

export function severityName(severity: number): string {
    return MAV_SEVERITY_NAMES[severity] ?? `SEV${severity}`;
}

/** `14:32:07.412` — the sub-second part matters when reconstructing what
 * happened in the half second before a failsafe. */
export function formatConsoleTime(at: number): string {
    const date = new Date(at);
    const pad = (value: number, width = 2) => String(value).padStart(width, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}
