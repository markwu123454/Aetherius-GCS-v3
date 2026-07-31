import {invoke} from "@tauri-apps/api/core";
import {AlertLevel} from "./vehicle";

/**
 * The link's lifecycle.
 *
 * Two distinctions do the work here.
 *
 * Intent separates `disconnected` from `lost`: both mean no telemetry, but one
 * was asked for and the other is a vehicle that stopped answering.
 *
 * Transport liveness separates `losing` from `lost`, and it is observed rather
 * than inferred. `losing` means the socket is healthy and nothing is arriving —
 * a state that can persist indefinitely, because a radio dropout, a reboot or a
 * stalled autopilot all look like this and all can recover. Escalating it on a
 * timer would assert knowledge we do not have. `lost` is only ever reached by
 * the transport itself failing, and means nothing will arrive until the app
 * reconnects.
 */
export type ConnectionStatus =
    | "disconnected"
    | "connecting"
    | "connected"
    | "losing"
    | "lost"
    | "disconnecting"
    /** The link could never be established, as opposed to having dropped. */
    | "error";

/**
 * These strings are produced by the Rust `LinkStatus` enum, which owns the
 * state machine. Nothing here derives a status — the thresholds for `losing`
 * and `lost` live in `link.rs` beside the reader loop that measures them.
 */

/**
 * Telemetry on screen is no longer backed by arriving data. Covers both
 * `losing` and `lost` because the readings are equally out of date in each —
 * what differs is whether they can start updating again on their own.
 */
export function isLinkFailing(status: ConnectionStatus): boolean {
    return status === "losing" || status === "lost";
}

/**
 * The transport is gone and only the app can restore it. Distinguished from
 * `losing`, where waiting is a legitimate strategy.
 */
export function needsReconnect(status: ConnectionStatus): boolean {
    return status === "lost";
}

/**
 * How long a link may be silent before the silence stops being ordinary.
 *
 * Radio links hiccup for a couple of seconds routinely. Rendering every one of
 * those at full severity is how a warning colour stops being read, so the first
 * moments are amber and sustained silence is not.
 */
export const SILENCE_ESCALATES_AFTER = 10_000;

/**
 * How alarming the link itself currently is.
 *
 * `losing` is not treated as milder than `lost`. It is arguably worse: a dead
 * transport is usually something mundane at this end, whereas a healthy socket
 * carrying nothing means the vehicle stopped answering and the reasons for that
 * include the worst ones. What separates them is that `lost` has a remedy and
 * `losing` does not — not that one is less serious.
 *
 * The escalation here is by elapsed silence, which is an observed fact. It does
 * not change the link's state, only how loudly it is shown.
 */
export function linkSeverity(status: ConnectionStatus, silentFor: number | null): AlertLevel {
    switch (status) {
        case "lost":
        case "error":
            return "danger";
        case "losing":
            return silentFor !== null && silentFor > SILENCE_ESCALATES_AFTER ? "danger" : "warn";
        default:
            return "none";
    }
}

/** States where nothing has been heard yet, so there is no age to report. */
export function isLinkIdle(status: ConnectionStatus): boolean {
    return status === "disconnected" || status === "connecting" || status === "error";
}

/**
 * Anything that reaches the backend is unavailable in a plain browser tab, so
 * say that plainly rather than letting an undefined bridge surface as a
 * property-access error.
 */
export function requireBackend(): void {
    if (!("__TAURI_INTERNALS__" in window)) {
        throw new Error("Needs the desktop app — run `npm run tauri dev`.");
    }
}

/**
 * Endpoints worth offering as a faster alternative to typing one by hand:
 * every serial port currently present, plus the default SITL TCP port if
 * something is actually listening on it. Deliberately lenient — no VID/PID
 * filtering on serial ports, since the user already knows what they plugged
 * in and a missed real port is worse than an extra unlikely one shown.
 */
export function scanLinks(): Promise<string[]> {
    requireBackend();
    return invoke<string[]>("scan_links");
}

/**
 * Endpoints are typed in the same address syntax `connect_link` accepts —
 * `tcp:host:port`, `udp:bindhost:port`, `serial:PORT:BAUD` — and passed
 * through unchanged. There is no per-kind structure on this side to keep in
 * sync with the backend's own parsing.
 */
const STORAGE_KEY = "aetherius.link.v2";
// Kept deeper than what the Recent section displays (5), so deleting a shown
// entry can still backfill from one that was previously crowded out.
const HISTORY_LIMIT = 15;
export const HISTORY_DISPLAY_LIMIT = 5;

export function loadHistory(): string[] {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) {
            return [];
        }
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
    } catch {
        return [];
    }
}

export function saveHistory(history: string[]): void {
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    } catch {
        // Not being able to remember past attempts is not worth failing over.
    }
}

/** Moves `endpoint` to the front of `history`, dropping any earlier duplicate. */
export function withAttempt(history: string[], endpoint: string): string[] {
    const trimmed = endpoint.trim();
    if (!trimmed) {
        return history;
    }
    return [trimmed, ...history.filter((entry) => entry !== trimmed)].slice(0, HISTORY_LIMIT);
}

/** Drops one entry, e.g. from the delete control on a Recent row. */
export function withoutAttempt(history: string[], endpoint: string): string[] {
    return history.filter((entry) => entry !== endpoint);
}
