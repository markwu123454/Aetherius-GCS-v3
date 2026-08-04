import {useCallback, useState} from "react";
import {sendVehicleCommand} from "@/lib/vehicle/commands.ts";

type Phase = "idle" | "calibrating";

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * ArduPilot's gyro calibration (`MAV_CMD_PREFLIGHT_CALIBRATION` param1=1) has
 * none of accelerometer calibration's position sequence — it's a single
 * command that holds the link for a few seconds while the vehicle samples
 * gyro bias at rest, then acks accepted or failed. No wizard state machine
 * needed; `sendVehicleCommand`'s promise only resolves once the backend has
 * the real terminal result (see `commands::on_ack`'s handling of the
 * intermediate `MAV_RESULT_IN_PROGRESS` ack ArduPilot sends first).
 */
export function useGyroCalibration() {
    const [phase, setPhase] = useState<Phase>("idle");
    const [result, setResult] = useState<"success" | "failed" | null>(null);
    const [error, setError] = useState<string | null>(null);

    const start = useCallback(async () => {
        setPhase("calibrating");
        setResult(null);
        setError(null);
        try {
            await sendVehicleCommand({type: "startGyroCalibration"});
            setResult("success");
        } catch (err) {
            setResult("failed");
            setError(message(err));
        } finally {
            setPhase("idle");
        }
    }, []);

    return {calibrating: phase === "calibrating", result, error, start};
}
