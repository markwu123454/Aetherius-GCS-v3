import {useSyncExternalStore} from "react";
import {listen} from "@tauri-apps/api/event";
import {createStore} from "@/lib/store.ts";
import {
    FixType,
    HomePosition,
    PREARM_TEXT_PREFIX,
    PrearmReason,
    VehicleAttitude,
    VehicleKind,
    VehiclePosition,
    VehicleState,
} from "./vehicle.ts";
import {modeLabel} from "./modes.ts";

/**
 * The payload emitted by `link.rs`. Every field is nullable because the backend
 * only fills one in once the corresponding message has actually arrived —
 * "not reported yet" and "reported as zero" are different things.
 *
 * `airspeed`, `climbRate`, `homeLat` and `homeLon` aren't sent by the backend
 * yet (no VFR_HUD/HOME_POSITION handling for them exists there yet) — typed
 * here ahead of that landing, same as `groundspeed` was before its own
 * backend support arrived.
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
    yawDeg: number | null;
    rollRateDps: number | null;
    pitchRateDps: number | null;
    yawRateDps: number | null;
    groundspeed?: number | null;
    airspeed?: number | null;
    climbRate?: number | null;
    homeLat?: number | null;
    homeLon?: number | null;
}

/** MAVLink GPS_FIX_TYPE. 0 (no GPS) and 1 (no fix) are both "no fix" to a pilot. */
const FIX_TYPES: FixType[] = ["none", "none", "2d", "3d", "dgps", "rtk-float", "rtk-fixed"];

/** Nothing known yet. Rendered as stale rather than as a set of zeroes. */
export const NO_VEHICLE: VehicleState = {
    connected: false,
    armed: false,
    mode: "—",
    customMode: null,
    position: null,
    home: null,
    attitude: null,
    groundspeed: null,
    airspeed: null,
    climbRate: null,
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
    return {
        roll: snapshot.rollDeg,
        pitch: snapshot.pitchDeg,
        yaw: snapshot.yawDeg ?? 0,
        rollRateDps: snapshot.rollRateDps ?? 0,
        pitchRateDps: snapshot.pitchRateDps ?? 0,
        yawRateDps: snapshot.yawRateDps ?? 0,
    };
}

/** `null` until ArduPilot has actually reported home — distinct from a real 0,0. */
function homeOf(snapshot: Snapshot): HomePosition | null {
    if (snapshot.homeLat == null || snapshot.homeLon == null) {
        return null;
    }
    return {lat: snapshot.homeLat, lon: snapshot.homeLon};
}

