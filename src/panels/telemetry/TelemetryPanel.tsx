import {useConnection} from "@/lib/vehicle/useConnection.ts";
import {isLinkFailing, isLinkIdle} from "@/lib/vehicle/connection.ts";
import {useArmedSince, useVehicle} from "@/lib/vehicle/useVehicle.ts";
import {useNow} from "@/lib/vehicle/useMockVehicle.ts";
import {useTelemetryHistory} from "@/lib/vehicle/useTelemetryHistory.ts";
import {distanceMeters} from "@/lib/vehicle/vehicle.ts";
import {Tone, TONE_TEXT} from "@/components/topmenu/StatusChip.tsx";
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
        <div className="col-span-2 flex flex-col gap-1 border border-border-subtle bg-layer-01 px-2 py-1.5">
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
                "col-span-2 flex flex-wrap items-center gap-2 border px-2 py-1.5",
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
    const history = useTelemetryHistory();
    const armedSince = useArmedSince();

    const packetAge = vehicle.updatedAt === 0 ? null : now - vehicle.updatedAt;
    const stale = isLinkFailing(connection.status);
    // Distinct from `stale`: this is "never heard from", which reads as a set
    // of unmistakable dashes rather than a struck-through zero.
    const unknown = isLinkIdle(connection.status) || vehicle.updatedAt === 0;
    const staleFor = stale && packetAge !== null ? Math.round(packetAge / 1000) : null;
    const armedFor = armedSince === null ? null : Math.floor((now - armedSince) / 1000);

    const homeDistance =
        vehicle.position && vehicle.home ? distanceMeters(vehicle.position, vehicle.home) : null;

    const battTone = batteryTone(vehicle.battery.percent);
    const lTone: Tone = vehicle.link.lossPercent > 5 ? "warn" : "ok";
    const vTone = vibeTone(vehicle.ekf.vibe);

    return (
        <div className="flex h-full min-h-0 w-full items-stretch gap-3 overflow-x-auto bg-background p-3">
            <div className="grid w-64 shrink-0 grid-cols-2 content-start gap-2">
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

            <div className="flex min-w-0 flex-1 flex-col justify-center gap-2">
                <SparkRow
                    label="Volt"
                    tone={battTone}
                    values={history.map((p) => p.voltage)}
                    min={13}
                    max={17.5}
                    display={unknown ? "—" : `${vehicle.battery.voltage.toFixed(1)}V`}
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
    );
}