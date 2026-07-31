import {invoke} from "@tauri-apps/api/core";
import {requireBackend} from "./connection";

/**
 * Mirrors the Rust `VehicleCommand` enum in `vehicle_command.rs` field for
 * field. Adding an action means adding a member here and a variant there —
 * `sendVehicleCommand` and the backend's dispatch function don't change.
 */
export type VehicleCommand =
    | {type: "arm"}
    | {type: "disarm"}
    | {type: "setMode"; mode: number}
    | {type: "takeoff"; altitude: number}
    | {type: "returnToLaunch"}
    | {type: "land"};

/**
 * Sends one vehicle action and waits for the backend to confirm the
 * autopilot acknowledged it. Rejects with a human-readable message — "not
 * connected", "vehicle rejected the command: ...", a timeout, etc. — sourced
 * from the backend, since it's the side that knows why a command failed.
 */
export function sendVehicleCommand(command: VehicleCommand): Promise<void> {
    requireBackend();
    return invoke<void>("send_vehicle_command", {command});
}
