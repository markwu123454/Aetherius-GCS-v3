import {useRef} from "react";
import {useTauriEvent} from "../lib/tauriEvent";
import {logConsole} from "./consoleStore";
import {levelFromSeverity, severityName} from "./console";
import type {ConnectionStatus} from "../vehicle/connection";
import type {VehicleState} from "../vehicle/vehicle";

/** Emitted per STATUSTEXT, after multi-chunk reassembly in Rust. */
interface StatusTextEvent {
    severity: number;
    text: string;
}

/**
 * A tally of every MAVLink message seen since the last drain, batched on the
 * backend's existing 100ms tick. Batched rather than one event per packet
 * because the periodic streams run at ~50/s and that is a lot of IPC to spend
 * on a view that is off by default.
 */
interface MavlinkSeenBatch {
    entries: {
        name: string;
        count: number;
        /** False means nothing in `dispatch::route` claims it — i.e. it still
         * needs somewhere to go. */
        handled: boolean;
    }[];
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
        logConsole(
            levelFromSeverity(event.severity),
            "vehicle",
            `${severityName(event.severity)}: ${event.text}`,
        );
    });

    useTauriEvent<MavlinkSeenBatch>("mavlink-seen", (batch) => {
        for (const seen of batch.entries) {
            // Trace, and coalesced by name for the whole session — so this
            // settles into one row per message type with a running total,
            // rather than burying the event log it shares a panel with.
            logConsole(
                "trace",
                "mavlink",
                `${seen.name}${seen.handled ? "" : " — unhandled"}`,
                seen.count,
            );
        }
    });

    useTauriEvent<CommandAckEvent>("command-ack", (event) => {
        logConsole(
            event.accepted ? "info" : "danger",
            "command",
            `${event.command} → ${event.result}`,
        );
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
