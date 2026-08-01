import {useRef} from "react";
import {useTauriEvent} from "@/lib/tauriEvent.ts";
import {logConsole} from "./consoleStore.ts";
import {levelFromSeverity, severityName} from "./console.ts";
import type {ConnectionStatus} from "@/lib/vehicle/connection.ts";
import {PREARM_TEXT_PREFIX, type VehicleState} from "@/lib/vehicle/vehicle.ts";

/** Emitted per STATUSTEXT, after multi-chunk reassembly in Rust. */
interface StatusTextEvent {
    severity: number;
    text: string;
}

/** Emitted per COMMAND_ACK. */
interface CommandAckEvent {
    command: string;
    result: string;
    accepted: boolean;
}

const LINK_LEVEL: Record<ConnectionStatus, "danger" | "warn" | "info"> = {
    disconnected: "info",
    connecting: "info",
    connected: "info",
    // Recoverable on its own — the socket is healthy and nothing is arriving.
    losing: "warn",
    // Only the app can restore this one, so it is not the same as `losing`.
    lost: "danger",
    disconnecting: "info",
    error: "danger",
};

const LINK_TEXT: Record<ConnectionStatus, string> = {
    disconnected: "Link disconnected",
    connecting: "Link connecting…",
    connected: "Link connected",
    losing: "Link silent — no telemetry arriving",
    lost: "Link lost — transport failed, reconnect required",
    disconnecting: "Link disconnecting…",
    error: "Link could not be established",
};

/**
 * Feeds the console from the backend event stream.
 *
 * Mounted once, in `App`. Subscribing per panel instead would double every line
 * when the console is open in two docks at once, and would lose everything said
 * while it was closed.
 */
export function useConsoleEvents(): void {
    useTauriEvent<StatusTextEvent>("statustext", (event) => {
        // `PreArm:` lines have their own dedicated panel now, refreshed every
        // few seconds by the backend's own periodic recheck — surfacing them
        // here too, at whatever severity ArduPilot tags them (usually
        // CRITICAL), would just be the same information flooding the console
        // at a level nobody asked to see routinely.
        const level = event.text.startsWith(PREARM_TEXT_PREFIX) ? "debug" : levelFromSeverity(event.severity);
        logConsole(level, "vehicle", `${severityName(event.severity)}: ${event.text}`);
    });

    useTauriEvent<CommandAckEvent>("command-ack", (event) => {
        // Sent automatically on every connect to raise the stream rate for a
        // handful of message types — routine housekeeping, not something the
        // operator asked for, so it's debug rather than info/danger.
        const level =
            event.command === "MAV_CMD_SET_MESSAGE_INTERVAL"
                ? "debug"
                : event.accepted
                    ? "info"
                    : "danger";
        logConsole(level, "command", `${event.command} → ${event.result}`);
    });

    useTauriEvent<ConnectionStatus>("link-status", (status) => {
        logConsole(LINK_LEVEL[status] ?? "info", "link", LINK_TEXT[status] ?? `Link ${status}`);
    });

    // Arm state and mode are not events — they are fields on a snapshot that
    // arrives ~10x a second. Only the transitions are worth a line, so the
    // previous values are held here and compared.
    const previous = useRef<{armed: boolean; mode: string} | null>(null);

    useTauriEvent<VehicleState>("vehicle", (vehicle) => {
        const before = previous.current;
        previous.current = {armed: vehicle.armed, mode: vehicle.mode};

        // The first snapshot after connecting is the current state, not a
        // change, and logging it as one would report an arming that never
        // happened.
        if (!before) return;

        if (before.armed !== vehicle.armed) {
            logConsole(vehicle.armed ? "warn" : "info", "vehicle", vehicle.armed ? "ARMED" : "Disarmed");
        }
        if (before.mode !== vehicle.mode && vehicle.mode) {
            logConsole("info", "vehicle", `Mode ${before.mode || "—"} → ${vehicle.mode}`);
        }
    });
}
