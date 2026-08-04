import {RC_CHANNEL_UNUSED} from "@/lib/calibration/rcChannels.ts";
import {StickFunction} from "@/lib/calibration/useRadioCalibration.ts";
import {LiveParamEntry} from "@/lib/params/liveParams.ts";

export const RCMAP_PARAM: Record<StickFunction, string> = {
    roll: "RCMAP_ROLL",
    pitch: "RCMAP_PITCH",
    throttle: "RCMAP_THROTTLE",
    yaw: "RCMAP_YAW",
};

// Mode 2 only — the overwhelmingly common convention, and what the
// calibration wizard itself defaults to.
export const LEFT_STICK: {vertical: StickFunction; horizontal: StickFunction} = {vertical: "throttle", horizontal: "yaw"};
export const RIGHT_STICK: {vertical: StickFunction; horizontal: StickFunction} = {vertical: "pitch", horizontal: "roll"};

/** Whether this channel is wired reversed — same check `useRadioCalibration`'s
 * `save()` uses, since ArduPilot's reversed-channel parameter changed name
 * and value scheme across firmware versions and both still turn up in the
 * wild. Checked once against channel 1 and assumed uniform, matching that
 * same code rather than re-deriving a new convention here. */
export function reversedParamIsBool(live: Map<string, LiveParamEntry>): boolean {
    return live.has("RC1_REVERSED");
}

export function isReversed(live: Map<string, LiveParamEntry>, channel: number, boolScheme: boolean): boolean {
    if (boolScheme) {
        return live.get(`RC${channel}_REVERSED`)?.value === 1;
    }
    return live.get(`RC${channel}_REV`)?.value === -1;
}

export interface ChannelCalibration {
    channel: number;
    min: number;
    max: number;
    trim: number;
    reversed: boolean;
}

/** Everything needed to convert one stick function to or from a raw PWM
 * value — the channel it's mapped to plus its calibration, resolved from
 * live `RCMAP_*`/`RCx_MIN`/`MAX`/`TRIM`/`REVERSED` params. `null` until the
 * vehicle has reported all of that. */
export function resolveChannelCalibration(
    fn: StickFunction,
    live: Map<string, LiveParamEntry>,
    boolScheme: boolean,
): ChannelCalibration | null {
    const mapped = live.get(RCMAP_PARAM[fn])?.value;
    if (mapped === undefined) {
        return null;
    }
    const channel = Math.round(mapped);
    const min = live.get(`RC${channel}_MIN`)?.value;
    const max = live.get(`RC${channel}_MAX`)?.value;
    const trim = live.get(`RC${channel}_TRIM`)?.value;
    if (min === undefined || max === undefined || trim === undefined) {
        return null;
    }
    return {channel, min, max, trim, reversed: isReversed(live, channel, boolScheme)};
}

/**
 * `-1..1` position on one axis from a raw PWM value. Throttle has no spring
 * return — its resting position is the bottom of its travel, not a centered
 * trim — so it's a plain lerp across `[min, max]` remapped to `[-1, 1]`.
 * Every other function is trim-centered, deflecting signed around wherever
 * the stick was actually trimmed rather than the geometric middle of
 * `min`/`max` (real transmitters are rarely trimmed to dead center).
 * Positive always means "right" for the horizontal functions and "up"/"more"
 * for the vertical ones — the same sense `useRadioCalibration`'s own detect
 * step treats as non-reversed.
 */
export function axisFromRaw(fn: StickFunction, raw: number, cal: ChannelCalibration): number {
    const {min, max, trim, reversed} = cal;
    let value: number;
    if (fn === "throttle") {
        value = max > min ? ((raw - min) / (max - min)) * 2 - 1 : 0;
    } else {
        const half = raw >= trim ? Math.max(1, max - trim) : Math.max(1, trim - min);
        value = (raw - trim) / half;
    }
    value = Math.min(1, Math.max(-1, value));
    return reversed ? -value : value;
}

/** The exact inverse of `axisFromRaw` — a `-1..1` stick position back to the
 * raw PWM value that would produce it, for sending as an override rather
 * than reading one off the real receiver. */
export function rawFromAxis(fn: StickFunction, axis: number, cal: ChannelCalibration): number {
    const {min, max, trim, reversed} = cal;
    const signed = reversed ? -axis : axis;
    let raw: number;
    if (fn === "throttle") {
        raw = max > min ? min + ((signed + 1) / 2) * (max - min) : trim;
    } else {
        const half = signed >= 0 ? Math.max(1, max - trim) : Math.max(1, trim - min);
        raw = trim + signed * half;
    }
    return Math.round(Math.min(Math.max(raw, min), max));
}

function resolveAxisFromChannels(
    fn: StickFunction,
    channels: number[] | null,
    live: Map<string, LiveParamEntry>,
    boolScheme: boolean,
): number | null {
    const cal = resolveChannelCalibration(fn, live, boolScheme);
    if (!cal || !channels) {
        return null;
    }
    const raw = channels[cal.channel - 1];
    if (raw === undefined || raw === RC_CHANNEL_UNUSED) {
        return null;
    }
    return axisFromRaw(fn, raw, cal);
}

/**
 * Where the transmitter's sticks actually are right now, read straight off
 * live RC_CHANNELS + the vehicle's own `RCMAP_*`/`RCx_MIN`/`MAX`/`TRIM`/
 * `REVERSED` — the same data `RadioCalibrationPanel`'s channel monitor uses,
 * just distilled to two stick positions instead of a per-channel bar list.
 */
export function resolveStick(
    layout: {vertical: StickFunction; horizontal: StickFunction},
    channels: number[] | null,
    live: Map<string, LiveParamEntry>,
    boolScheme: boolean,
): {x: number | null; y: number | null} {
    return {
        x: resolveAxisFromChannels(layout.horizontal, channels, live, boolScheme),
        y: resolveAxisFromChannels(layout.vertical, channels, live, boolScheme),
    };
}
