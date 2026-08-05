import {useConnection} from "@/lib/vehicle/useConnection.ts";
import {isLinkFailing, isLinkIdle} from "@/lib/vehicle/connection.ts";
import {useArmedSince, useVehicle} from "@/lib/vehicle/useVehicle.ts";
import {useNow} from "@/lib/vehicle/useMockVehicle.ts";
import {useTelemetryHistory} from "@/lib/vehicle/useTelemetryHistory.ts";
import {distanceMeters} from "@/lib/vehicle/vehicle.ts";
import {Tone, TONE_TEXT} from "@/components/topmenu/StatusChip.tsx";
import {PanelArea} from "@/panels/panelComponents.tsx";
import Sparkline from "@/components/Sparkline.tsx";

// Passive readouts only — mode/arm state, battery, position, link/vibe
// trends. The PFD (attitude ball + speed/alt tapes) split off into its own
// "Manual" panel since it matters most when actively flying, not when
// glancing over telemetry.

function formatDuration(totalSeconds: number): string {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const hh = Math.floor(seconds / 3600);
    const mm = (Math.floor(seconds / 60) % 60).toString().padStart(2, "0");
    const ss = (seconds % 60).toString().padStart(2, "0");
    return hh > 0 ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}

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

/** Extracted from what was an inline `lossPercent > 5` check so per-point
 * sparkline coloring (see `Sparkline`'s `tones`) can reuse the exact same
 * rule the current-reading badges use, rather than a second copy of it. */
