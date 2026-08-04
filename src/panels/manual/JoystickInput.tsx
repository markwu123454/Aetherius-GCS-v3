import {type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useRef, useState} from "react";
import StickBall from "./StickBall.tsx";
import {useRcChannels} from "@/lib/calibration/useRcChannels.ts";
import {useLiveParams} from "@/lib/params/useLiveParams.ts";
import {RC_CHANNEL_UNUSED} from "@/lib/calibration/rcChannels.ts";
import {StickFunction} from "@/lib/calibration/useRadioCalibration.ts";
import {sendRcOverride} from "@/lib/vehicle/commands.ts";
import {
    type ChannelCalibration,
    LEFT_STICK,
    RIGHT_STICK,
    rawFromAxis,
    resolveChannelCalibration,
    resolveStick,
    reversedParamIsBool,
} from "@/lib/calibration/stickMapping.ts";

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
/** How often a held key actually pushes a new override out over the link —
 * fast enough to feel responsive, slow enough not to flood the serial/radio
 * link the way sending on every animation frame would. */
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

/**
 * Keyboard-driven manual control. While unfocused, both sticks mirror the
 * real RC input verbatim — this widget IS the RC monitor when nobody's
 * driving it. The moment it's focused, both sticks freeze exactly where the
 * mirror left them and switch to commanding an `RC_CHANNELS_OVERRIDE`
 * instead: from that instant on, this — not the transmitter — is what the
 * vehicle listens to, even before any key is touched. WASD/arrows then ramp
 * from there like a friction lever, same as before `r` snaps roll/pitch/yaw
 * back to center but leaves throttle alone, since a real lever has no center
 * to return to.
 *
 * Losing focus releases roll/pitch/yaw back to the real transmitter — same
 * as `r`, but as MAVLink's own release sentinel rather than a commanded
 * center, so whatever the transmitter's sticks are actually doing takes over
 * immediately. Throttle is the one exception: it stays overridden, latched
 * at wherever it was left, since there's no equivalent "let go and it
 * returns to a sensible value" for a lever with no center. No further
 * commands go out after that one release message — this is genuinely off,
 * not idling.
 */
interface MirroredSticks {
    left: {x: number | null; y: number | null};
    right: {x: number | null; y: number | null};
}

function useManualControl(focused: boolean, mirrored: MirroredSticks, calibrations: Calibrations) {
    const [held, setHeld] = useState<ReadonlySet<string>>(new Set());
    const heldRef = useRef(held);
    heldRef.current = held;

    const [left, setLeft] = useState<StickValue>({x: 0, y: 0});
    const [right, setRight] = useState<StickValue>({x: 0, y: 0});
    const leftRef = useRef(left);
    leftRef.current = left;
    const rightRef = useRef(right);
    rightRef.current = right;

    const mirroredRef = useRef(mirrored);
    mirroredRef.current = mirrored;
    const calibrationsRef = useRef(calibrations);
    calibrationsRef.current = calibrations;

    // Whether this "focus session" ever actually sent an override — a blur
    // with this still false means either the widget was never really
    // engaged (no calibration yet) or this is the initial mount's own
    // `focused === false`, neither of which should trigger a release.
    const engagedRef = useRef(false);
    const lastSendRef = useRef(0);

    const send = (l: StickValue, r: StickValue) => {
        const cal = calibrationsRef.current;
        if (!fullyEngageable(cal)) {
            return;
        }
        engagedRef.current = true;
        lastSendRef.current = performance.now();
        try {
            void sendRcOverride(overrideChannels(axesFromSticks(l, r), cal)).catch(() => {});
        } catch {
            // No Tauri backend (plain browser dev) — nothing to send to.
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
        try {
            void sendRcOverride(channels).catch(() => {});
        } catch {
            // No Tauri backend (plain browser dev) — nothing to send to.
        }
    };

    // Focus is the "press in": freeze both sticks at whatever the mirror was
    // just showing and immediately latch that in as the override. Blur is
    // the release, described on `release` above.
    useEffect(() => {
        if (!focused) {
            setHeld(new Set());
            release(leftRef.current);
            return;
        }
        const seedLeft = {x: mirroredRef.current.left.x ?? 0, y: mirroredRef.current.left.y ?? 0};
        const seedRight = {x: mirroredRef.current.right.x ?? 0, y: mirroredRef.current.right.y ?? 0};
        setLeft(seedLeft);
        setRight(seedRight);
        send(seedLeft, seedRight);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [focused]);

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
            let changed = false;

            if (heldNow.size > 0) {
                const lRateX = axisRate(heldNow, LEFT_KEYS, "x");
                const lRateY = axisRate(heldNow, LEFT_KEYS, "y");
                if (lRateX !== 0 || lRateY !== 0) {
                    nextLeft = {x: clamp(nextLeft.x + lRateX * dt), y: clamp(nextLeft.y + lRateY * dt)};
                    setLeft(nextLeft);
                    changed = true;
                }

                const rRateX = axisRate(heldNow, RIGHT_KEYS, "x");
                const rRateY = axisRate(heldNow, RIGHT_KEYS, "y");
                if (rRateX !== 0 || rRateY !== 0) {
                    nextRight = {x: clamp(nextRight.x + rRateX * dt), y: clamp(nextRight.y + rRateY * dt)};
                    setRight(nextRight);
                    changed = true;
                }
            }

            if (changed && time - lastSendRef.current >= SEND_INTERVAL_MS) {
                send(nextLeft, nextRight);
            }
        };

        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
    }, []);

    return {left, right};
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

    const {left: controlledLeft, right: controlledRight} = useManualControl(focused, mirrored, calibrations);
    const left = focused ? controlledLeft : mirrored.left;
    const right = focused ? controlledRight : mirrored.right;

    // Escape is the explicit "move out" — Tab and click-away already blur
    // the element on their own, this just gives keyboard-only users a way to
    // release without reaching for the mouse or tabbing past every other
    // control on the page.
    const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Escape") {
            containerRef.current?.blur();
        }
    };

    const sending = focused && fullyEngageable(calibrations);

    return (
        <div
            ref={containerRef}
            tabIndex={0}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={onKeyDown}
            className={`flex flex-col items-center gap-2 border p-2 ${focused ? "border-state-info bg-layer-hover-01" : "border-transparent"}`}
        >
            <span className={`text-label ${focused ? "text-state-info" : "text-text-helper"}`}>
                {focused
                    ? sending
                        ? "Sending — Esc or click away to release"
                        : "Armed — not connected, not sending"
                    : "Click to enable RC override"}
            </span>
            <div className="flex gap-4">
                <div className="flex flex-col items-center gap-1">
                    <div className="h-28 w-28">
                        <StickBall x={left.x} y={left.y}/>
                    </div>
                    <span className="text-micro text-text-helper">W A S D</span>
                </div>
                <div className="flex flex-col items-center gap-1">
                    <div className="h-28 w-28">
                        <StickBall x={right.x} y={right.y}/>
                    </div>
                    <span className="text-micro text-text-helper">Arrow keys</span>
                </div>
            </div>
            <span className="text-micro text-text-helper">R resets roll/pitch/yaw</span>
        </div>
    );
}
