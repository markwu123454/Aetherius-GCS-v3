import {invoke} from "@tauri-apps/api/core";
import {requireBackend} from "../vehicle/connection";

export interface LiveParamEntry {
    name: string;
    value: number;
    paramType: string;
    index: number;
}

export interface ParamBatch {
    total: number | null;
    values: LiveParamEntry[];
}

/**
 * Re-requests every parameter from scratch. The backend clears its own cache
 * first, so a value read from whatever was connected before never lingers as
 * if it were current.
 */
export function refreshParams(): Promise<void> {
    requireBackend();
    return invoke("refresh_params");
}

/**
 * Resolves to the value the vehicle actually confirmed, which is not
 * necessarily what was requested — MAVLink's `PARAM_SET` has no ack of its
 * own, so the backend treats an echoed value that differs from the request
 * (clamped, rejected by an armed/mode constraint) as a failure, not a
 * partial success.
 */
export function setParam(name: string, value: number): Promise<number> {
    requireBackend();
    return invoke<number>("set_param", {name, value});
}

/**
 * Trims float noise for REAL32/64 and rounds everything else. ArduPilot
 * transmits non-float parameters as their literal value cast to `f32`, not
 * bit-reinterpreted, so the wire value already is the real number — this is
 * display cleanup, not decoding.
 */
export function formatParamValue(entry: {value: number; paramType: string}): string {
    if (entry.paramType.startsWith("REAL")) {
        return Number(entry.value.toPrecision(6)).toString();
    }
    return Math.round(entry.value).toString();
}
