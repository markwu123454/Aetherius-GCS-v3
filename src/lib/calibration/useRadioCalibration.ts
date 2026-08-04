import {useCallback, useEffect, useRef, useState} from "react";
import {setParam} from "@/lib/params/liveParams.ts";
import {LiveParamEntry} from "@/lib/params/liveParams.ts";
import {VehicleKind} from "@/lib/vehicle/vehicle.ts";
import {RC_CHANNEL_UNUSED} from "./rcChannels.ts";

export type StickFunction = "throttle" | "yaw" | "roll" | "pitch";

export interface ChannelCalInfo {
    function: StickFunction | null;
    reversed: boolean;
    min: number;
    max: number;
    trim: number;
}

type StepRole = "detect" | "confirm" | null;

export interface CalibrationStep {
    id: string;
    function: StickFunction | null;
    role: StepRole;
    /** Whether this step advances itself once a channel settles (true), or
     * needs a manual "Continue" click (false) — mirrors QGroundControl's
     * `nextButtonFn` being null vs set for a given state. */
    auto: boolean;
    instruction: string;
    /** Which physical direction this step is asking for, for the stick
     * diagram — `null` for steps not about one specific stick movement. */
    direction: {axis: "vertical" | "horizontal"; sign: 1 | -1} | null;
}

/**
 * Mirrors QGroundControl's own RC calibration state machine
 * (`RemoteControlCalibrationController`'s `_stateMachine`), scoped to the
 * four primary axes — no PX4-style extension axes, no joystick mode.
 */
export const STEPS: CalibrationStep[] = [
    {
        id: "neutral",
        function: null,
        role: null,
        auto: false,
        direction: null,
        instruction:
            "Center the Roll, Pitch, and Yaw sticks, and any switches or dials, in their normal resting " +
            "position. Lower the Throttle stick all the way down. Then continue.",
    },
    {
        id: "throttleMax",
        function: "throttle",
        role: "detect",
        auto: true,
        direction: {axis: "vertical", sign: 1},
        instruction: "Move the Throttle stick all the way up and hold it there.",
    },
    {
        id: "throttleMin",
        function: "throttle",
        role: "confirm",
        auto: true,
        direction: {axis: "vertical", sign: -1},
        instruction: "Move the Throttle stick all the way down and hold it there.",
    },
    {
        id: "yawRight",
        function: "yaw",
        role: "detect",
        auto: true,
        direction: {axis: "horizontal", sign: 1},
        instruction: "Move the Yaw stick all the way to the right and hold it there.",
    },
    {
        id: "yawLeft",
        function: "yaw",
        role: "confirm",
        auto: true,
        direction: {axis: "horizontal", sign: -1},
        instruction: "Move the Yaw stick all the way to the left and hold it there.",
    },
    {
        id: "rollRight",
        function: "roll",
        role: "detect",
        auto: true,
        direction: {axis: "horizontal", sign: 1},
        instruction: "Move the Roll stick all the way to the right and hold it there.",
    },
    {
        id: "rollLeft",
        function: "roll",
        role: "confirm",
        auto: true,
        direction: {axis: "horizontal", sign: -1},
        instruction: "Move the Roll stick all the way to the left and hold it there.",
    },
    {
        id: "pitchUp",
        function: "pitch",
        role: "detect",
        auto: true,
        direction: {axis: "vertical", sign: 1},
        instruction: "Move the Pitch stick all the way up and hold it there.",
    },
    {
        id: "pitchDown",
        function: "pitch",
        role: "confirm",
        auto: true,
        direction: {axis: "vertical", sign: -1},
        instruction: "Move the Pitch stick all the way down and hold it there.",
    },
    {
        id: "switches",
        function: null,
        role: null,
        auto: false,
        direction: null,
        instruction: "Move every remaining switch and dial back and forth through its full range. Continue when done.",
    },
    {
        id: "save",
        function: null,
        role: null,
        auto: false,
        direction: null,
        instruction: "All settings captured. Save to write the new calibration to the vehicle.",
    },
];

// ArduPilot's own firmware defaults, and the exact thresholds
// `RadioComponentController`'s constructor uses — matched here rather than
// invented, since they're tuned against real transmitter noise.
const CENTER = 1500;
/** How far a channel must move from where it was when the current step
 * began before it's "being moved" rather than noise. */
const MOVE_DELTA = 300;
/** How little a channel may drift, once selected, while still counting as
 * holding still at its extreme. */
const SETTLE_DELTA = 20;
/** How long it must hold that still before the extreme is accepted. */
const SETTLE_MS = 1000;

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

interface Detecting {
    channel: number;
    value: number;
    settleStart: number | null;
}

/** The channel currently claimed for a function, read back out of
 * `results` rather than tracked separately — one source of truth for
 * "who has this function so far". */
function channelForFunction(results: Map<number, ChannelCalInfo>, fn: StickFunction): number | null {
    for (const [channel, info] of results) {
        if (info.function === fn) {
            return channel;
        }
    }
    return null;
}

