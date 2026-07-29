import {useState} from "react";
import {useTauriEvent} from "../lib/tauriEvent";
import {FixType, VehicleKind, VehiclePosition, VehicleState} from "./vehicle";

/**
 * The payload emitted by `link.rs`. Every field is nullable because the backend
 * only fills one in once the corresponding message has actually arrived —
 * "not reported yet" and "reported as zero" are different things.
 */
interface Snapshot {
    armed: boolean | null;
    customMode: number | null;
    vehicleKind: VehicleKind | null;
    prearmPass: boolean | null;
    batteryVoltage: number | null;
    batteryCurrent: number | null;
    batteryPercent: number | null;
    gpsFix: number | null;
    satellites: number | null;
    hdop: number | null;
    lat: number | null;
    lon: number | null;
    relativeAlt: number | null;
    heading: number | null;
    sinceHeartbeatMs: number | null;
    dropRateComm?: number | null;
}

/** MAVLink GPS_FIX_TYPE. 0 (no GPS) and 1 (no fix) are both "no fix" to a pilot. */
const FIX_TYPES: FixType[] = ["none", "none", "2d", "3d", "dgps", "rtk-float", "rtk-fixed"];

/** Nothing known yet. Rendered as stale rather than as a set of zeroes. */
export const NO_VEHICLE: VehicleState = {
    connected: false,
    armed: false,
    mode: "—",
    position: null,
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

/**
 * Flight-mode numbers are only meaningful alongside the vehicle type — mode 3
 * is AUTO on Copter and TRAINING on Plane. Until the backend reports the type,
 * showing the raw number is the honest option; inventing a name from the wrong
 * table would be worse than showing none.
 */
function modeLabel(customMode: number | null): string {
    return customMode === null ? "—" : `MODE ${customMode}`;
}

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

function fromSnapshot(snapshot: Snapshot): VehicleState {
    const sinceHeartbeat = snapshot.sinceHeartbeatMs;

    return {
        connected: sinceHeartbeat !== null,
        armed: snapshot.armed ?? false,
        mode: modeLabel(snapshot.customMode),
        position: positionOf(snapshot),
        vehicleKind: snapshot.vehicleKind,
        prearmPass: snapshot.prearmPass ?? false,
        prearmReasons: [],
        disabledChecks: [],
        battery: {
            voltage: snapshot.batteryVoltage ?? 0,
            current: snapshot.batteryCurrent ?? 0,
            consumed: 0,
            percent: snapshot.batteryPercent ?? 0,
        },
        gps: {
            fix: FIX_TYPES[snapshot.gpsFix ?? 0] ?? "none",
            satellites: snapshot.satellites ?? 0,
            hdop: snapshot.hdop ?? 0,
        },
        link: {
            rssi: 0,
            // SYS_STATUS reports the comm drop rate in centi-percent.
            lossPercent: (snapshot.dropRateComm ?? 0) / 100,
        },
        ekf: {ok: true, vibe: 0},
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
