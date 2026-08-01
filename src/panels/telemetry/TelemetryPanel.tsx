import {useId} from "react";
import {useConnection} from "../../lib/vehicle/useConnection.ts";
import {isLinkFailing, isLinkIdle} from "../../lib/vehicle/connection.ts";
import {useVehicle} from "../../lib/vehicle/useVehicle.ts";
import {useNow} from "../../lib/vehicle/useMockVehicle.ts";
import {useTelemetryHistory} from "../../lib/vehicle/useTelemetryHistory.ts";
import {fixLabel} from "../../lib/vehicle/vehicle.ts";
import {Tone, TONE_TEXT} from "../../components/topmenu/StatusChip.tsx";
import Sparkline from "../../components/Sparkline.tsx";

const BAR_TONE: Record<Tone, string> = {
    ok: "bg-state-ok",
    warn: "bg-state-warn",
    danger: "bg-state-danger",
    info: "bg-state-info",
    neutral: "bg-text-helper",
};

function batteryTone(percent: number): Tone {
    if (percent <= 15) return "danger";
    if (percent <= 25) return "warn";
    return "ok";
}

function gpsTone(fix: string): Tone {
    if (fix === "none") return "danger";
    if (fix === "2d") return "warn";
    return "ok";
}

/**
 * No project-specific threshold exists for this yet — these mirror
 * ArduPilot's own published guidance (stay under ~30 on any axis, ideally
 * under 15) rather than a value derived from this app's own data.
 */
function vibeTone(vibe: number): Tone {
    if (vibe >= 30) return "danger";
    if (vibe >= 15) return "warn";
    return "ok";
}

interface BadgeProps {
    label: string;
    value: string;
    tone?: Tone;
    title?: string;
}

function Badge({label, value, tone = "neutral", title}: BadgeProps) {
    return (
        <div title={title} className="flex flex-col gap-0.5 border border-border-subtle bg-layer-01 px-2 py-1.5">
            <span className="text-micro text-text-helper uppercase">{label}</span>
            <span className={`font-mono text-label tabular-nums ${TONE_TEXT[tone]}`}>{value}</span>
        </div>
    );
}

interface BatteryGaugeProps {
    percent: number;
    voltage: number;
    current: number;
    consumed: number;
    tone: Tone;
    unknown: boolean;
}

function BatteryGauge({percent, voltage, current, consumed, tone, unknown}: BatteryGaugeProps) {
    const clamped = Math.max(0, Math.min(100, percent));
    return (
        <div className="@xs:col-span-2 flex flex-col gap-1 border border-border-subtle bg-layer-01 px-2 py-1.5">
            <div className="flex items-center justify-between">
                <span className="text-micro text-text-helper uppercase">Battery</span>
                <span className={`font-mono text-label tabular-nums ${TONE_TEXT[tone]}`}>
                    {unknown ? "—" : `${Math.round(clamped)}%`}
                </span>
            </div>
            <div className="h-1.5 w-full bg-layer-02">
                <div
                    className={`h-full ${BAR_TONE[tone]} transition-[width] duration-300 ease-productive`}
                    style={{width: `${unknown ? 0 : clamped}%`}}
                />
            </div>
            <div className="flex justify-between font-mono text-micro text-text-helper tabular-nums">
                <span>{unknown ? "—" : `${voltage.toFixed(1)}V`}</span>
                <span>{unknown ? "—" : `${current.toFixed(1)}A`}</span>
                <span>{unknown ? "—" : `${Math.round(consumed)}mAh`}</span>
            </div>
        </div>
    );
}

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
}

/**
 * Horizon ball with a bank-angle scale and pitch ladder painted on it, plus a
 * quiet heading ring in the annulus outside — the ring costs no space the
 * ball would otherwise use. No heading letters or numbers on the ring itself:
 * that precision already lives in the text readout below the instrument, and
 * on the map. This instrument's job is answering "is the vehicle doing
 * something it shouldn't" at a glance, not being a manual flight reference.
 */
function AttitudeIndicator({heading, roll, pitch, unknown, attitudeUnknown}: AttitudeIndicatorProps) {
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
        </svg>
    );
}

const TAPE_WIDTH = 44;
const TAPE_HEIGHT = 224;

