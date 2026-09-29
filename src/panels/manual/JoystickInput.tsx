import {type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useRef, useState} from "react";
import StickPair from "./StickPair.tsx";
import FitBox from "./FitBox.tsx";
import {useRcChannels} from "@/lib/calibration/useRcChannels.ts";
import {useLiveParams} from "@/lib/params/useLiveParams.ts";
import {RC_CHANNEL_UNUSED} from "@/lib/calibration/rcChannels.ts";
import {StickFunction} from "@/lib/calibration/useRadioCalibration.ts";
import {sendRcOverride} from "@/lib/vehicle/commands.ts";
import {useVehicle} from "@/lib/vehicle/useVehicle.ts";
import {useSettings} from "@/lib/settings/useSettings.ts";
import type {RcOverrideMatch} from "@/lib/settings/settings.ts";
import {
    axisFromRaw,
    type ChannelCalibration,
    LEFT_STICK,
    RIGHT_STICK,
    rawFromAxis,
    resolveChannelCalibration,
    resolveStick,
    reversedParamIsBool,
} from "@/lib/calibration/stickMapping.ts";

/** Natural size this settles into: `p-2` padding + 1px border on every side,
 * the status label, the two `STICK_SIZE`-square balls with their own
 * captions, and the bottom hint line — same `text-label`/`text-micro`
 * 1rem-line-height and `gap-*` accounting as `JoystickDisplay`'s `RATIO`.
 * Only used to compute `RATIO`; every piece actually renders at whatever
 * size `FitBox` resolves, via flex sizing, not this constant. */
const STICK_SIZE = 112;
const LABEL_LINE = 16;
const PADDING_AND_BORDER = 2 * (8 + 1);
const RATIO = (STICK_SIZE * 2 + 16 + PADDING_AND_BORDER) / (LABEL_LINE + 8 + STICK_SIZE + 4 + LABEL_LINE + 8 + LABEL_LINE + PADDING_AND_BORDER);

interface KeyMapping {
    axis: "x" | "y";
    sign: 1 | -1;
}

interface StickValue {
    x: number;
    y: number;
}

// WASD drives the left stick, arrow keys the right — the same physical
// left/right split a Mode 2 transmitter has (left = throttle/yaw axis,
// right = pitch/roll), just on a keyboard instead: each key is a discrete
// -1/0/1 push on one axis, not a proportional deflection.
const LEFT_KEYS: Record<string, KeyMapping> = {
    w: {axis: "y", sign: 1},
    s: {axis: "y", sign: -1},
    a: {axis: "x", sign: -1},
    d: {axis: "x", sign: 1},
};
const RIGHT_KEYS: Record<string, KeyMapping> = {
    ArrowUp: {axis: "y", sign: 1},
    ArrowDown: {axis: "y", sign: -1},
    ArrowLeft: {axis: "x", sign: -1},
    ArrowRight: {axis: "x", sign: 1},
};

/** Letter keys are matched case-insensitively (so Shift+W still counts as
 * "w"); arrow keys pass through as-is since they have no case to normalize. */
function normalizeKey(key: string): string {
    return key.length === 1 ? key.toLowerCase() : key;
}

function isTypingTarget(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
}

/** Full `-1..1` sweep takes about 0.8s of a key held down. */
const RAMP_RATE = 2.5;
/** How often an engaged override re-asserts itself over the link, whether or
 * not a stick moved this frame — fast enough to feel responsive and to stay
 * well inside ArduPilot's ~1s override timeout (`RC_OVERRIDE_TIME`, after
 * which it hands the channels back to the real transmitter), slow enough not
 * to flood the serial/radio link the way sending on every animation frame
 * would. */
const SEND_INTERVAL_MS = 100;

function clamp(value: number): number {
    return Math.min(1, Math.max(-1, value));
}

/** Net push on one axis from whatever's currently held — the two keys for
 * an axis cancel out if both are held, same as pushing a real lever both
 * ways at once. */
function axisRate(held: ReadonlySet<string>, keymap: Record<string, KeyMapping>, axis: "x" | "y"): number {
    let rate = 0;
    for (const key of held) {
        const mapping = keymap[key];
        if (mapping && mapping.axis === axis) {
            rate += mapping.sign;
        }
    }
    return rate * RAMP_RATE;
}

