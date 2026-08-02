export type FixType = "none" | "2d" | "3d" | "dgps" | "rtk-float" | "rtk-fixed";

/** How ArduPilot tags a failing arming check in STATUSTEXT. */
export const PREARM_TEXT_PREFIX = "PreArm: ";

export interface PrearmReason {
    /** With `PREARM_TEXT_PREFIX` already stripped — the panel shows the
     * reason itself, not the tag ArduPilot uses to route it. */
    text: string;
    /**
     * How many consecutive recheck cycles have passed without ArduPilot
     * repeating this reason. `0` means it was in the most recent cycle's
     * report — certain. `1` means it wasn't, but was the cycle before —
     * shown as a grace period rather than dropped immediately, since a
     * missing report is ambiguous: it might mean the check actually passed,
     * or just that one STATUSTEXT got lost, or that an earlier gated check
     * changed and this one simply wasn't evaluated this pass. Dropped once
     * this reaches 2 — ArduPilot has no "resolved" signal, so two straight
     * misses is as much confidence as the protocol can offer.
     */
    missedCycles: number;
}

export interface VehiclePosition {
    lat: number;
    lon: number;
    /** Meters above home/origin, not above sea level. */
    alt: number;
    /** Degrees, 0-359. */
    heading: number;
}

export interface VehicleAttitude {
    /** Degrees. Positive is right wing down. */
    roll: number;
    /** Degrees. Positive is nose up. */
    pitch: number;
}

export interface HomePosition {
    lat: number;
    lon: number;
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
    /** The numeric mode `mode` was formatted from — needed to send `setMode`, since ArduPilot's mode switch takes the raw code back, not the label. `null` until a HEARTBEAT has arrived. */
    customMode: number | null;
    /** `null` until the first GLOBAL_POSITION_INT arrives. */
    position: VehiclePosition | null;
    /** ArduPilot's own recorded home, not something the GCS infers locally. `null` until the first HOME_POSITION arrives. */
    home: HomePosition | null;
    /** `null` until the first ATTITUDE arrives. */
    attitude: VehicleAttitude | null;
    /** Meters/second over the ground. `null` until the first VFR_HUD arrives. */
    groundspeed: number | null;
    /** True airspeed from the pitot sensor, meters/second. Only meaningful on planes. `null` until the first VFR_HUD arrives. */
    airspeed: number | null;
    /** Meters/second, positive climbing. `null` until the first VFR_HUD arrives. */
    climbRate: number | null;
    /** `null` until the first HEARTBEAT arrives. */
    vehicleKind: VehicleKind | null;
    /**
     * From the SYS_STATUS health bitmask: continuous, trustworthy, and the only
     * prearm signal the status strip is allowed to render.
     */
    prearmPass: boolean;
    /**
     * `PreArm:` reasons ArduPilot has reported recently — reconciled against
     * each fresh recheck cycle rather than accumulated forever (see
     * `PrearmReason.missedCycles`). Empty once `prearmPass` is true.
     */
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

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance between two lat/lon points, in meters. */
export function distanceMeters(a: {lat: number; lon: number}, b: {lat: number; lon: number}): number {
    const toRad = (deg: number) => (deg * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const sinDLat = Math.sin(dLat / 2);
    const sinDLon = Math.sin(dLon / 2);
    const h = sinDLat * sinDLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinDLon * sinDLon;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
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
