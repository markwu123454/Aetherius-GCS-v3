/**
 * Telemetry panel — passive readouts: mode/arm state, battery, position,
 * link and vibration trends.
 *
 * Layout: a Mode/Arm header row (always full-width) above a uniform stat-row
 * list. Side dock → single column. Bottom dock → three columns via CSS
 * `columns-3`. Same rows, same order, just reflowed — no separate badge
 * section vs sparkline section, no wrapping logic.
 */

import {useConnection} from "@/lib/vehicle/useConnection.ts";
import {isLinkFailing, isLinkIdle} from "@/lib/vehicle/connection.ts";
import {useArmedSince, useVehicle} from "@/lib/vehicle/useVehicle.ts";
import {useNow} from "@/lib/vehicle/useMockVehicle.ts";
import {useTelemetryHistory, useTelemetrySparklines} from "@/lib/vehicle/useTelemetryHistory.ts";
import {distanceMeters} from "@/lib/vehicle/vehicle.ts";
import {useSettings} from "@/lib/settings/useSettings.ts";
import {formatSpeed} from "@/lib/units/speed.ts";
import {formatVerticalSpeed} from "@/lib/units/verticalSpeed.ts";
import {formatAltitude} from "@/lib/units/altitude.ts";
import {formatDistance} from "@/lib/units/distance.ts";
import {Tone, TONE_TEXT} from "@/components/topmenu/StatusChip.tsx";
import {PanelArea} from "@/panels/panelComponents.tsx";
import Sparkline from "@/components/Sparkline.tsx";

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
    if (percent <= 20) return "danger";
    if (percent <= 30) return "warn";
    return "ok";
}

function vibeTone(vibe: number): Tone {
    if (vibe >= 20) return "danger";
    if (vibe >= 10) return "warn";
    return "ok";
}

function lossTone(lossPercent: number): Tone {
    return lossPercent > 2 ? "warn" : "ok";
}

function xteTone(meters: number): Tone {
    if (Math.abs(meters) >= 25) return "danger";
    if (Math.abs(meters) >= 10) return "warn";
    return "ok";
}

function boardVoltageTone(volts: number): Tone {
    if (volts < 4.5) return "danger";
    if (volts < 4.8) return "warn";
    return "ok";
}