interface TapeProps {
    /** `null` when this specific reading hasn't arrived yet — rendered as a
     * bare ruler with no pointer or ticks, same "don't fake precision"
     * treatment as the horizon's own unknown state. */
    value: number | null;
    tickInterval: number;
    majorEvery: number;
    pxPerUnit: number;
    decimals: number;
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
function Tape({value, tickInterval, majorEvery, pxPerUnit, decimals, side}: TapeProps) {
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
            className="h-full w-11"
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
                                {Math.round(v)}
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

interface SparkRowProps {
    label: string;
    tone: Tone;
    values: number[];
    min: number;
    max: number;
    display: string;
}

function SparkRow({label, tone, values, min, max, display}: SparkRowProps) {
    return (
        <div className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-micro text-text-helper uppercase">{label}</span>
            <Sparkline values={values} min={min} max={max} className={`h-6 w-full min-w-0 flex-1 ${TONE_TEXT[tone]}`}/>
            <span className={`w-14 shrink-0 text-right font-mono text-micro tabular-nums ${TONE_TEXT[tone]}`}>
                {display}
            </span>
        </div>
    );
}

export default function TelemetryPanel() {
    const vehicle = useVehicle();
    const connection = useConnection();
    const now = useNow();
    const history = useTelemetryHistory(vehicle);

    const packetAge = vehicle.updatedAt === 0 ? null : now - vehicle.updatedAt;
    const stale = isLinkFailing(connection.status);
    // Distinct from `stale`: this is "never heard from", which reads as a set
    // of unmistakable dashes rather than a struck-through zero.
    const unknown = isLinkIdle(connection.status) || vehicle.updatedAt === 0;
    const staleFor = stale && packetAge !== null ? Math.round(packetAge / 1000) : null;

    const heading = vehicle.position?.heading ?? 0;
    const alt = vehicle.position?.alt ?? null;
    const roll = vehicle.attitude?.roll ?? 0;
    const pitch = vehicle.attitude?.pitch ?? 0;
    const attitudeUnknown = vehicle.attitude === null;

    const battTone = batteryTone(vehicle.battery.percent);
    const gTone = gpsTone(vehicle.gps.fix);
    const eTone: Tone = vehicle.ekf.ok ? "ok" : "danger";
    const lTone: Tone = vehicle.link.lossPercent > 5 ? "warn" : "ok";
    const vTone = vibeTone(vehicle.ekf.vibe);

    return (
        // `@container`, not viewport breakpoints — this panel can be a 320px
        // side dock or a 1400px bottom dock in the same session, and switches
        // from a vertical stack to a horizontal instrument row at `@xl` based
        // on its own box, not the window's.
        <div className="@container flex h-full min-h-0 w-full flex-col overflow-auto bg-background">
            <div
                className={[
                    "flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-subtle px-3 py-2",
                    vehicle.armed ? "bg-state-danger/10" : "bg-layer-01",
                ].join(" ")}
            >
                <span className="text-heading text-text-primary">{unknown ? "—" : vehicle.mode}</span>
                <span
                    className={[
                        "border px-1.5 py-0.5 text-micro uppercase",
                        vehicle.armed
                            ? "border-state-danger text-state-danger"
                            : "border-border-subtle text-text-helper",
                    ].join(" ")}
                >
                    {unknown ? "—" : vehicle.armed ? "Armed" : "Disarmed"}
                </span>
                {!unknown && !vehicle.prearmPass && !vehicle.armed && (
                    <span className="border border-state-warn px-1.5 py-0.5 text-micro text-state-warn uppercase">
                        Prearm fail
                    </span>
                )}
                {stale && (
                    <span className="ml-auto text-micro text-state-warn">no data for {staleFor}s</span>
                )}
            </div>

            {/* The row switches to horizontal at `@3xl`, not `@xl` — the instrument
                block (up to 312px now that the tapes flank it) and badges (256px)
                are both fixed-width and shrink-0 once in row mode, and below
                ~700px there isn't room left over for the sparklines' own
                fixed-width labels alongside them. */}
            <div className="flex flex-1 min-h-0 flex-col gap-3 p-3 @3xl:flex-row @3xl:items-stretch">
                <div className="mx-auto hidden shrink-0 flex-col items-center @sm:flex @3xl:mx-0 @3xl:h-full">
                    <div className="flex items-stretch @3xl:h-full">
                        {/* Tapes only join in row mode — a vertical side dock
                            has no spare width for them, and the numbers they'd
                            show (groundspeed, altitude) still reach the operator
                            through the Alt/GS badges either way. */}
                        <div className="hidden @3xl:block">
                            <Tape
                                value={vehicle.groundspeed}
                                tickInterval={1}
                                majorEvery={2}
                                pxPerUnit={TAPE_HEIGHT / 2 / 6}
                                decimals={1}
                                side="left"
                            />
                        </div>
                        <div className="aspect-square w-full max-w-56 @3xl:h-full @3xl:max-h-56 @3xl:w-auto">
                            <AttitudeIndicator
                                heading={heading}
                                roll={roll}
                                pitch={pitch}
                                unknown={unknown}
                                attitudeUnknown={attitudeUnknown}
                            />
                        </div>
                        <div className="hidden @3xl:block">
                            <Tape
                                value={alt}
                                tickInterval={5}
                                majorEvery={10}
                                pxPerUnit={TAPE_HEIGHT / 2 / 25}
                                decimals={1}
                                side="right"
                            />
                        </div>
                    </div>
                    {/* The only reading left as plain text — the ring deliberately
                        carries no numbers of its own, so this is heading's one
                        precise source (besides the map). */}
                    <div className="mt-1 font-mono text-micro text-text-helper tabular-nums">
                        HDG {unknown ? "—" : `${Math.round(heading)}°`}
                    </div>
                </div>

                <div className="grid grid-cols-1 content-start gap-2 @xs:grid-cols-2 @3xl:w-64 @3xl:shrink-0">
                    <BatteryGauge
                        percent={vehicle.battery.percent}
                        voltage={vehicle.battery.voltage}
                        current={vehicle.battery.current}
                        consumed={vehicle.battery.consumed}
                        tone={battTone}
                        unknown={unknown}
                    />
                    <Badge
                        label="GPS"
                        value={unknown ? "—" : `${fixLabel(vehicle.gps.fix)} · ${vehicle.gps.satellites} sats`}
                        title={unknown ? undefined : `HDOP ${vehicle.gps.hdop.toFixed(1)}`}
                        tone={gTone}
                    />
                    <Badge label="EKF" value={unknown ? "—" : vehicle.ekf.ok ? "OK" : "BAD"} tone={eTone}/>
                    <Badge
                        label="Link"
                        value={unknown ? "—" : `${vehicle.link.rssi} · ${vehicle.link.lossPercent.toFixed(1)}%`}
                        tone={lTone}
                    />
                    <Badge
                        label="Vibe"
                        value={unknown ? "—" : Math.round(vehicle.ekf.vibe).toString()}
                        tone={vTone}
                    />
                    {/* Alt and GS repeat what the tapes already show — kept here
                        too since the tapes are @3xl-only, and a narrow side dock
                        would otherwise lose these two readings entirely. */}
                    <Badge label="Alt" value={alt === null ? "—" : `${alt.toFixed(1)}m`}/>
                    <Badge
                        label="GS"
                        value={vehicle.groundspeed === null ? "—" : `${vehicle.groundspeed.toFixed(1)}m/s`}
                    />
                    <Badge
                        label="Position"
                        value={
                            vehicle.position
                                ? `${vehicle.position.lat.toFixed(5)}, ${vehicle.position.lon.toFixed(5)}`
                                : "—"
                        }
                    />
                </div>

                <div className="hidden min-w-0 flex-col justify-center gap-2 @md:flex @3xl:flex-1">
                    <SparkRow
                        label="Volt"
                        tone={battTone}
                        values={history.map((p) => p.voltage)}
                        min={13}
                        max={17.5}
                        display={unknown ? "—" : `${vehicle.battery.voltage.toFixed(1)}V`}
                    />
                    <SparkRow
                        label="HDOP"
                        tone={gTone}
                        values={history.map((p) => p.hdop)}
                        min={0}
                        max={3}
                        display={unknown ? "—" : vehicle.gps.hdop.toFixed(1)}
                    />
                    <SparkRow
                        label="Vibe"
                        tone={vTone}
                        values={history.map((p) => p.vibe)}
                        min={0}
                        max={40}
                        display={unknown ? "—" : Math.round(vehicle.ekf.vibe).toString()}
                    />
                    <SparkRow
                        label="Loss"
                        tone={lTone}
                        values={history.map((p) => p.lossPercent)}
                        min={0}
                        max={10}
                        display={unknown ? "—" : `${vehicle.link.lossPercent.toFixed(1)}%`}
                    />
                </div>
            </div>
        </div>
    );
}
