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

export interface VehiclePosition {
    lat: number;
    lon: number;
    /** Meters above home/origin, not above sea level. */
    alt: number;
    /** Degrees, 0-359. */
    heading: number;
}

/**
 * Resolved from HEARTBEAT's `mavtype` — grouped down to what the UI actually
 * treats differently (which icon to draw), not the full MAV_TYPE enum.
 */
export type VehicleKind = "plane" | "multirotor" | "other";

export interface VehicleState {
    connected: boolean;
    armed: boolean;
    mode: string;
    /** `null` until the first GLOBAL_POSITION_INT arrives. */
    position: VehiclePosition | null;
    /** `null` until the first HEARTBEAT arrives. */
    vehicleKind: VehicleKind | null;
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

const SEVERITY: Record<AlertLevel, number> = {none: 0, warn: 1, danger: 2};

/** The more serious of two levels. */
export function worst(a: AlertLevel, b: AlertLevel): AlertLevel {
    return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

/**
 * The worst thing the vehicle is currently reporting about itself.
 *
 * Deliberately says nothing about the link. Whether these readings are still
 * arriving is the connection's business, and combining the two here would mean
 * two different notions of "stale" — one for the chips and one for this.
 */
export function alertLevel(state: VehicleState): AlertLevel {
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