function ModeArmedRow({mode, armed, armedFor, prearmPass, unknown, stale, staleFor}: {
    mode: string;
    armed: boolean;
    armedFor: number | null;
    prearmPass: boolean;
    unknown: boolean;
    stale: boolean;
    staleFor: number | null;
}) {
    return (
        <div className={[
            "flex shrink-0 flex-wrap items-center gap-2 border-b px-2 py-1.5",
            armed ? "border-state-danger bg-state-danger/10" : "border-border-subtle",
        ].join(" ")}>
            <span className="font-mono text-label text-text-primary">{unknown ? "—" : mode}</span>
            <span className={[
                "border px-1.5 py-0.5 text-micro uppercase",
                armed ? "border-state-danger text-state-danger" : "border-border-subtle text-text-helper",
            ].join(" ")}>
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

function BatteryRow({percent, voltage, current, consumed, tone, unknown}: {
    percent: number;
    voltage: number;
    current: number;
    consumed: number;
    tone: Tone;
    unknown: boolean;
}) {
    const clamped = Math.max(0, Math.min(100, percent));
    return (
        <div className="break-inside-avoid flex items-center gap-2 border-b border-border-subtle/40 px-2 py-1.5">
            <span className="w-12 shrink-0 text-micro text-text-helper uppercase">Batt</span>
            <span className={`w-8 shrink-0 font-mono text-label tabular-nums ${TONE_TEXT[tone]}`}>
                {unknown ? "—" : `${Math.round(clamped)}%`}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="h-1.5 w-full bg-layer-02">
                    <div
                        className={`h-full ${BAR_TONE[tone]} transition-[width] duration-300 ease-productive`}
                        style={{width: `${unknown ? 0 : clamped}%`}}
                    />
                </div>
                <div className="flex gap-2 font-mono text-micro text-text-helper tabular-nums">
                    <span>{unknown ? "—" : `${voltage.toFixed(1)}V`}</span>
                    <span>{unknown ? "—" : `${current.toFixed(1)}A`}</span>
                    <span>{unknown ? "—" : `${Math.round(consumed)}mAh`}</span>
                </div>
            </div>
        </div>
    );
}

function StatRow({label, value, tone = "neutral", values, tones, autoScale, minRange}: {
    label: string;
    value: string;
    tone?: Tone;
    values?: number[];
    tones?: Tone[];
    autoScale?: boolean;
    minRange?: number;
}) {
    const hasSparkline = values && values.length >= 2;
    return (
        <div className="break-inside-avoid flex min-w-0 items-center gap-2 overflow-hidden border-b border-border-subtle/40 px-2 py-1.5">
            <span className="w-12 shrink-0 text-micro text-text-helper uppercase">{label}</span>
            <span className={`shrink-0 font-mono text-label tabular-nums ${TONE_TEXT[tone]}`}>{value}</span>
            {hasSparkline && autoScale && (
                <Sparkline
                    autoScale
                    minRange={minRange}
                    values={values!}
                    tones={tones!}
                    className="h-4 min-w-0 flex-1"
                />
            )}
        </div>
    );
}

export default function TelemetryPanel({area}: {area: PanelArea}) {
    const vehicle = useVehicle();
    const connection = useConnection();
    const now = useNow();
    const history = useTelemetryHistory();
    const sparklines = useTelemetrySparklines();
    const armedSince = useArmedSince();
    const {speedUnit, verticalSpeedUnit, altitudeUnit, distanceUnit} = useSettings();

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

    const horizontal = area === "bottom";

    return (
        <div className="flex h-full flex-col overflow-auto bg-background">
            <ModeArmedRow
                mode={vehicle.mode}
                armed={vehicle.armed}
                armedFor={armedFor}
                prearmPass={vehicle.prearmPass}
                unknown={unknown}
                stale={stale}
                staleFor={staleFor}
            />
            <div className={horizontal ? "columns-3" : "columns-1"}>
                <BatteryRow
                    percent={vehicle.battery.percent}
                    voltage={vehicle.battery.voltage}
                    current={vehicle.battery.current}
                    consumed={vehicle.battery.consumed}
                    tone={battTone}
                    unknown={unknown}
                />
                <StatRow
                    label="Volt"
                    value={unknown ? "—" : `${vehicle.battery.voltage.toFixed(1)}V`}
                    tone={battTone}
                    values={history.map((p) => p.voltage)}
                    tones={history.map((p) => batteryTone(p.percent))}
                    autoScale={sparklines}
                    minRange={0.5}
                />
                <StatRow
                    label="Alt"
                    value={formatAltitude(vehicle.position?.alt ?? null, altitudeUnit)}
                />
                <StatRow
                    label="GS"
                    value={formatSpeed(vehicle.groundspeed, speedUnit)}
                />
                <StatRow
                    label="Climb"
                    value={formatVerticalSpeed(vehicle.climbRate, verticalSpeedUnit)}
                />
                {vehicle.vehicleKind === "plane" && (
                    <StatRow
                        label="AS"
                        value={formatSpeed(vehicle.airspeed, speedUnit)}
                    />
                )}
                <StatRow
                    label="Home"
                    value={formatDistance(homeDistance, distanceUnit)}
                />
                <StatRow
                    label="Hdg"
                    value={vehicle.position ? `${Math.round(vehicle.position.heading)}°` : "—"}
                />
                <StatRow
                    label="Vibe"
                    value={unknown ? "—" : Math.round(vehicle.ekf.vibe).toString()}
                    tone={vTone}
                    values={history.map((p) => p.vibe)}
                    tones={history.map((p) => vibeTone(p.vibe))}
                    autoScale={sparklines}
                    minRange={5}
                />
                <StatRow
                    label="Loss"
                    value={unknown ? "—" : `${vehicle.link.lossPercent.toFixed(1)}%`}
                    tone={lTone}
                    values={history.map((p) => p.lossPercent)}
                    tones={history.map((p) => lossTone(p.lossPercent))}
                    autoScale={sparklines}
                    minRange={1}
                />
                <StatRow
                    label="RSSI"
                    value={unknown ? "—" : Math.round(vehicle.link.rssi).toString()}
                    tone={lTone}
                    values={history.map((p) => p.rssi)}
                    tones={history.map((p) => lossTone(p.lossPercent))}
                    autoScale={sparklines}
                    minRange={20}
                />
                <StatRow
                    label="Wind"
                    value={vehicle.wind
                        ? `${Math.round(vehicle.wind.dir)}° · ${formatSpeed(vehicle.wind.speed, speedUnit)}`
                        : "—"}
                />
                <StatRow
                    label="WP"
                    value={formatDistance(vehicle.nav?.wpDist ?? null, distanceUnit)}
                />
                <StatRow
                    label="XTE"
                    value={formatDistance(vehicle.nav?.xtrackError ?? null, distanceUnit)}
                    tone={vehicle.nav ? xteTone(vehicle.nav.xtrackError) : "neutral"}
                />
                <StatRow
                    label="Pwr"
                    value={vehicle.power
                        ? `${vehicle.power.boardVoltage.toFixed(2)}V · ${vehicle.power.servoVoltage.toFixed(2)}Vs`
                        : "—"}
                    tone={vehicle.power ? boardVoltageTone(vehicle.power.boardVoltage) : "neutral"}
                />
            </div>
        </div>
    );
}
