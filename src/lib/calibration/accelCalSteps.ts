/**
 * ArduPilot's own `ACCELCAL_VEHICLE_POS` enum values (the ardupilotmega
 * MAVLink dialect) — the vehicle drives this sequence itself by sending
 * `COMMAND_LONG(MAV_CMD_ACCELCAL_VEHICLE_POS, param1=<one of these>)`, the
 * GCS doesn't choose the order. `SUCCESS`/`FAILED` are ArduPilot's actual
 * sentinel values (2^24-1 / 2^24), not placeholders.
 */
export const ACCEL_POS_LEVEL = 1;
export const ACCEL_POS_LEFT = 2;
export const ACCEL_POS_RIGHT = 3;
export const ACCEL_POS_NOSEDOWN = 4;
export const ACCEL_POS_NOSEUP = 5;
export const ACCEL_POS_BACK = 6;
export const ACCEL_POS_SUCCESS = 16777215;
export const ACCEL_POS_FAILED = 16777216;

export interface AccelCalStep {
    position: number;
    label: string;
    instruction: string;
    /** Target orientation for this step, relative to level — degrees, in
     * the same roll/pitch sign convention as ArduPilot's own `ATTITUDE`
     * message (positive roll = right wing down, positive pitch = nose up).
     * Yaw is deliberately absent: gravity's direction in the body frame
     * doesn't depend on heading, so no position here has a "correct" yaw. */
    rotationDeg: {roll: number; pitch: number};
}

/** The six-position sequence, in the fixed order ArduPilot drives it. */
export const ACCEL_CAL_STEPS: AccelCalStep[] = [
    {
        position: ACCEL_POS_LEVEL,
        label: "Level",
        instruction: "Place the vehicle level.",
        rotationDeg: {roll: 0, pitch: 0},
    },
    {
        position: ACCEL_POS_LEFT,
        label: "Left Side Down",
        instruction: "Rest the vehicle on its left side.",
        rotationDeg: {roll: -90, pitch: 0},
    },
    {
        position: ACCEL_POS_RIGHT,
        label: "Right Side Down",
        instruction: "Rest the vehicle on its right side.",
        rotationDeg: {roll: 90, pitch: 0},
    },
    {
        position: ACCEL_POS_NOSEDOWN,
        label: "Nose Down",
        instruction: "Stand the vehicle on its nose.",
        rotationDeg: {roll: 0, pitch: -90},
    },
    {
        position: ACCEL_POS_NOSEUP,
        label: "Nose Up",
        instruction: "Stand the vehicle on its tail.",
        rotationDeg: {roll: 0, pitch: 90},
    },
    {
        position: ACCEL_POS_BACK,
        label: "Upside Down",
        instruction: "Turn the vehicle upside down.",
        rotationDeg: {roll: 180, pitch: 0},
    },
];

export function accelStepFor(position: number): AccelCalStep | null {
    return ACCEL_CAL_STEPS.find((step) => step.position === position) ?? null;
}
