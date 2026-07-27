export type FixType = "none" | "2d" | "3d" | "dgps" | "rtk-float" | "rtk-fixed";

export interface PrearmReason {
    text: string;
    /**
     * When this reason was last emitted. ArduPilot only sends `PreArm:` lines
     * as STATUSTEXT on its own cadence and never signals that one has been
     * resolved, so age is the only evidence we have.
     */
    lastSeen: number;
}

export interface VehicleState {
    connected: boolean;
    armed: boolean;
    mode: string;
    /**
     * From the SYS_STATUS health bitmask: continuous, trustworthy, and the only
     * prearm signal the status strip is allowed to render.
     */
    prearmPass: boolean;
    /** Best-effort, text-only, and always potentially out of date. */
    prearmReasons: PrearmReason[];
    /** ARMING_CHECK categories the operator has switched off. */
    disabledChecks: string[];
    battery: {voltage: number; current: number; consumed: number; percent: number};
    gps: {fix: FixType; satellites: number; hdop: number};
    link: {rssi: number; lossPercent: number};
    ekf: {ok: boolean; vibe: number};
    /** Last packet of any kind, used to decide whether readings are stale. */
    updatedAt: number;
}

/** A reading older than this is shown as stale rather than as a live value. */
export const STALE_AFTER = 3_000;

/** ArduPilot re-emits prearm text roughly every 30s while checks are failing. */
export const PREARM_CADENCE = 30_000;

/** Past one missed cycle a reason is suspect; past two it is dropped. */
export const PREARM_REASON_SUSPECT = PREARM_CADENCE + 5_000;
export const PREARM_REASON_EXPIRY = PREARM_CADENCE * 2 + 10_000;

export type AlertLevel = "none" | "warn" | "danger";

export function isStale(state: VehicleState, now: number): boolean {
    return !state.connected || now - state.updatedAt > STALE_AFTER;
}

/**
 * The single worst thing currently true about the vehicle. Drives both the
 * strip's colouring and whether the application menu is allowed to stay open.
 */
export function alertLevel(state: VehicleState, now: number): AlertLevel {
    if (isStale(state, now)) {
        return "danger";
    }
    if (state.battery.percent <= 15 || state.gps.fix === "none") {
        return "danger";
    }
    if (!state.ekf.ok || state.battery.percent <= 25 || state.link.lossPercent > 5) {
        return "warn";
    }
    if (!state.prearmPass && !state.armed) {
        return "warn";
    }
    return "none";
}

export function fixLabel(fix: FixType): string {
    switch (fix) {
        case "none":
            return "NO FIX";
        case "2d":
            return "2D";
        case "3d":
            return "3D";
        case "dgps":
            return "DGPS";
        case "rtk-float":
            return "RTK FLT";
        case "rtk-fixed":
            return "RTK FIX";
    }
}
