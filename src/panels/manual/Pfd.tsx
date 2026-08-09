import {useId} from "react";
import FitBox from "./FitBox.tsx";
import {useSettings} from "@/lib/settings/useSettings.ts";
import {convertSpeed, speedUnitDef} from "@/lib/units/speed.ts";
import {altitudeUnitDef, convertAltitude} from "@/lib/units/altitude.ts";

/** Radius the horizon ball fills. Bank ticks are painted on its own rim;
 * everything heading-related lives further out, in the annulus between here
 * and the bezel. */
const HORIZON_R = 34;
const BEZEL_R = 46;
/** SVG units per degree of pitch. Chosen so a generous ±30° pitch range still
 * keeps the horizon line inside the disc rather than pinned at its edge. */
const PX_PER_PITCH_DEG = 0.85;
/** Pitch-ladder rungs. Solid = climbing, dashed = descending — the line style
 * carries the sign, so labels never need a "−10" that fights for space. */
const PITCH_RUNGS = [10, 20, 30];
/** Bank-scale ticks, painted on the horizon ball's own rim so they rotate
 * with roll — 0/30/60 are major (longer, thicker), the rest minor. */
const BANK_TICKS = [0, 10, 20, 30, 45, 60];
const HEADING_MAJOR_TICKS = [0, 90, 180, 270];
const HEADING_MINOR_TICKS = [30, 60, 120, 150, 210, 240, 300, 330];

interface AttitudeIndicatorProps {
    heading: number;
    roll: number;
    pitch: number;
    /** No link has ever reported anything — shown as a flat, unlit disc
     * rather than a fake level horizon. */
    unknown: boolean;
    /** Connected, but ATTITUDE specifically hasn't arrived yet — kept
     * distinct from `unknown` since heading (from position, not attitude)
     * can already be live while this still isn't. */
    attitudeUnknown: boolean;
    /** Unit abbreviation for the GS corner label, following the operator's
     * speed unit preference — the flanking tape itself is scaled the same
     * way, by the caller. */
    speedSuffix: string;
    /** Same as `speedSuffix`, for the ALT corner label. */
    altSuffix: string;
}

/**
 * Horizon ball with a bank-angle scale and pitch ladder painted on it, plus a
 * quiet heading ring in the annulus outside — the ring costs no space the
 * ball would otherwise use. No heading letters or numbers on the ring itself:
 * that precision already lives in the text readout below the instrument, and
 * on the map. This instrument's job is answering "is the vehicle doing
 * something it shouldn't" at a glance, not being a manual flight reference.
 */
