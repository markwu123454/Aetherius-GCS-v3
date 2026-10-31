import {findFrameLayout} from "@/lib/frames/motorLayouts.ts";
import {LiveParamEntry} from "./liveParams.ts";
import {ParamOption, VehicleFirmware} from "./paramSheet.ts";

/**
 * Which servo outputs drive a motor, and which of their own `SERVOx_*`
 * params the firmware still reads. Motors don't go through an output's
 * MIN/TRIM/MAX the way a servo does — see each rule below for the firmware
 * path it follows (ArduPilot master: AP_Motors_Class.cpp `rc_write`,
 * SRV_Channel.cpp, AP_BLHeli.cpp, ArduPlane/servos.cpp).
 */

/** Which of an output's own `SERVOx_*` params the firmware reads. */
export interface ServoFields {
    min: boolean;
    trim: boolean;
    max: boolean;
    reversed: boolean;
}

const NO_FIELDS: ServoFields = {min: false, trim: false, max: false, reversed: false};

export interface MotorOutput {
    /** The `n` in `SERVOn_*`. */
    channel: number;
    /** "Motor 5", "Throttle Left". */
    label: string;
    /** `multirotor`: the motor mixer, ranged by `MOT_`/`Q_M_`. `throttle`:
     * Plane's fixed-wing throttle, ranged by the output's own SERVOx params. */
    source: "multirotor" | "throttle";
    /** DShot: ArduPilot pins the output's range to 1000–2000 itself. */
    digital: boolean;
    servoFields: ServoFields;
}

/** The multirotor motor group: `MOT_` on Copter, `Q_M_` on a QuadPlane. */
export interface MultirotorConfig {
    prefix: "MOT_" | "Q_M_";
    /** PWM/OneShot update rate. */
    speedParam: "RC_SPEED" | "Q_RC_SPEED";
    frameClassParam: "FRAME_CLASS" | "Q_FRAME_CLASS";
    frameTypeParam: "FRAME_TYPE" | "Q_FRAME_TYPE";
}

/** `null` when the vehicle reports no motor group: a Heli build (H_ params
 * instead), or a Plane without `Q_ENABLE`. */
export function multirotorConfig(firmware: VehicleFirmware, live: Map<string, LiveParamEntry>): MultirotorConfig | null {
    if (firmware === "ArduCopter") {
        return live.has("MOT_PWM_TYPE")
            ? {prefix: "MOT_", speedParam: "RC_SPEED", frameClassParam: "FRAME_CLASS", frameTypeParam: "FRAME_TYPE"}
            : null;
    }
    return live.has("Q_M_PWM_TYPE")
        ? {prefix: "Q_M_", speedParam: "Q_RC_SPEED", frameClassParam: "Q_FRAME_CLASS", frameTypeParam: "Q_FRAME_TYPE"}
        : null;
}

/** `MOT_PWM_TYPE`: 4–7 are DShot150…1200. */
export function isDshotType(type: number): boolean {
    return type >= 4 && type <= 7;
}

/** `MOT_PWM_TYPE` 8 (PWMRange) and 9 (PWMAngle): motors honour each output's
 * own SERVOx range instead of `MOT_PWM_MIN/MAX`. */
export const PWM_TYPE_RANGE = 8;
export const PWM_TYPE_ANGLE = 9;

/** Bit `bit` of a mask up to 32 bits wide — plain `&` goes negative at bit 31. */
export function hasBit(mask: number, bit: number): boolean {
    return Math.floor(Math.round(mask) / 2 ** bit) % 2 === 1;
}

export function withBit(mask: number, bit: number, on: boolean): number {
    const current = Math.round(mask);
    if (hasBit(current, bit) === on) return current;
    return on ? current + 2 ** bit : current - 2 ** bit;
}

/** `SERVO_BLH_MASK` + a DShot `SERVO_BLH_OTYPE` turns an output digital
 * whatever drives it. */