function axesFromSticks(left: StickValue, right: StickValue): Record<StickFunction, number> {
    return {
        [LEFT_STICK.vertical]: left.y,
        [LEFT_STICK.horizontal]: left.x,
        [RIGHT_STICK.vertical]: right.y,
        [RIGHT_STICK.horizontal]: right.x,
    } as Record<StickFunction, number>;
}

type Calibrations = Partial<Record<StickFunction, ChannelCalibration>>;

/** All four functions resolved to a channel `RC_CHANNELS_OVERRIDE` can
 * actually address (1-8) — sending with anything missing would silently
 * leave part of the vehicle on whatever the real transmitter last set while
 * the display claims full keyboard control, which is worse than not sending
 * at all. */
function fullyEngageable(cal: Calibrations): cal is Record<StickFunction, ChannelCalibration> {
    return (["roll", "pitch", "throttle", "yaw"] as StickFunction[]).every((fn) => {
        const c = cal[fn];
        // `resolveChannelCalibration` returns `null` (not `undefined`) when
        // it can't resolve yet, e.g. before connecting — `cal[fn]` is still
        // a *present* key with that `null` value, so this has to check both.
        return c !== null && c !== undefined && c.channel >= 1 && c.channel <= 8;
    });
}

/** `RC_CHANNEL_UNUSED` doubles as `RC_CHANNELS_OVERRIDE`'s own "ignore this
 * field" sentinel — same numeric value (`u16::MAX`), different message. */
function overrideChannels(axes: Record<StickFunction, number>, cal: Record<StickFunction, ChannelCalibration>): number[] {
    const channels = new Array(8).fill(RC_CHANNEL_UNUSED);
    (["roll", "pitch", "throttle", "yaw"] as StickFunction[]).forEach((fn) => {
        channels[cal[fn].channel - 1] = rawFromAxis(fn, axes[fn], cal[fn]);
    });
    return channels;
}

/** MAVLink's own "release this channel back to the RC radio" sentinel for
 * `RC_CHANNELS_OVERRIDE` — `0`, distinct from `RC_CHANNEL_UNUSED`'s "ignore
 * this field". */
const RELEASE_CHANNEL = 0;

/** Throttle lever all the way down. */
const THROTTLE_MIN = -1;

/**
 * Keyboard-driven manual control. While unfocused, both sticks mirror the
 * real RC input verbatim — this widget IS the RC monitor when nobody's
 * driving it. The moment it's focused, it switches to commanding an
 * `RC_CHANNELS_OVERRIDE`: from that instant on, this — not the transmitter —
 * is what the vehicle listens to, even before any key is touched. See
 * `seedSticks` for where the sticks start. WASD/arrows then ramp from there
 * like a friction lever; `r` snaps roll/pitch/yaw back to center but leaves
 * throttle alone, since a real lever has no center to return to.
 *
 * Losing focus releases roll/pitch/yaw back to the real transmitter — same
 * as `r`, but as MAVLink's own release sentinel rather than a commanded
 * center, so whatever the transmitter's sticks are actually doing takes over
 * immediately. Throttle is sent once more at wherever it was left rather
 * than released, since there's no equivalent "let go and it returns to a
 * sensible value" for a lever with no center. No further commands go out
 * after that one message — this is genuinely off, not idling — so ArduPilot
 * drops that throttle override too once `RC_OVERRIDE_TIME` passes without it
 * being re-sent.
 */