/**
 * Re-implements QGroundControl's own RC calibration algorithm
 * (`RemoteControlCalibrationController`): trim is a single snapshot taken
 * the moment the operator confirms everything is at rest ("neutral" step),
 * not asked for again later. Each of Throttle/Yaw/Roll/Pitch is identified
 * by which channel actually moves — not assumed from `RCMAP_*` — detecting
 * reversal in the process. Anything left over (switches, dials) is swept
 * for min/max only, with no trim or identity of its own.
 */
export function useRadioCalibration(
    channels: number[] | null,
    vehicleKind: VehicleKind | null,
    live: Map<string, LiveParamEntry>,
) {
    const [stepIndex, setStepIndex] = useState(-1);
    const [results, setResults] = useState<Map<number, ChannelCalInfo>>(new Map());
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    // Mirrored alongside the state so effects always read the latest value
    // synchronously, without waiting for a re-render.
    const resultsRef = useRef(results);
    const trimsRef = useRef<Map<number, number>>(new Map());
    // The channel values "when the current detect step began" — QGC
    // re-snapshots this on every state transition (`_saveCurrentRawValues`,
    // called from `_advanceState`), not just once at the very start; reusing
    // a single wizard-start snapshot for every axis would compare a step's
    // movement against a baseline that's steps stale.
    const startValuesRef = useRef<number[]>([]);
    const snapshotStepRef = useRef(-1);
    const detectingRef = useRef<Detecting | null>(null);

    const step = stepIndex >= 0 ? STEPS[stepIndex] : null;
    const calibrating = stepIndex >= 0;

    const setResultsBoth = useCallback((next: Map<number, ChannelCalInfo>) => {
        resultsRef.current = next;
        setResults(next);
    }, []);

    const start = useCallback(() => {
        setError(null);
        trimsRef.current = new Map();
        startValuesRef.current = [];
        snapshotStepRef.current = -1;
        detectingRef.current = null;
        setResultsBoth(new Map());
        setStepIndex(0);
    }, [setResultsBoth]);

    const cancel = useCallback(() => {
        setStepIndex(-1);
        setError(null);
        detectingRef.current = null;
        setResultsBoth(new Map());
    }, [setResultsBoth]);

    // Manual advance — only meaningful for the two non-auto steps
    // ("neutral" and "switches"); every step in between advances itself once
    // a channel actually settles at its extreme.
    const next = useCallback(() => {
        if (!step || step.auto || !channels) {
            return;
        }
        if (step.id === "neutral") {
            trimsRef.current = new Map(channels.map((value, index) => [index, value]));
        }
        setStepIndex((index) => index + 1);
    }, [step, channels]);

    // Drives every auto step: detect which channel moved (the "detect" half
    // of a function pair) or wait for the already-claimed one to settle at
    // its opposite extreme (the "confirm" half). Mirrors
    // `_inputStickDetect`/`_inputStickMin` exactly, including their
    // thresholds.
    useEffect(() => {
        if (!step || !step.auto || !step.function || !channels) {
            return;
        }
        const fn = step.function;

        if (step.role === "detect") {
            // A fresh detect step needs a fresh "what did every channel look
            // like when this step began" baseline — see `startValuesRef`.
            if (snapshotStepRef.current !== stepIndex) {
                startValuesRef.current = [...channels];
                snapshotStepRef.current = stepIndex;
                detectingRef.current = null;
            }
            const startValues = startValuesRef.current;
            const detecting = detectingRef.current;

            if (!detecting) {
                for (let ch = 0; ch < channels.length; ch++) {
                    if (resultsRef.current.has(ch)) {
                        continue; // already claimed by an earlier function
                    }
                    const value = channels[ch];
                    if (value === RC_CHANNEL_UNUSED) {
                        continue;
                    }
                    if (Math.abs(value - (startValues[ch] ?? CENTER)) > MOVE_DELTA) {
                        detectingRef.current = {channel: ch, value, settleStart: null};
                        return;
                    }
                }
                return;
            }

            const value = channels[detecting.channel];
            if (Math.abs(detecting.value - value) > SETTLE_DELTA) {
                detectingRef.current = {channel: detecting.channel, value, settleStart: null};
                return;
            }
            if (detecting.settleStart === null) {
                detectingRef.current = {...detecting, settleStart: Date.now()};
                return;
            }
            if (Date.now() - detecting.settleStart < SETTLE_MS) {
                return;
            }

            // A non-reversed channel reads higher than where it started;
            // one that moved the "wrong" way is reversed.
            const reversed = value < (startValues[detecting.channel] ?? CENTER);
            const updated = new Map(resultsRef.current);
            updated.set(detecting.channel, {
                function: fn,
                reversed,
                min: reversed ? value : CENTER,
                max: reversed ? CENTER : value,
                trim: trimsRef.current.get(detecting.channel) ?? CENTER,
            });
            setResultsBoth(updated);
            detectingRef.current = null;
            setStepIndex((index) => index + 1);
            return;
        }

        // role === "confirm" — waiting for the channel this function already
        // claimed to cross back past center and settle at the other extreme.
        // Unlike "detect", this is judged against the fixed center point,
        // not a per-step snapshot.
        const channel = channelForFunction(resultsRef.current, fn);
        if (channel === null) {
            return; // shouldn't happen — "detect" always precedes "confirm"
        }
        const info = resultsRef.current.get(channel)!;
        const value = channels[channel];
        const detecting = detectingRef.current;

        if (!detecting) {
            const crossedBack = info.reversed ? value > CENTER + MOVE_DELTA : value < CENTER - MOVE_DELTA;
            if (crossedBack) {
                detectingRef.current = {channel, value, settleStart: null};
            }
            return;
        }

        if (Math.abs(detecting.value - value) > SETTLE_DELTA) {
            detectingRef.current = {channel, value, settleStart: null};
            return;
        }
        if (detecting.settleStart === null) {
            detectingRef.current = {...detecting, settleStart: Date.now()};
            return;
        }
        if (Date.now() - detecting.settleStart < SETTLE_MS) {
            return;
        }

        const updated = new Map(resultsRef.current);
        updated.set(channel, {
            ...info,
            min: info.reversed ? info.min : value,
            max: info.reversed ? value : info.max,
            // ArduPilot doesn't use throttle trim for non-reversed throttle
            // at all, but QGC still captures it as this low extreme rather
            // than the step-0 snapshot — matched here for parity, and it's
            // where the stick actually ends up regardless.
            trim: fn === "throttle" ? value : info.trim,
        });
        setResultsBoth(updated);
        detectingRef.current = null;
        setStepIndex((index) => index + 1);
    }, [channels, step, stepIndex, setResultsBoth]);

    // Sweeps every not-yet-claimed channel for min/max while on the
    // "switches" step — no settle-detection needed, a switch or dial doesn't
    // need to be held still, just passed through its range.
    useEffect(() => {
        if (!step || step.id !== "switches" || !channels) {
            return;
        }
        const updated = new Map(resultsRef.current);
        let changed = false;
        channels.forEach((value, index) => {
            if (updated.has(index) || value === RC_CHANNEL_UNUSED) {
                return;
            }
            if (Math.abs(value - CENTER) <= MOVE_DELTA) {
                return;
            }
            const existing = updated.get(index);
            updated.set(index, {
                function: null,
                reversed: false,
                min: existing ? Math.min(existing.min, value) : Math.min(CENTER, value),
                max: existing ? Math.max(existing.max, value) : Math.max(CENTER, value),
                trim: trimsRef.current.get(index) ?? CENTER,
            });
            changed = true;
        });
        if (changed) {
            setResultsBoth(updated);
        }
    }, [channels, step, setResultsBoth]);

    const save = useCallback(async () => {
        setSaving(true);
        setError(null);
        try {
            const throttleChannel = channelForFunction(resultsRef.current, "throttle");
            const throttleInfo = throttleChannel !== null ? resultsRef.current.get(throttleChannel) : undefined;
            // Same safety rule QGC applies: a genuinely reversed throttle on
            // a multirotor is refused rather than saved — firmware doesn't
            // uniformly handle that safely at power-up.
            if (vehicleKind === "multirotor" && throttleInfo?.reversed) {
                throw new Error(
                    "Throttle appears reversed on this receiver. Refusing to save — check its wiring/channel before recalibrating.",
                );
            }

            // ArduPilot's reversed-channel parameter changed name and value
            // scheme across firmware versions; QGC checks which one exists
            // rather than assuming.
            const reversedIsBool = live.has("RC1_REVERSED");

            for (const [index, info] of resultsRef.current) {
                const channel = index + 1;
                await setParam(`RC${channel}_MIN`, info.min);
                await setParam(`RC${channel}_MAX`, info.max);
                await setParam(`RC${channel}_TRIM`, info.trim);

                if (info.function) {
                    // ArduCopter's own pitch axis has a backwards sense for
                    // "reversed" relative to the other three — matched from
                    // QGC's `_saveStoredCalibrationValues`, not guessed.
                    const paramReversed =
                        vehicleKind === "multirotor" && info.function === "pitch" ? !info.reversed : info.reversed;
                    const paramName = reversedIsBool ? `RC${channel}_REVERSED` : `RC${channel}_REV`;
                    await setParam(paramName, reversedIsBool ? (paramReversed ? 1 : 0) : paramReversed ? -1 : 1);
                }
            }

            const rcmapParam: Record<StickFunction, string> = {
                roll: "RCMAP_ROLL",
                pitch: "RCMAP_PITCH",
                throttle: "RCMAP_THROTTLE",
                yaw: "RCMAP_YAW",
            };
            for (const fn of Object.keys(rcmapParam) as StickFunction[]) {
                const channel = channelForFunction(resultsRef.current, fn);
                if (channel !== null) {
                    await setParam(rcmapParam[fn], channel + 1);
                }
            }

            setStepIndex(-1);
            setResultsBoth(new Map());
        } catch (err) {
            setError(message(err));
        } finally {
            setSaving(false);
        }
    }, [vehicleKind, live, setResultsBoth]);

    return {step, stepIndex, calibrating, results, error, saving, start, next, cancel, save};
}
