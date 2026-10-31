/**
 * ArduPilot's own throttle → PWM math, ported so Motors setup can draw what
 * the firmware will actually output for a given input. Each function names
 * the firmware function it mirrors (ArduPilot master, AP_Motors,
 * SRV_Channel, RC_Channel, ArduCopter/mode.cpp, ArduPlane/quadplane.cpp).
 * Battery voltage and air density compensation are left out: both scale the
 * curve at runtime from live sensor data, not from a parameter alone.
 */

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

/** AP_Math `expo_curve`. */
function expoCurve(alpha: number, x: number): number {
    return (1 - alpha) * x + alpha * x * x * x;
}

/** The pilot's throttle channel: `RCn_MIN`/`RCn_MAX`/`RCn_DZ` for `RCMAP_THROTTLE`'s n. */
export interface RcThrottle {
    min: number;
    max: number;
    deadZone: number;
}

/** `RC_Channel::pwm_to_range_dz`, normalised to 0–1. `stick` is the fraction
 * of physical travel from `min` to `max`; the dead zone only trims the
 * bottom of that travel. */
export function stickToControl(stick: number, rc: RcThrottle): number {
    const pwm = rc.min + clamp(stick, 0, 1) * (rc.max - rc.min);
    const low = rc.min + rc.deadZone;
    if (rc.max <= low || pwm <= low) return 0;
    return (pwm - low) / (rc.max - low);
}

/** Copter `Mode::get_pilot_desired_throttle` (Stabilize/Acro): bends the
 * stick so mid travel lands on `MOT_THST_HOVER`. */
export function copterStickThrottle(stick: number, rc: RcThrottle, hover: number): number {
    const control = stickToControl(stick, rc);
    let mid = stickToControl(0.5, rc);
    if (mid <= 0 || mid >= 1) mid = 0.5;
    const s = control < mid ? (control * 0.5) / mid : 0.5 + ((control - mid) * 0.5) / (1 - mid);
    const expo = clamp(-(hover - 0.5) / 0.375, -0.5, 1);
    return s * (1 - expo) + expo * s * s * s;
}

/** QuadPlane `get_pilot_throttle` (QStabilize/QAcro) through AP_Math
 * `throttle_curve`, `Q_THROTTLE_EXPO` as `expo`. */
export function quadplaneStickThrottle(stick: number, rc: RcThrottle, hover: number, expo: number): number {
    const input = stickToControl(stick, rc);
    if (!(expo > 0)) return input;
    const alpha = clamp(expo, 0, 1);
    const alpha2 = clamp(alpha + (1.25 * (1 - alpha) * (0.5 - hover)) / 0.5, 0, 1);
    const t = 2 * input - 1;
    return input < 0.5 ? hover * (expoCurve(alpha, t) + 1) : hover + (1 - hover) * expoCurve(alpha2, t);
}

/** The multirotor motor params that shape thrust → PWM. */
export interface MotorCurveParams {
    pwmMin: number;
    pwmMax: number;
    spinMin: number;
    spinMax: number;
    thrustExpo: number;
}

/** `Thrust_Linearization::thrust_to_actuator` with compensation at 1.0:
 * inverts thrust = (1 − e)·u + e·u², then squeezes the result between
 * `SPIN_MIN` and `SPIN_MAX`. */
export function thrustToActuator(thrust: number, p: MotorCurveParams): number {
    const t = clamp(thrust, 0, 1);
    const e = clamp(p.thrustExpo, -1, 1);
    const ratio = e === 0 ? t : clamp((e - 1 + Math.sqrt(Math.max(0, (1 - e) * (1 - e) + 4 * e * t))) / (2 * e), 0, 1);
    return p.spinMin + (p.spinMax - p.spinMin) * ratio;
}

/** `AP_MotorsMulticopter::output_to_pwm` for every spool state but shut-down. */
export function actuatorToPwm(actuator: number, p: MotorCurveParams): number {
    return p.pwmMin + (p.pwmMax - p.pwmMin) * actuator;
}

export function thrustToPwm(thrust: number, p: MotorCurveParams): number {
    return actuatorToPwm(thrustToActuator(thrust, p), p);
}

/** One output's own `SERVOx_MIN/TRIM/MAX/REVERSED`. */
export interface ServoRange {
    min: number;
    trim: number;
    max: number;
    reversed: boolean;
}

/** A scaled output's PWM through its own SERVOx params:
 * `SRV_Channel::pwm_from_range` for `percent` over 0–100, or
 * `pwm_from_angle` over ±100 with trim as zero when `angle`. Plane throttle
 * goes through it (as an angle once `THR_MIN` is negative), and so do
 * multirotor motors under PWMRange/PWMAngle. */
export function servoOutputPwm(percent: number, range: ServoRange, angle: boolean): number {
    if (!angle) {
        if (range.max <= range.min) return range.min;
        let scaled = clamp(percent, 0, 100);
        if (range.reversed) scaled = 100 - scaled;
        return range.min + (scaled * (range.max - range.min)) / 100;
    }
    let scaled = range.reversed ? -percent : percent;
    scaled = clamp(scaled, -100, 100);
    return scaled > 0
        ? range.trim + (scaled * (range.max - range.trim)) / 100
        : range.trim - (-scaled * (range.trim - range.min)) / 100;
}