function useManualControl(
    focused: boolean,
    calibrations: Calibrations,
    rawChannels: number[] | null,
    armed: boolean,
    match: RcOverrideMatch,
) {
    const [held, setHeld] = useState<ReadonlySet<string>>(new Set());
    const heldRef = useRef(held);
    heldRef.current = held;

    const [left, setLeft] = useState<StickValue>({x: 0, y: 0});
    const [right, setRight] = useState<StickValue>({x: 0, y: 0});
    const leftRef = useRef(left);
    leftRef.current = left;
    const rightRef = useRef(right);
    rightRef.current = right;

    const calibrationsRef = useRef(calibrations);
    calibrationsRef.current = calibrations;
    const rawChannelsRef = useRef(rawChannels);
    rawChannelsRef.current = rawChannels;
    const armedRef = useRef(armed);
    armedRef.current = armed;
    const matchRef = useRef(match);
    matchRef.current = match;

    // Set for a focus session that couldn't be seeded safely — see
    // `seedSticks`. Nothing is sent for the rest of that session; clicking
    // back in once there's a throttle reading tries again.
    const [blocked, setBlocked] = useState(false);
    const blockedRef = useRef(blocked);
    blockedRef.current = blocked;

    // Whether this "focus session" ever actually sent an override — a blur
    // with this still false means either the widget was never really
    // engaged (no calibration yet) or this is the initial mount's own
    // `focused === false`, neither of which should trigger a release.
    const engagedRef = useRef(false);
    const lastSendRef = useRef(0);
    // The last real value this widget commanded on each channel, ignoring
    // the "ignore" and "release" sentinels. Kept across focus sessions:
    // RC_CHANNELS reports overridden values, not just the receiver, and after
    // a release with no receiver fitted ArduPilot keeps reporting the last
    // deflection it was given — so this is what tells `seedSticks` "that's
    // our own echo" apart from "that's where the transmitter is".
    const lastCommandedRef = useRef<(number | null)[]>(new Array(8).fill(null));

    const transmit = (channels: number[]) => {
        channels.forEach((value, index) => {
            if (value !== RC_CHANNEL_UNUSED && value !== RELEASE_CHANNEL) {
                lastCommandedRef.current[index] = value;
            }
        });
        try {
            void sendRcOverride(channels).catch(() => {});
        } catch {
            // No Tauri backend (plain browser dev) — nothing to send to.
        }
    };

    const send = (l: StickValue, r: StickValue) => {
        const cal = calibrationsRef.current;
        if (blockedRef.current || !fullyEngageable(cal)) {
            return;
        }
        engagedRef.current = true;
        lastSendRef.current = performance.now();
        transmit(overrideChannels(axesFromSticks(l, r), cal));
    };

    // One channel's live reading as a stick axis, or null when there's
    // nothing trustworthy there: no reading, a sentinel, or — unless
    // `allowEcho` — just this widget's own last command reflected back.
    const reading = (fn: StickFunction, allowEcho: boolean): number | null => {
        const cal = calibrationsRef.current[fn];
        if (!cal) {
            return null;
        }
        const raw = rawChannelsRef.current?.[cal.channel - 1];
        if (raw === undefined || raw === RC_CHANNEL_UNUSED || raw === RELEASE_CHANNEL) {
            return null;
        }
        if (!allowEcho && raw === lastCommandedRef.current[cal.channel - 1]) {
            return null;
        }
        return axisFromRaw(fn, raw, cal);
    };

    // Where the sticks start when a focus session begins, per the
    // `rcOverrideMatch` setting: each stick that's matched picks up the
    // transmitter's live position, and anything unmatched (or with no
    // trustworthy reading) starts centered, throttle at minimum.
    //
    // Armed overrides that for throttle regardless of the setting: it starts
    // at whatever the vehicle is currently flying on — RC_CHANNELS, echo
    // included since an echo is exactly what it's flying on, then this
    // widget's own last command. Snapping to minimum mid-air is the one thing
    // worse than a stale value, and so is guessing, so with neither available
    // this returns null and the session doesn't engage at all.
    const seedSticks = (): {left: StickValue; right: StickValue} | null => {
        const match = matchRef.current;
        const stick = (fn: StickFunction) => (match === "all" ? reading(fn, false) ?? 0 : 0);

        let throttle: number | null;
        if (armedRef.current) {
            const cal = calibrationsRef.current.throttle;
            const commanded = cal ? lastCommandedRef.current[cal.channel - 1] : null;
            throttle = reading("throttle", true) ?? (cal && commanded != null ? axisFromRaw("throttle", commanded, cal) : null);
            if (throttle === null) {
                return null;
            }
        } else {
            throttle = match === "none" ? THROTTLE_MIN : reading("throttle", false) ?? THROTTLE_MIN;
        }

        return {
            left: {x: stick(LEFT_STICK.horizontal), y: throttle},
            right: {x: stick(RIGHT_STICK.horizontal), y: stick(RIGHT_STICK.vertical)},
        };
    };

    // Called from the focus *event*, alongside `setFocused(true)`, so the
    // seeded sticks land in the same render that switches the display over
    // to them. Seeding from an effect instead left one committed frame
    // showing the previous session's sticks before the seed replaced them.
    // `blocked` is written here too and read through its ref, which the
    // focus effect sees after that same render commits.
    const beginSession = () => {
        const seed = seedSticks();
        setHeld(new Set());
        setBlocked(seed === null);
        if (seed) {
            setLeft(seed.left);
            setRight(seed.right);
        }
    };

    // The blur counterpart to `send` — releases roll/pitch/yaw back to the
    // real transmitter and leaves throttle latched at `l.y`, then marks this
    // focus session as no longer engaged so nothing further goes out.
    const release = (l: StickValue) => {
        const cal = calibrationsRef.current;
        if (!engagedRef.current || !fullyEngageable(cal)) {
            engagedRef.current = false;
            return;
        }
        const channels = new Array(8).fill(RC_CHANNEL_UNUSED);
        channels[cal.roll.channel - 1] = RELEASE_CHANNEL;
        channels[cal.pitch.channel - 1] = RELEASE_CHANNEL;
        channels[cal.yaw.channel - 1] = RELEASE_CHANNEL;
        channels[cal.throttle.channel - 1] = rawFromAxis("throttle", l.y, cal.throttle);
        engagedRef.current = false;
        transmit(channels);
    };

    // Focus is the "press in": latch the sticks `beginSession` already seeded
    // in as the override. By the time this runs, the render that set
    // `focused` has also committed the seed, so the refs hold it — not the
    // previous session's values. Blur is the release, described on `release`
    // above.
    useEffect(() => {
        if (!focused) {
            setHeld(new Set());
            release(leftRef.current);
            return;
        }
        send(leftRef.current, rightRef.current);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [focused]);

    // The blur effect above only runs `release` when `focused` transitions
    // to `false` — it does nothing if the component instead disappears while
    // still focused (torn out of a dock tab that unmounts its inactive
    // panels, or its floating window closed mid-override). This is that
    // case's own release, run once from unmount regardless of which render's
    // closure fires it: `release` reads everything through refs, so it sees
    // live values at cleanup time rather than whatever was current when this
    // effect was set up.
    useEffect(() => {
        return () => release(leftRef.current);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (!focused) {
            return;
        }

        const relevant = (key: string) => key in LEFT_KEYS || key in RIGHT_KEYS;

        // Functional updates throughout, reading no state outside the
        // updater: two keys pressed in the same tick (a fast diagonal, or a
        // browser coalescing input) dispatch two keydowns before React
        // re-renders between them, so anything that read `held` at
        // handler-call-time would see the same stale snapshot twice and the
        // second setHeld would silently clobber the first.
        const onKeyDown = (event: KeyboardEvent) => {
            if (isTypingTarget(event.target)) {
                return;
            }
            const key = normalizeKey(event.key);
            if (key === "r") {
                event.preventDefault();
                const nextLeft = {...leftRef.current, x: 0};
                const nextRight = {x: 0, y: 0};
                setLeft(nextLeft);
                setRight(nextRight);
                send(nextLeft, nextRight);
                return;
            }
            if (!relevant(key)) {
                return;
            }
            event.preventDefault();
            setHeld((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
        };
        const onKeyUp = (event: KeyboardEvent) => {
            const key = normalizeKey(event.key);
            if (!relevant(key)) {
                return;
            }
            setHeld((prev) => {
                if (!prev.has(key)) {
                    return prev;
                }
                const next = new Set(prev);
                next.delete(key);
                return next;
            });
        };
        const onBlur = () => setHeld(new Set());

        window.addEventListener("keydown", onKeyDown);
        window.addEventListener("keyup", onKeyUp);
        window.addEventListener("blur", onBlur);
        return () => {
            window.removeEventListener("keydown", onKeyDown);
            window.removeEventListener("keyup", onKeyUp);
            window.removeEventListener("blur", onBlur);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [focused]);

    // One persistent ramp loop for the component's whole lifetime rather
    // than starting/stopping it as keys go up and down — it already reads
    // `held` fresh every frame via the ref and skips all state writes the
    // instant nothing's pushing an axis, so an idle loop costs one
    // early-return per frame, not a real render.
    useEffect(() => {
        let frame: number;
        let lastTime: number | null = null;

        const tick = (time: number) => {
            frame = requestAnimationFrame(tick);
            if (lastTime === null) {
                lastTime = time;
                return;
            }
            const dt = (time - lastTime) / 1000;
            lastTime = time;

            const heldNow = heldRef.current;
            let nextLeft = leftRef.current;
            let nextRight = rightRef.current;

            if (heldNow.size > 0) {
                const lRateX = axisRate(heldNow, LEFT_KEYS, "x");
                const lRateY = axisRate(heldNow, LEFT_KEYS, "y");
                if (lRateX !== 0 || lRateY !== 0) {
                    nextLeft = {x: clamp(nextLeft.x + lRateX * dt), y: clamp(nextLeft.y + lRateY * dt)};
                    setLeft(nextLeft);
                }

                const rRateX = axisRate(heldNow, RIGHT_KEYS, "x");
                const rRateY = axisRate(heldNow, RIGHT_KEYS, "y");
                if (rRateX !== 0 || rRateY !== 0) {
                    nextRight = {x: clamp(nextRight.x + rRateX * dt), y: clamp(nextRight.y + rRateY * dt)};
                    setRight(nextRight);
                }
            }

            // Re-assert the override on a fixed cadence whether or not a stick
            // moved this frame: ArduPilot times the override out and reverts to
            // the real transmitter within ~1s of the last RC_CHANNELS_OVERRIDE
            // it heard, so a stick held still has to keep being re-sent, not
            // just a moving one. `engagedRef` scopes the heartbeat to a live
            // focus session — `release` (blur/unmount) clears it, so a released
            // widget goes genuinely silent instead of idling out a heartbeat
            // that would re-grab control the operator just let go of.
            if (engagedRef.current && time - lastSendRef.current >= SEND_INTERVAL_MS) {
                send(nextLeft, nextRight);
            }
        };

        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
    }, []);

    return {left, right, blocked, beginSession};
}

export default function JoystickInput() {
    const [focused, setFocused] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    const channels = useRcChannels();
    const {values: live} = useLiveParams();
    const boolScheme = useMemo(() => reversedParamIsBool(live), [live]);
    const mirrored = useMemo(
        () => ({
            left: resolveStick(LEFT_STICK, channels, live, boolScheme),
            right: resolveStick(RIGHT_STICK, channels, live, boolScheme),
        }),
        [channels, live, boolScheme],
    );
    const calibrations = useMemo<Calibrations>(
        () =>
            Object.fromEntries(
                (["roll", "pitch", "throttle", "yaw"] as StickFunction[]).map((fn) => [fn, resolveChannelCalibration(fn, live, boolScheme)]),
            ),
        [live, boolScheme],
    );

    const {armed} = useVehicle();
    const {rcOverrideMatch} = useSettings();
    const {
        left: controlledLeft,
        right: controlledRight,
        blocked,
        beginSession,
    } = useManualControl(focused, calibrations, channels, armed, rcOverrideMatch);
    // A blocked session sends nothing, so it keeps showing the live input
    // rather than sticks that aren't commanding anything.
    const commanding = focused && !blocked;
    const left = commanding ? controlledLeft : mirrored.left;
    const right = commanding ? controlledRight : mirrored.right;

    // Escape is the explicit "move out" — Tab and click-away already blur
    // the element on their own, this just gives keyboard-only users a way to
    // release without reaching for the mouse or tabbing past every other
    // control on the page.
    const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Escape") {
            containerRef.current?.blur();
        }
    };

    const sending = commanding && fullyEngageable(calibrations);

    return (
        <FitBox
            ref={containerRef}
            ratio={RATIO}
            tabIndex={0}
            onFocus={() => {
                // Both updates batch into one render — see `beginSession`.
                // Guarded because a focus event can arrive while already
                // focused, and re-seeding then would yank the sticks.
                if (!focused) {
                    beginSession();
                    setFocused(true);
                }
            }}
            onBlur={() => setFocused(false)}
            onKeyDown={onKeyDown}
            className={`flex flex-col items-center gap-2 border p-2 ${focused ? "border-state-info bg-layer-hover-01" : "border-transparent"}`}
        >
            <span className={`text-label ${focused ? "text-state-info" : "text-text-helper"}`}>
                {focused
                    ? sending
                        ? "Sending — Esc or click away to release"
                        : blocked
                            ? "Armed with no throttle reading — not sending"
                            : "RC overriding — not connected, not sending"
                    : "Click to enable RC override"}
            </span>
            <StickPair left={left} right={right} leftLabel="W A S D" rightLabel="Arrow keys"/>
            <span className="text-micro text-text-helper">R resets roll/pitch/yaw</span>
        </FitBox>
    );
}
