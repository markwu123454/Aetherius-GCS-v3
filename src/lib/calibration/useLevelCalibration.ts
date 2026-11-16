import {useCallback, useRef, useState} from "react";
import {sendVehicleCommand} from "@/lib/vehicle/commands.ts";
import {useTauriEvent} from "@/lib/tauriEvent.ts";

type Phase = "idle" | "calibrating";

interface StatusTextEvent {
    severity: number;
    text: string;
}

/** MAV_SEVERITY_NOTICE and worse (lower numbers are more severe) — the
 * "Disarm to allow calibration" refusal is sent at NOTICE. */
const NOTICE_SEVERITY = 5;

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * ArduPilot's level horizon (`MAV_CMD_PREFLIGHT_CALIBRATION` param5=2) is one
 * blocking command: a full gyro calibration, then a 400 ms accel average
 * saved as AHRS_TRIM_X/Y. Its only ack is a bare ACCEPTED/FAILED, so the
 * reason for a failure ("trim over maximum of 10 degrees", "Disarm to allow
 * calibration") only arrives as STATUSTEXT — the last warning seen during
 * the run is surfaced as the error instead of the raw MAV_RESULT.
 *
 * The new trim needs no refresh: ArduPilot's `set_and_save` pushes
 * PARAM_VALUE for each axis, which the live parameter store already picks up.
 */
export function useLevelCalibration() {
    const [phase, setPhase] = useState<Phase>("idle");
    const [result, setResult] = useState<"success" | "failed" | null>(null);
    const [error, setError] = useState<string | null>(null);
    const runningRef = useRef(false);
    const lastWarningRef = useRef<string | null>(null);

    useTauriEvent<StatusTextEvent>("statustext", (event) => {
        if (runningRef.current && event.severity <= NOTICE_SEVERITY) {
            lastWarningRef.current = event.text;
        }
    });

    const start = useCallback(async () => {
        runningRef.current = true;
        lastWarningRef.current = null;
        setPhase("calibrating");
        setResult(null);
        setError(null);
        try {
            await sendVehicleCommand({type: "startLevelCalibration"});
            setResult("success");
        } catch (err) {
            setResult("failed");
            setError(lastWarningRef.current ?? message(err));
        } finally {
            runningRef.current = false;
            setPhase("idle");
        }
    }, []);

    return {calibrating: phase === "calibrating", result, error, start};
}