function AttitudeIndicator({heading, roll, pitch, unknown, attitudeUnknown, speedSuffix, altSuffix}: AttitudeIndicatorProps) {
    const clipId = useId();
    const showAttitude = !unknown && !attitudeUnknown;

    return (
        <svg
            viewBox="0 0 100 100"
            className="h-full w-full"
            role="img"
            aria-label={
                unknown
                    ? "Attitude unknown"
                    : `Heading ${Math.round(heading)} degrees, roll ${Math.round(roll)}, pitch ${Math.round(pitch)}`
            }
        >
            <defs>
                <clipPath id={clipId}>
                    <circle cx={50} cy={50} r={HORIZON_R}/>
                </clipPath>
            </defs>

            <circle cx={50} cy={50} r={BEZEL_R} className="fill-layer-01"/>

            {showAttitude ? (
                <g clipPath={`url(#${clipId})`}>
                    {/* Pitch shifts the ladder first, in the aircraft's own frame;
                        roll then banks that whole shifted picture around the
                        center — same order a real ADI composes the two in. */}
                    <g transform={`rotate(${-roll} 50 50)`}>
                        <g transform={`translate(0 ${pitch * PX_PER_PITCH_DEG})`}>
                            <rect x={-100} y={-300} width={300} height={350} className="fill-blue-60"/>
                            <rect x={-100} y={50} width={300} height={350} className="fill-orange-40"/>
                            {PITCH_RUNGS.flatMap((deg) =>
                                [1, -1].map((sign) => {
                                    const y = 50 - sign * deg * PX_PER_PITCH_DEG;
                                    return (
                                        <g key={`${deg}-${sign}`}>
                                            <line
                                                x1={42}
                                                y1={y}
                                                x2={58}
                                                y2={y}
                                                className="stroke-text-on-color"
                                                strokeWidth={1}
                                                strokeDasharray={sign < 0 ? "2,1.5" : undefined}
                                            />
                                            <text
                                                x={60}
                                                y={y}
                                                fontSize={4.5}
                                                dominantBaseline="central"
                                                className="fill-text-on-color font-mono"
                                            >
                                                {deg}
                                            </text>
                                        </g>
                                    );
                                }),
                            )}
                            <line x1={-10} y1={50} x2={110} y2={50} className="stroke-text-on-color" strokeWidth={1.5}/>
                        </g>
                    </g>
                </g>
            ) : (
                <circle cx={50} cy={50} r={HORIZON_R} className="fill-layer-02"/>
            )}

            {/* Bank-scale ticks — painted on the ball itself, rotating with roll only. */}
            {showAttitude && (
                <g transform={`rotate(${-roll} 50 50)`}>
                    {BANK_TICKS.flatMap((deg) =>
                        [1, -1]
                            .filter((sign) => deg !== 0 || sign > 0)
                            .map((sign) => {
                                const rad = ((sign * deg - 90) * Math.PI) / 180;
                                const major = deg === 0 || deg === 30 || deg === 60;
                                const inner = major ? 29.5 : 31;
                                return (
                                    <line
                                        key={`${deg}-${sign}`}
                                        x1={50 + Math.cos(rad) * inner}
                                        y1={50 + Math.sin(rad) * inner}
                                        x2={50 + Math.cos(rad) * HORIZON_R}
                                        y2={50 + Math.sin(rad) * HORIZON_R}
                                        className="stroke-text-on-color"
                                        strokeWidth={major ? 1.2 : 0.8}
                                    />
                                );
                            }),
                    )}
                </g>
            )}

            {/* Heading ring — lives entirely in the annulus outside the horizon
                ball, gated on heading alone since it comes from position, not
                ATTITUDE, and can be live before `showAttitude` is. */}
            {!unknown && (
                <g>
                    {HEADING_MAJOR_TICKS.map((deg) => {
                        const rad = ((deg - 90) * Math.PI) / 180;
                        return (
                            <line
                                key={deg}
                                x1={50 + Math.cos(rad) * 41}
                                y1={50 + Math.sin(rad) * 41}
                                x2={50 + Math.cos(rad) * 45}
                                y2={50 + Math.sin(rad) * 45}
                                className="stroke-text-helper"
                                strokeWidth={1}
                            />
                        );
                    })}
                    {HEADING_MINOR_TICKS.map((deg) => {
                        const rad = ((deg - 90) * Math.PI) / 180;
                        return (
                            <line
                                key={deg}
                                x1={50 + Math.cos(rad) * 42.5}
                                y1={50 + Math.sin(rad) * 42.5}
                                x2={50 + Math.cos(rad) * 45}
                                y2={50 + Math.sin(rad) * 45}
                                className="stroke-border-strong"
                                strokeWidth={0.6}
                            />
                        );
                    })}
                    {/* Base sits flush against the horizon disc's own rim; the tip
                        points outward toward the ring ticks. */}
                    <g transform={`rotate(${heading} 50 50)`}>
                        <polygon points="47.5,16 52.5,16 50,9" className="fill-text-secondary"/>
                    </g>
                </g>
            )}

            {/* Fixed aircraft reference — halo outline for contrast against sky
                or ground, never rotates or shifts since it represents the
                vehicle itself, not the world. */}
            {showAttitude && (
                <g strokeLinecap="round">
                    <g className="stroke-background" strokeWidth={4}>
                        <line x1={36} y1={50} x2={45} y2={50}/>
                        <line x1={55} y1={50} x2={64} y2={50}/>
                    </g>
                    <g className="stroke-text-on-color" strokeWidth={2}>
                        <line x1={36} y1={50} x2={45} y2={50}/>
                        <line x1={55} y1={50} x2={64} y2={50}/>
                    </g>
                    <circle cx={50} cy={50} r={1.6} className="fill-text-on-color"/>
                </g>
            )}

            <circle cx={50} cy={50} r={BEZEL_R} fill="none" className="stroke-border-subtle" strokeWidth={1}/>
            <circle cx={50} cy={50} r={HORIZON_R} fill="none" className="stroke-border-subtle" strokeWidth={0.75}/>

            {/* Corner labels — the square viewBox falls outside the circular
                bezel at its own corners no matter what, so that space is
                always free. GS and ALT live there permanently to label the
                flanking tapes, which otherwise carry no unit of their own —
                units are spelled out here too, same abbreviations used by
                the badges elsewhere in the panel (m/s, m). */}
            <text x={5} y={11} fontSize={4.5} className="fill-text-helper font-mono">GS {speedSuffix}</text>
            <text x={95} y={11} textAnchor="end" fontSize={4.5} className="fill-text-helper font-mono">ALT {altSuffix}</text>
        </svg>
    );
}

