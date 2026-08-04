import {invoke} from "@tauri-apps/api/core";
import {requireBackend} from "./connection.ts";

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
    | {type: "land"}
    | {type: "startMission"}
    | {type: "reboot"}
    | {type: "rebootToBootloader"}
    | {type: "startAccelCalibration"}
    | {type: "confirmAccelPosition"; position: number}
    | {type: "cancelAccelCalibration"}
    | {type: "startGyroCalibration"}
    | {type: "startCompassCalibration"}
    | {type: "cancelCompassCalibration"};

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

/**
 * Raw MAVLink `RC_CHANNELS_OVERRIDE`, sent fire-and-forget — there's no ack
 * for this message the way `COMMAND_LONG` has one, so this doesn't go
 * through `sendVehicleCommand`. `channels` is always all 8 slots, 1-indexed
 * by position: `65535` ("ignore this field" — MAVLink's own sentinel, same
 * numeric value as `RC_CHANNEL_UNUSED`) for any channel this call isn't
 * touching, a raw microsecond PWM value for the ones it is. `0` is MAVLink's
 * own "release this channel back to the RC radio" — never sent by the
 * keyboard stick today, since it only ever holds a channel, but a real value
 * to send if a "give control back" action gets added later.
 */
export function sendRcOverride(channels: number[]): Promise<void> {
    requireBackend();
    return invoke<void>("send_rc_override", {channels});
}
