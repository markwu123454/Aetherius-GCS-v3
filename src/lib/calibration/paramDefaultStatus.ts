import {LiveParamEntry} from "@/lib/params/liveParams.ts";

export type ParamDefaultStatus = "complete" | "incomplete" | "unknown";

/**
 * ArduPilot's own "still at firmware default" rule for uncalibrated sensors —
 * mirrors QGroundControl's `APMSensorsComponent::accelSetupNeeded` (and the
 * same logic for `FRAME_CLASS`, whose docs literally define 0 as
 * "Undefined"): unknown if any named param hasn't been read yet, incomplete
 * iff every one of them is still exactly zero, complete otherwise.
 */
export function paramDefaultStatus(live: Map<string, LiveParamEntry>, names: string[]): ParamDefaultStatus {
    const values = names.map((name) => live.get(name)?.value);
    if (values.some((value) => value === undefined)) return "unknown";
    return values.every((value) => value === 0) ? "incomplete" : "complete";
}
