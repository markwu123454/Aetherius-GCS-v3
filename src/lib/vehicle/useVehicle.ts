import {useState} from "react";
import {useTauriEvent} from "@/lib/tauriEvent.ts";
import {FixType, VehicleAttitude, VehicleKind, VehiclePosition, VehicleState} from "./vehicle.ts";
import {modeLabel} from "./modes.ts";

/**
 * The payload emitted by `link.rs`. Every field is nullable because the backend
 * only fills one in once the corresponding message has actually arrived —
 * "not reported yet" and "reported as zero" are different things.
 *
 * `groundspeed` isn't sent by the backend yet (no VFR_HUD handling exists
 * there yet) — typed here ahead of that landing, same as the other fields
 * were before their backend support arrived.
 */
interface Snapshot {
    armed: boolean | null;
    customMode: number | null;
    vehicleKind: VehicleKind | null;
    prearmPass: boolean | null;
    batteryVoltage: number | null;
    batteryCurrent: number | null;
    batteryPercent: number | null;
    batteryConsumedMah: number | null;
    gpsFix: number | null;
    satellites: number | null;
    hdop: number | null;
    lat: number | null;
    lon: number | null;
    relativeAlt: number | null;
    heading: number | null;
    sinceHeartbeatMs: number | null;
    commDropPercent: number | null;
    radioRssi: number | null;
    ekfOk: boolean | null;
    vibe: number | null;
    rollDeg: number | null;
    pitchDeg: number | null;
    groundspeed?: number | null;
}

/** MAVLink GPS_FIX_TYPE. 0 (no GPS) and 1 (no fix) are both "no fix" to a pilot. */
const FIX_TYPES: FixType[] = ["none", "none", "2d", "3d", "dgps", "rtk-float", "rtk-fixed"];

/** Nothing known yet. Rendered as stale rather than as a set of zeroes. */
export const NO_VEHICLE: VehicleState = {
    connected: false,
    armed: false,
    mode: "—",
    position: null,
    attitude: null,
    groundspeed: null,
    vehicleKind: null,
    prearmPass: false,
    prearmReasons: [],
    disabledChecks: [],
    battery: {voltage: 0, current: 0, consumed: 0, percent: 0},
    gps: {fix: "none", satellites: 0, hdop: 0},
    link: {rssi: 0, lossPercent: 0},
    ekf: {ok: false, vibe: 0},
    updatedAt: 0,
};

/** `null` until a fix has actually arrived — distinct from a real 0,0 fix. */
function positionOf(snapshot: Snapshot): VehiclePosition | null {
    if (snapshot.lat === null || snapshot.lon === null) {
        return null;
    }
    return {
        lat: snapshot.lat,
        lon: snapshot.lon,
        alt: snapshot.relativeAlt ?? 0,
        // GLOBAL_POSITION_INT reports UINT16_MAX for "unknown" rather than
        // omitting the field, which the backend already resolves to null.
        heading: snapshot.heading ?? 0,
    };
}

/** `null` until a reading has actually arrived — distinct from a real 0/0 level attitude. */
function attitudeOf(snapshot: Snapshot): VehicleAttitude | null {
    if (snapshot.rollDeg == null || snapshot.pitchDeg == null) {
        return null;
    }
    return {roll: snapshot.rollDeg, pitch: snapshot.pitchDeg};
}

function fromSnapshot(snapshot: Snapshot): VehicleState {
    const sinceHeartbeat = snapshot.sinceHeartbeatMs;

    return {
        connected: sinceHeartbeat !== null,
        armed: snapshot.armed ?? false,
        mode: modeLabel(snapshot.vehicleKind, snapshot.customMode),
        position: positionOf(snapshot),
        attitude: attitudeOf(snapshot),
        groundspeed: snapshot.groundspeed ?? null,
        vehicleKind: snapshot.vehicleKind,
        prearmPass: snapshot.prearmPass ?? false,
        prearmReasons: [],
        disabledChecks: [],
        battery: {
            voltage: snapshot.batteryVoltage ?? 0,
            current: snapshot.batteryCurrent ?? 0,
            consumed: snapshot.batteryConsumedMah ?? 0,
            percent: snapshot.batteryPercent ?? 0,
        },
        gps: {
            fix: FIX_TYPES[snapshot.gpsFix ?? 0] ?? "none",
            satellites: snapshot.satellites ?? 0,
            hdop: snapshot.hdop ?? 0,
        },
        link: {
            rssi: snapshot.radioRssi ?? 0,
            lossPercent: snapshot.commDropPercent ?? 0,
        },
        // `ekfOk` defaults to `true` (rather than `false`, like every other
        // "not reported yet" field here) because its only effect is raising
        // `alertLevel` to `warn` — defaulting to "unhealthy" would falsely
        // flag every vehicle until EKF_STATUS_REPORT support lands.
        ekf: {ok: snapshot.ekfOk ?? true, vibe: snapshot.vibe ?? 0},
        // The backend reports heartbeat age, so the wall-clock time it arrived
        // is derived here and the staleness rules keep working unchanged.
        updatedAt: sinceHeartbeat === null ? 0 : Date.now() - sinceHeartbeat,
    };
}

export function useVehicle(): VehicleState {
    const [state, setState] = useState<VehicleState>(NO_VEHICLE);

    // Only telemetry is handled here. Link lifecycle arrives on `link-status`
    // and is the connection's concern, not the vehicle's — and the last
    // readings are deliberately kept after a link drops so they can be shown
    // struck through rather than blanked.
    useTauriEvent<Snapshot>("vehicle", (payload) => setState(fromSnapshot(payload)));

    return state;
}