function lossTone(lossPercent: number): Tone {
    return lossPercent > 5 ? "warn" : "ok";
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
        <div className="flex flex-col gap-1 border border-border-subtle bg-layer-01 px-2 py-1.5">
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

interface ModeArmedBadgeProps {
    mode: string;
    armed: boolean;
    /** Seconds since the armed edge, `null` while disarmed. This is
     * time-since-armed, not time-airborne — see `useArmedSince`. */
    armedFor: number | null;
    prearmPass: boolean;
    unknown: boolean;
    stale: boolean;
    staleFor: number | null;
}

/** Lives at the top of the readout column rather than across the whole panel
 * — mode and arm state are just two short pieces of text, and a full-width
 * strip above the instrument was mostly empty space either way. */
function ModeArmedBadge({mode, armed, armedFor, prearmPass, unknown, stale, staleFor}: ModeArmedBadgeProps) {
    return (
        <div
            className={[
                "flex flex-wrap items-center gap-2 border px-2 py-1.5",
                armed ? "border-state-danger bg-state-danger/10" : "border-border-subtle bg-layer-01",
            ].join(" ")}
        >
            <span className="font-mono text-label text-text-primary">{unknown ? "—" : mode}</span>
            <span
                className={[
                    "border px-1.5 py-0.5 text-micro uppercase",
                    armed ? "border-state-danger text-state-danger" : "border-border-subtle text-text-helper",
                ].join(" ")}
            >
                {unknown ? "—" : armed ? "Armed" : "Disarmed"}
            </span>
            {armed && armedFor !== null && (
                <span className="font-mono text-micro text-text-helper tabular-nums">{formatDuration(armedFor)}</span>
            )}
            {!unknown && !prearmPass && !armed && (
                <span className="border border-state-warn px-1.5 py-0.5 text-micro text-state-warn uppercase">
                    Prearm fail
                </span>
            )}
            {stale && <span className="ml-auto text-micro text-state-warn">no data for {staleFor}s</span>}
        </div>
    );
}

interface SparkRowProps {
    label: string;
    /** Colors the label and the current-value readout — the line itself is
     * colored per-sample instead, via `tones` (see `Sparkline`). */
    tone: Tone;
    values: number[];
    /** Parallel to `values`. */
    tones: Tone[];
    min: number;
    max: number;
    display: string;
}

function SparkRow({label, tone, values, tones, min, max, display}: SparkRowProps) {
    return (
        <div className="flex min-h-0 flex-1 items-center gap-2">
            <span className="w-14 shrink-0 text-micro text-text-helper uppercase">{label}</span>
            <Sparkline values={values} tones={tones} min={min} max={max} className="h-full w-full min-w-0 min-h-0 flex-1"/>
            <span className={`w-14 shrink-0 text-right font-mono text-micro tabular-nums ${TONE_TEXT[tone]}`}>
                {display}
            </span>
        </div>
    );
}

/**
 * Layout is position-driven: bottom dock → badges and sparklines side by
 * side (row), side dock → stacked (column). The dock size caps in layout.ts
 * make this reliable — a side dock can't grow wide enough to need a row
 * layout, so `area` is a faithful proxy for available space.
 *
 * Row mode: badges flow column-major (top-to-bottom first, new column when
 * height runs out), sized to content width (`w-fit`) so the sparkline column
 * takes whatever's left. Column mode: badges flow row-major (left-to-right,
 * wrapping), filling the full panel width with `auto-fill` columns.
 */
export default function TelemetryPanel({area}: {area: PanelArea}) {
    const vehicle = useVehicle();
    const connection = useConnection();
    const now = useNow();
    const history = useTelemetryHistory();
    const armedSince = useArmedSince();

    const packetAge = vehicle.updatedAt === 0 ? null : now - vehicle.updatedAt;
    const stale = isLinkFailing(connection.status);
    const unknown = isLinkIdle(connection.status) || vehicle.updatedAt === 0;
    const staleFor = stale && packetAge !== null ? Math.round(packetAge / 1000) : null;
    const armedFor = armedSince === null ? null : Math.floor((now - armedSince) / 1000);

    const homeDistance =
        vehicle.position && vehicle.home ? distanceMeters(vehicle.position, vehicle.home) : null;

    const battTone = batteryTone(vehicle.battery.percent);
    const lTone: Tone = lossTone(vehicle.link.lossPercent);
    const vTone = vibeTone(vehicle.ekf.vibe);

    const row = area === "bottom";

    return (
        <div className={`flex h-full min-h-0 w-full ${row ? "flex-row" : "flex-col"} items-stretch gap-3 overflow-auto bg-background p-3`}>
            <div className={row
                // Column-major: fills rows top-to-bottom, wraps to a new column
                // once height runs out. `w-fit` lets the grid size to its own
                // content so the sparkline column takes whatever space remains;
                // `shrink` lets flexbox compress it when space is tight before
                // the sparkline's own `min-w-48` floor kicks in.
                ? "grid w-fit shrink overflow-x-auto grid-flow-col auto-cols-[minmax(9rem,auto)] grid-rows-[repeat(auto-fill,minmax(3.5rem,1fr))] gap-2"
                // Row-major: fills columns left-to-right, wrapping when the
                // panel width runs out. `shrink-0` so it doesn't collapse;
                // `content-start` so rows pack to the top rather than
                // stretching to fill the panel height.
                : "grid shrink-0 content-start grid-flow-row grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-2"
            }>
                <ModeArmedBadge
                    mode={vehicle.mode}
                    armed={vehicle.armed}
                    armedFor={armedFor}
                    prearmPass={vehicle.prearmPass}
                    unknown={unknown}
                    stale={stale}
                    staleFor={staleFor}
                />
                <BatteryGauge
                    percent={vehicle.battery.percent}
                    voltage={vehicle.battery.voltage}
                    current={vehicle.battery.current}
                    consumed={vehicle.battery.consumed}
                    tone={battTone}
                    unknown={unknown}
                />
                <Badge
                    label="Climb"
                    value={vehicle.climbRate === null ? "—" : `${vehicle.climbRate.toFixed(1)}m/s`}
                />
                {vehicle.vehicleKind === "plane" && (
                    <Badge
                        label="AS"
                        value={vehicle.airspeed === null ? "—" : `${vehicle.airspeed.toFixed(1)}m/s`}
                    />
                )}
                <Badge
                    label="Position"
                    value={
                        vehicle.position
                            ? `${vehicle.position.lat.toFixed(5)}, ${vehicle.position.lon.toFixed(5)}`
                            : "—"
                    }
                />
                <Badge label="Home" value={homeDistance === null ? "—" : `${Math.round(homeDistance)}m`}/>
            </div>

            {/* Each SparkRow is `flex-1` so the four rows share the column's
                full height rather than sitting at a fixed size with blank space
                around them. `min-w-48` in row mode is the floor the badge
                grid's `shrink` compresses against — sparkline holds its width
                first, badges give way. Not needed in column mode where this
                column already gets the full panel width. */}
            <div className={`flex min-h-0 flex-1 flex-col gap-2 ${row ? "min-w-48" : "min-w-0"}`}>
                <SparkRow
                    label="Volt"
                    tone={battTone}
                    values={history.map((p) => p.voltage)}
                    tones={history.map((p) => batteryTone(p.percent))}
                    min={13}
                    max={17.5}
                    display={unknown ? "—" : `${vehicle.battery.voltage.toFixed(1)}V`}
                />
                <SparkRow
                    label="Vibe"
                    tone={vTone}
                    values={history.map((p) => p.vibe)}
                    tones={history.map((p) => vibeTone(p.vibe))}
                    min={0}
                    max={40}
                    display={unknown ? "—" : Math.round(vehicle.ekf.vibe).toString()}
                />
                <SparkRow
                    label="Loss"
                    tone={lTone}
                    values={history.map((p) => p.lossPercent)}
                    tones={history.map((p) => lossTone(p.lossPercent))}
                    min={0}
                    max={10}
                    display={unknown ? "—" : `${vehicle.link.lossPercent.toFixed(1)}%`}
                />
                <SparkRow
                    label="Rssi"
                    tone={lTone}
                    values={history.map((p) => p.rssi)}
                    tones={history.map((p) => lossTone(p.lossPercent))}
                    min={0}
                    max={254}
                    display={unknown ? "—" : Math.round(vehicle.link.rssi).toString()}
                />
            </div>
        </div>
    );
}