/** Natural pixel size of one tape and the horizon ball — not a rendering
 * constraint (both are plain SVGs that scale to whatever box they're given),
 * just the ratio `PFD_RATIO` below is computed from, and the coordinate
 * system the tape's own tick math runs in via its `viewBox`. */
const TAPE_WIDTH = 56;
const TAPE_HEIGHT = 288;
/** Matches `ManualPanel`'s old fixed layout: ball (`TAPE_HEIGHT` square) +
 * two tapes + two `gap-3` (0.75rem = 12px) gaps between the three, all at
 * their natural size. `Pfd`'s own `FitBox` scales this whole ratio up or
 * down as one rigid unit — the ball is never tapes-width narrower or wider
 * relative to its own height than this. */
const PFD_RATIO = (TAPE_WIDTH * 2 + TAPE_HEIGHT + 24) / TAPE_HEIGHT;

interface TapeProps {
    /** `null` when this specific reading hasn't arrived yet — rendered as a
     * bare ruler with no pointer or ticks, same "don't fake precision"
     * treatment as the horizon's own unknown state. */
    value: number | null;
    tickInterval: number;
    majorEvery: number;
    pxPerUnit: number;
    decimals: number;
    /** Decimal places for tick labels specifically — defaults to 0 (whole
     * numbers), since `majorEvery` is a whole number for every tape except
     * the groundspeed one in km/min. */
    tickDecimals?: number;
    side: "left" | "right";
}

/**
 * A vertical scrolling ruler with a fixed pointer and plain-text readout at
 * center, instead of a boxed gauge — consistent with how the horizon itself
 * shows pitch: the number lives on the moving scale, not in separate chrome.
 * The tape moves past the fixed value rather than the other way round, which
 * is what makes trend (climbing/descending, speeding up/slowing down)
 * readable as motion instead of requiring a watched number to change.
 */
