import {invoke} from "@tauri-apps/api/core";
import {AlertLevel} from "./vehicle";

export type LinkKind = "serial" | "udp" | "tcp" | "sitl";

export type SitlVehicle = "ArduCopter" | "ArduPlane" | "ArduRover" | "ArduSub";

export interface LinkConfig {
    kind: LinkKind;
    serialPort: string;
    baud: number;
    /** Local port we listen on for a UDP link. */
    udpPort: number;
    tcpHost: string;
    tcpPort: number;
    /**
     * SITL is attached to, not launched. It is a TCP link with a known default,
     * kept separate from the plain TCP fields so switching between the two does
     * not overwrite whatever was typed in the other.
     */
    sitlHost: string;
    sitlPort: number;
}

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

export const BAUD_RATES = [57600, 115200, 230400, 460800, 921600];
export const SITL_VEHICLES: SitlVehicle[] = ["ArduCopter", "ArduPlane", "ArduRover", "ArduSub"];

export const DEFAULT_LINK: LinkConfig = {
    kind: "sitl",
    serialPort: "",
    baud: 115200,
    udpPort: 14550,
    tcpHost: "127.0.0.1",
    tcpPort: 5760,
    // SITL binds SERIAL0 to TCP 5760. Under WSL that is still reachable as
    // localhost from Windows, because WSL2 forwards listening sockets.
    sitlHost: "127.0.0.1",
    sitlPort: 5760,
};

const STORAGE_KEY = "aetherius.link.v1";

export function loadLink(): LinkConfig {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        return raw ? {...DEFAULT_LINK, ...JSON.parse(raw)} : DEFAULT_LINK;
    } catch {
        return DEFAULT_LINK;
    }
}

export function saveLink(config: LinkConfig): void {
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch {
        // Not being able to remember the last link is not worth failing over.
    }
}

/** Short form for the collapsed button, kept narrow enough for the strip. */
export function describeLink(config: LinkConfig): string {
    switch (config.kind) {
        case "serial":
            return config.serialPort ? `${config.serialPort} @ ${config.baud}` : "Serial";
        case "udp":
            return `UDP :${config.udpPort}`;
        case "tcp":
            return `TCP ${config.tcpHost}:${config.tcpPort}`;
        case "sitl":
            return `SITL ${config.sitlHost}:${config.sitlPort}`;
    }
}

/** The address a config resolves to, for the transport to open. */
export function endpointOf(config: LinkConfig): string {
    switch (config.kind) {
        case "serial":
            return `serial:${config.serialPort}:${config.baud}`;
        case "udp":
            return `udp:0.0.0.0:${config.udpPort}`;
        case "tcp":
            return `tcp:${config.tcpHost}:${config.tcpPort}`;
        case "sitl":
            return `tcp:${config.sitlHost}:${config.sitlPort}`;
    }
}

/**
 * Anything that reaches the backend is unavailable in a plain browser tab, so
 * say that plainly rather than letting an undefined bridge surface as a
 * property-access error.
 */
function requireBackend(): void {
    if (!("__TAURI_INTERNALS__" in window)) {
        throw new Error("Needs the desktop app — run `npm run tauri dev`.");
    }
}

/**
 * Ask the Rust side to launch an ArduPilot SITL instance, answering with the
 * endpoint it listens on.
 *
 * Not currently reached from the UI: SITL mode attaches to a simulator that is
 * already running instead. Spawning one through WSL cannot reliably kill the
 * Linux process afterwards, which strands port 5760 and makes the next attempt
 * fail — not something worth putting in the connect path while the transport
 * underneath it is still unproven.
 */
export function startSitl(vehicle: SitlVehicle): Promise<string> {
    requireBackend();
    return invoke<string>("start_sitl", {vehicle});
}

export function stopSitl(): Promise<void> {
    requireBackend();
    return invoke("stop_sitl");
}

/** Serial ports the backend can see, for the port picker. */
export function listSerialPorts(): Promise<string[]> {
    requireBackend();
    return invoke<string[]>("list_serial_ports");
}