function fromSnapshot(snapshot: Snapshot): VehicleState {
    const sinceHeartbeat = snapshot.sinceHeartbeatMs;

    return {
        connected: sinceHeartbeat !== null,
        armed: snapshot.armed ?? false,
        mode: modeLabel(snapshot.vehicleKind, snapshot.customMode),
        customMode: snapshot.customMode,
        position: positionOf(snapshot),
        home: homeOf(snapshot),
        attitude: attitudeOf(snapshot),
        groundspeed: snapshot.groundspeed ?? null,
        airspeed: snapshot.airspeed ?? null,
        climbRate: snapshot.climbRate ?? null,
        vehicleKind: snapshot.vehicleKind,
        prearmPass: snapshot.prearmPass ?? false,
        // Merged in by `useVehicle` from `prearmReasonsStore`, which is fed by
        // the `statustext` event rather than this snapshot.
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

const vehicleStore = createStore<VehicleState>(NO_VEHICLE);

/** Emitted per STATUSTEXT line — the same event `useConsoleEvents` logs from. */
interface StatusTextEvent {
    severity: number;
    text: string;
}

/** Emitted per COMMAND_ACK — only `command` is needed here. */
interface CommandAckEvent {
    command: string;
}

/**
 * ArduPilot's `PreArm: ...` lines, kept separately from `vehicleStore` because
 * they arrive on a different event (`statustext`, not `vehicle`).
 *
 * ArduPilot never sends these incrementally — every time the checks re-run it
 * re-sends the *entire* current set of failing reasons as one burst, back to
 * back, then goes quiet until the next cycle. Reconciliation is keyed off the
 * backend's own re-trigger, not a debounce guess: every `PreArm:` line is
 * buffered, and the buffer replaces the store's contents wholesale exactly
 * when the next `MAV_CMD_RUN_PREARM_CHECKS` ack arrives — which reliably
 * marks "the previous cycle's burst is complete, a new one is starting." A
 * reason missing from that reconciliation is dropped immediately rather than
 * held over a grace cycle — a prior version tried that to hedge against a
 * single dropped STATUSTEXT, but a resolved check sitting in the list for one
 * extra cycle read as more confusing than the rare flicker this protects
 * against.
 */
const prearmReasonsStore = createStore<PrearmReason[]>([]);

/** Time of the most recent reconciliation (an ack) or pass-confirmation —
 * "how fresh is this list," shown in the panel instead of a per-reason age
 * now that every reason in a cycle arrives at the same moment anyway. */
const lastPrearmUpdateStore = createStore<number | null>(null);

let pendingReasonTexts: string[] = [];

function reconcilePendingReasons(): void {
    prearmReasonsStore.set([...new Set(pendingReasonTexts)].map((text) => ({text})));
    pendingReasonTexts = [];
}

listen<StatusTextEvent>("statustext", (message) => {
    const text = message.payload.text;
    if (!text.startsWith(PREARM_TEXT_PREFIX)) {
        return;
    }
    pendingReasonTexts.push(text.slice(PREARM_TEXT_PREFIX.length));
}).catch(() => {
    // No Tauri backend — the store just never updates.
});

listen<CommandAckEvent>("command-ack", (message) => {
    if (message.payload.command !== "MAV_CMD_RUN_PREARM_CHECKS") {
        return;
    }
    reconcilePendingReasons();
    lastPrearmUpdateStore.set(Date.now());
}).catch(() => {
    // No Tauri backend — the store just never updates.
});

/** Wall-clock time of the false→true `armed` edge, `null` while disarmed.
 * This is time-since-armed, not time-airborne — a vehicle can sit armed on
 * the ground for pre-flight checks, and some setups don't auto-disarm on
 * landing, so it's an upper bound on flight time rather than the thing
 * itself. A true airborne timer would need ArduPilot's `EXTENDED_SYS_STATE`
 * `landed_state`, which nothing here reads yet. */
const armedSinceStore = createStore<number | null>(null);
let wasArmed = false;

// Subscribed once, at module load, rather than per component: the readout is
// only meaningful if it keeps updating whether or not any panel showing it is
// currently mounted (a hidden tab, a closed panel, a background window), same
// reasoning as `consoleStore`. Only telemetry is handled here. Link lifecycle
// arrives on `link-status` and is the connection's concern, not the vehicle's
// — and the last readings are deliberately kept after a link drops so they
// can be shown struck through rather than blanked.
listen<Snapshot>("vehicle", (message) => {
    const state = fromSnapshot(message.payload);
    if (state.armed && !wasArmed) {
        armedSinceStore.set(Date.now());
    } else if (!state.armed && wasArmed) {
        armedSinceStore.set(null);
    }
    wasArmed = state.armed;
    vehicleStore.set(state);

    // Once checks pass, ArduPilot stops sending `PreArm:` lines entirely — no
    // ack-triggered reconciliation will ever clear the list on its own, so
    // this is the fallback that does. It's also a fresher, more immediate
    // signal than waiting for the next ack, so it updates the timestamp too.
    if (state.prearmPass) {
        pendingReasonTexts = [];
        if (prearmReasonsStore.getSnapshot().length > 0) {
            prearmReasonsStore.set([]);
            lastPrearmUpdateStore.set(Date.now());
        }
    }
}).catch(() => {
    // No Tauri backend (a plain browser tab) — the store just never updates.
});

export function useVehicle(): VehicleState {
    const state = useSyncExternalStore(vehicleStore.subscribe, vehicleStore.getSnapshot);
    const prearmReasons = useSyncExternalStore(prearmReasonsStore.subscribe, prearmReasonsStore.getSnapshot);
    return prearmReasons === state.prearmReasons ? state : {...state, prearmReasons};
}

/** `null` while disarmed. Pair with a ticking clock (e.g. `useNow`) to render
 * an elapsed duration — this only holds the edge timestamp, not a live count. */
export function useArmedSince(): number | null {
    return useSyncExternalStore(armedSinceStore.subscribe, armedSinceStore.getSnapshot);
}

/** `null` until the first prearm recheck cycle has been heard from. Pair with
 * a ticking clock (e.g. `useNow`) to render "Xs ago". */
export function usePrearmLastUpdate(): number | null {
    return useSyncExternalStore(lastPrearmUpdateStore.subscribe, lastPrearmUpdateStore.getSnapshot);
}

/** For stores that need the current vehicle state without subscribing to it
 * as a React value themselves — e.g. a sampler reading the latest snapshot on
 * its own timer. */
export function getVehicleSnapshot(): VehicleState {
    return vehicleStore.getSnapshot();
}
