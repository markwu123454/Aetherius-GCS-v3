import {VehicleKind} from "./vehicle";

/**
 * ArduPilot's `custom_mode` is only meaningful alongside vehicle type — mode 3
 * is AUTO on Copter and TRAINING on Plane. One table per type it's actually
 * possible to distinguish; `Other` (Rover, sub, antenna tracker, ...) has no
 * table of its own yet, since nothing here can tell those apart.
 */
const COPTER_MODES: Record<number, string> = {
    0: "STABILIZE",
    1: "ACRO",
    2: "ALT HOLD",
    3: "AUTO",
    4: "GUIDED",
    5: "LOITER",
    6: "RTL",
    7: "CIRCLE",
    9: "LAND",
    11: "DRIFT",
    13: "SPORT",
    14: "FLIP",
    15: "AUTOTUNE",
    16: "POSHOLD",
    17: "BRAKE",
    18: "THROW",
    19: "AVOID ADSB",
    20: "GUIDED NOGPS",
    21: "SMART RTL",
    22: "FLOWHOLD",
    23: "FOLLOW",
    24: "ZIGZAG",
    25: "SYSTEMID",
    26: "AUTOROTATE",
    27: "AUTO RTL",
    28: "TURTLE",
};

const PLANE_MODES: Record<number, string> = {
    0: "MANUAL",
    1: "CIRCLE",
    2: "STABILIZE",
    3: "TRAINING",
    4: "ACRO",
    5: "FBWA",
    6: "FBWB",
    7: "CRUISE",
    8: "AUTOTUNE",
    10: "AUTO",
    11: "RTL",
    12: "LOITER",
    13: "TAKEOFF",
    14: "AVOID ADSB",
    15: "GUIDED",
    17: "QSTABILIZE",
    18: "QHOVER",
    19: "QLOITER",
    20: "QLAND",
    21: "QRTL",
    22: "QAUTOTUNE",
    23: "QACRO",
    24: "THERMAL",
    25: "LOITER ALT QLAND",
};

/**
 * `customMode === null` means no HEARTBEAT has arrived yet. A number outside
 * the table means a mode this list doesn't know about — shown as the raw
 * number rather than hidden, since that's still more useful to an operator
 * than nothing.
 */
export function modeLabel(vehicleKind: VehicleKind | null, customMode: number | null): string {
    if (customMode === null) {
        return "—";
    }

    const table = vehicleKind === "multirotor" ? COPTER_MODES : vehicleKind === "plane" ? PLANE_MODES : null;
    return table?.[customMode] ?? `MODE ${customMode}`;
}