function blhDigital(live: Map<string, LiveParamEntry>, channel: number): boolean {
    const type = Math.round(live.get("SERVO_BLH_OTYPE")?.value ?? 0);
    return isDshotType(type) && hasBit(live.get("SERVO_BLH_MASK")?.value ?? 0, channel - 1);
}

/** The mixer writes motors as raw PWM (`set_output_pwm`), bypassing the
 * output's SERVOx params, except under PWMRange/PWMAngle where it writes a
 * scaled value through them. Digital outputs have them forced. */
function multirotorFields(pwmType: number, digital: boolean): ServoFields {
    if (digital) return NO_FIELDS;
    if (pwmType === PWM_TYPE_RANGE) return {min: true, trim: false, max: true, reversed: true};
    if (pwmType === PWM_TYPE_ANGLE) return {min: true, trim: true, max: true, reversed: true};
    return NO_FIELDS;
}

const THROTTLE_LABELS: Record<string, string> = {
    Throttle: "Throttle",
    ThrottleLeft: "Throttle Left",
    ThrottleRight: "Throttle Right",
};

/**
 * Every output, in channel order, that drives a motor.
 *
 * - `MotorN` with a motor group: a motor, unless the frame layout marks that
 *   MotorN as a servo (Coax/Single fins, Tri's tail) — those are written as
 *   angles through the output's SERVOx params like any servo.
 * - Copter `ThrottleLeft/Right`: BiCopter's two motors, raw PWM from
 *   `MOT_PWM_MIN/MAX`. Copter's plain `Throttle` is a scaled output and stays
 *   a servo row.
 * - Plane `Throttle`/`ThrottleLeft`/`ThrottleRight`: fixed-wing throttle as a
 *   0–100% value through the output's MIN/MAX, and through TRIM as zero
 *   thrust once `THR_MIN` is negative. (A tailsitter's VTOL left/right
 *   motors use `Q_M_PWM` instead; forward flight is what's modelled here.)
 */
export function findMotorOutputs(
    firmware: VehicleFirmware,
    live: Map<string, LiveParamEntry>,
    functionValues: ParamOption[],
    outputCount: number,
): MotorOutput[] {
    const labels = new Map(functionValues.map((o) => [o.value, o.label]));
    const multi = multirotorConfig(firmware, live);
    const frameClass = multi ? live.get(multi.frameClassParam)?.value : undefined;
    const layout = multi && frameClass !== undefined
        ? findFrameLayout(Math.round(frameClass), Math.round(live.get(multi.frameTypeParam)?.value ?? 0))
        : null;
    const pwmType = multi ? Math.round(live.get(`${multi.prefix}PWM_TYPE`)?.value ?? 0) : 0;
    const reverseThrust = (live.get("THR_MIN")?.value ?? 0) < 0;

    const outputs: MotorOutput[] = [];
    for (let n = 1; n <= outputCount; n++) {
        const entry = live.get(`SERVO${n}_FUNCTION`);
        const label = entry ? labels.get(Math.round(entry.value)) : undefined;
        if (!label) continue;

        const motor = /^Motor(\d+)$/.exec(label);
        if (motor) {
            if (!multi) continue;
            const number = Number(motor[1]);
            if (layout?.motors.find((m) => m.number === number)?.kind === "servo") continue;
            const digital = isDshotType(pwmType) || blhDigital(live, n);
            outputs.push({channel: n, label: `Motor ${number}`, source: "multirotor", digital, servoFields: multirotorFields(pwmType, digital)});
            continue;
        }

        const throttle = THROTTLE_LABELS[label];
        if (!throttle) continue;
        if (firmware === "ArduCopter") {
            if (multi && label !== "Throttle") {
                outputs.push({channel: n, label: throttle, source: "multirotor", digital: isDshotType(pwmType) || blhDigital(live, n), servoFields: NO_FIELDS});
            }
            continue;
        }
        const digital = blhDigital(live, n);
        outputs.push({
            channel: n,
            label: throttle,
            source: "throttle",
            digital,
            servoFields: digital ? NO_FIELDS : {min: true, trim: reverseThrust, max: true, reversed: true},
        });
    }
    return outputs;
}
