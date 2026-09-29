import {useCallback, useEffect, useRef, useState} from "react";
import {sendVehicleCommand} from "@/lib/vehicle/commands.ts";
import {useTauriEvent} from "@/lib/tauriEvent.ts";
import type {ConnectionStatus} from "@/lib/vehicle/connection.ts";
import {ACCEL_CAL_STEPS, ACCEL_POS_FAILED, ACCEL_POS_SUCCESS, accelStepFor} from "./accelCalSteps.ts";

type Phase = "idle" | "starting" | "active";

/** How long to wait after `start()` for the vehicle's first
 * `ACCELCAL_VEHICLE_POS` before assuming it isn't going to send one (old
 * firmware, no IMU, command silently ignored). ArduPilot itself never times
 * this out — ported from nothing, chosen to be comfortably longer than a
 * healthy link's round trip. */
const START_TIMEOUT_MS = 6_000;

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Re-implements QGroundControl's 6-position accelerometer calibration
 * (`APMSensorsComponentController::calibrateAccel`), but confirms each
 * position with ArduPilot's real `MAV_CMD_ACCELCAL_VEHICLE_POS` command
 * instead of QGC's legacy trick of sending back an unrelated `COMMAND_ACK` —
 * ArduPilot's own source (`AP_AccelCal::handle_command_ack`) documents that
 * hack as unchecked-by-source/component and calls for GCSs to move off it.
 * The proper command is validated against whichever position the vehicle is
 * currently waiting on (`AP_AccelCal::gcs_vehicle_position`), so it can't
 * accidentally skip a step the way the old approach could.
 */
export function useAccelCalibration() {
    const [phase, setPhase] = useState<Phase>("idle");
    const [position, setPosition] = useState<number | null>(null);
    const [confirming, setConfirming] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<"success" | "failed" | null>(null);

    const startTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearTimers = useCallback(() => {
        if (startTimeoutRef.current !== null) {
            clearTimeout(startTimeoutRef.current);
            startTimeoutRef.current = null;
        }
    }, []);

    const calibrating = phase !== "idle";
    const step = position !== null ? accelStepFor(position) : null;
    const stepIndex = step ? ACCEL_CAL_STEPS.indexOf(step) : -1;

    // Mirrored alongside the state so the unmount cleanup below always reads
    // the current phase rather than the one captured when it was mounted.
    const phaseRef = useRef(phase);
    phaseRef.current = phase;

    const start = useCallback(() => {
        setError(null);
        setResult(null);
        setPhase("starting");
        setPosition(null);

        sendVehicleCommand({type: "startAccelCalibration"}).catch((err) => {
            clearTimers();
            setPhase("idle");
            setError(message(err));
        });

        clearTimers();
        startTimeoutRef.current = setTimeout(() => {
            setPhase("idle");
            setError("No response from the vehicle — accelerometer calibration may not be supported.");
        }, START_TIMEOUT_MS);
    }, [clearTimers]);

    const next = useCallback(() => {
        if (phase !== "active" || confirming || position === null) {
            return;
        }
        setConfirming(true);
        sendVehicleCommand({type: "confirmAccelPosition", position}).catch((err) => {
            // The vehicle may have already moved on by the time this lands —
            // a real `accel-cal-pos` event for the next step will clear
            // `confirming` regardless, so a stale rejection here only needs
            // to stop blocking the button if that never arrives.
            setConfirming(false);
            setError(message(err));
        });
    }, [phase, confirming, position]);

    useTauriEvent<{position: number}>("accel-cal-pos", (payload) => {
        if (phase === "idle") {
            return; // stale event from a calibration this session no longer owns
        }

        if (payload.position === ACCEL_POS_SUCCESS) {
            clearTimers();
            setResult("success");
            setPhase("idle");
            setPosition(null);
            setConfirming(false);
            return;
        }
        if (payload.position === ACCEL_POS_FAILED) {
            clearTimers();
            setResult("failed");
            setError("Calibration failed — try again.");
            setPhase("idle");
            setPosition(null);
            setConfirming(false);
            return;
        }

        clearTimers();
        setPhase("active");
        setPosition(payload.position);
        setConfirming(false);
    });

    // The vehicle's calibration only lives as long as its link: a reboot
    // (the panel's own way out of a stuck wizard) or a lost link ends it on
    // the vehicle's side, so end it here too. Without this the wizard kept
    // showing its last step after a reboot, as if the reboot did nothing.
    useTauriEvent<ConnectionStatus>("link-status", (status) => {
        if (status !== "rebooting" && status !== "lost" && status !== "disconnected" && status !== "error") return;
        if (phaseRef.current === "idle") return;
        clearTimers();
        setPhase("idle");
        setPosition(null);
        setConfirming(false);
        setResult(null);
        setError(status === "rebooting" ? null : "The link dropped, so the calibration stopped. Reconnect and start again.");
    });

    // Best-effort courtesy attempt on the way out — ArduPilot has no real
    // "cancel accelerometer calibration" command (see the panel's inline
    // warning during the wizard for why), so this is unlikely to do
    // anything, but it costs nothing to try for firmware that might honor
    // it. There is no local "cancel" action to pair with it: once started,
    // this hook doesn't offer a way to back out short of navigating away
    // (which triggers this) or rebooting the vehicle.
    useEffect(() => {
        return () => {
            if (phaseRef.current === "active" || phaseRef.current === "starting") {
                sendVehicleCommand({type: "cancelAccelCalibration"}).catch(() => {});
            }
        };
    }, []);

    return {calibrating, phase, step, stepIndex, confirming, error, result, start, next};
}