function Tape({value, tickInterval, majorEvery, pxPerUnit, decimals, tickDecimals = 0, side}: TapeProps) {
    const centerY = TAPE_HEIGHT / 2;
    const innerX = side === "left" ? TAPE_WIDTH : 0;
    const dir = side === "left" ? -1 : 1;

    const ticks: {v: number; y: number; major: boolean}[] = [];
    if (value !== null) {
        const halfRange = centerY / pxPerUnit;
        const start = Math.ceil((value - halfRange) / tickInterval) * tickInterval;
        const end = Math.floor((value + halfRange) / tickInterval) * tickInterval;
        for (let v = start; v <= end + 1e-6; v += tickInterval) {
            const y = centerY - (v - value) * pxPerUnit;
            const major = Math.abs(Math.round(v / majorEvery) * majorEvery - v) < 1e-6;
            ticks.push({v, y, major});
        }
    }

    return (
        <svg
            viewBox={`0 0 ${TAPE_WIDTH} ${TAPE_HEIGHT}`}
            preserveAspectRatio="none"
            className="h-full"
            style={{aspectRatio: TAPE_WIDTH / TAPE_HEIGHT}}
            role="img"
            aria-label={value === null ? "unknown" : value.toFixed(decimals)}
        >
            <rect x={0} y={0} width={TAPE_WIDTH} height={TAPE_HEIGHT} className="fill-layer-01"/>

            {ticks.map(({v, y, major}) => {
                const len = major ? 8 : 5;
                return (
                    <g key={v}>
                        <line
                            x1={innerX}
                            y1={y}
                            x2={innerX + dir * len}
                            y2={y}
                            className="stroke-text-secondary"
                            strokeWidth={major ? 1.2 : 0.8}
                        />
                        {/* Suppressed near the pointer regardless of which tick
                            lands there — the readout at center already covers
                            this spot, and real telemetry will drift the value
                            across every possible tick position over time. */}
                        {major && Math.abs(y - centerY) > 9 && (
                            <text
                                x={innerX + dir * (len + 3)}
                                y={y}
                                fontSize={9.5}
                                dominantBaseline="central"
                                textAnchor={side === "left" ? "end" : "start"}
                                className="fill-text-secondary font-mono"
                            >
                                {v.toFixed(tickDecimals)}
                            </text>
                        )}
                    </g>
                );
            })}

            {value !== null && (
                <>
                    <path
                        d={
                            side === "left"
                                ? `M ${TAPE_WIDTH} ${centerY} L ${TAPE_WIDTH - 8} ${centerY - 4.5} L ${TAPE_WIDTH - 8} ${centerY + 4.5} Z`
                                : `M 0 ${centerY} L 8 ${centerY - 4.5} L 8 ${centerY + 4.5} Z`
                        }
                        className="fill-text-primary"
                    />
                    <text
                        x={side === "left" ? TAPE_WIDTH - 11 : 11}
                        y={centerY}
                        fontSize={12}
                        textAnchor={side === "left" ? "end" : "start"}
                        dominantBaseline="central"
                        className="fill-text-primary font-mono"
                    >
                        {value.toFixed(decimals)}
                    </text>
                </>
            )}

            <rect
                x={0.5}
                y={0.5}
                width={TAPE_WIDTH - 1}
                height={TAPE_HEIGHT - 1}
                fill="none"
                className="stroke-border-subtle"
                strokeWidth={1}
            />
        </svg>
    );
}

interface PfdProps {
    heading: number;
    roll: number;
    pitch: number;
    unknown: boolean;
    attitudeUnknown: boolean;
    groundspeed: number | null;
    alt: number | null;
}

/**
 * Horizon ball flanked by a groundspeed tape and an altitude tape — one
 * rigid instrument, never stretched out of `PFD_RATIO`. `FitBox` handles
 * fitting that ratio into whatever `ManualPanel`'s grid gives this cell;
 * everything in here just fills `FitBox`'s own resolved box via `h-full`,
 * the same way it always has.
 */
export default function Pfd({heading, roll, pitch, unknown, attitudeUnknown, groundspeed, alt}: PfdProps) {
    const {speedUnit, altitudeUnit} = useSettings();
    const speed = speedUnitDef(speedUnit);
    const altitude = altitudeUnitDef(altitudeUnit);
    const displaySpeed = groundspeed === null ? null : convertSpeed(groundspeed, speedUnit);
    const displayAlt = alt === null ? null : convertAltitude(alt, altitudeUnit);

    return (
        <FitBox ratio={PFD_RATIO} className="flex items-stretch justify-center gap-3">
            <div className="aspect-[56/288] h-full w-auto">
                <Tape
                    value={displaySpeed}
                    tickInterval={speed.tapeTick}
                    majorEvery={speed.tapeMajorEvery}
                    pxPerUnit={TAPE_HEIGHT / 2 / speed.tapeHalfRange}
                    decimals={speed.decimals}
                    tickDecimals={speed.tapeTickDecimals}
                    side="left"
                />
            </div>
            <div className="aspect-square h-full w-auto">
                <AttitudeIndicator
                    heading={heading}
                    roll={roll}
                    pitch={pitch}
                    unknown={unknown}
                    attitudeUnknown={attitudeUnknown}
                    speedSuffix={speed.suffix}
                    altSuffix={altitude.suffix}
                />
            </div>
            <div className="aspect-[56/288] h-full w-auto">
                <Tape
                    value={displayAlt}
                    tickInterval={altitude.tapeTick}
                    majorEvery={altitude.tapeMajorEvery}
                    pxPerUnit={TAPE_HEIGHT / 2 / altitude.tapeHalfRange}
                    decimals={altitude.decimals}
                    tickDecimals={altitude.tapeTickDecimals}
                    side="right"
                />
            </div>
        </FitBox>
    );
}
