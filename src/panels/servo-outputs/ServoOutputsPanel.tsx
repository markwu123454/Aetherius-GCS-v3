import {useMemo} from "react";
import {useConnection} from "@/lib/vehicle/useConnection.ts";
import {useVehicle} from "@/lib/vehicle/useVehicle.ts";
import {useLiveParams} from "@/lib/params/useLiveParams.ts";
import {useServoOutputs} from "@/lib/vehicle/useServoOutputs.ts";
import {useParamSheet} from "@/lib/params/useParamSheet.ts";
import {ParamDef, VehicleFirmware} from "@/lib/params/paramSheet.ts";
import {PanelArea} from "@/panels/panelComponents.tsx";

const CHANNEL_COUNT = 32;

function findParam(groups: {params: ParamDef[]}[], name: string): ParamDef | null {
    for (const group of groups) {
        const found = group.params.find((p) => p.name === name);
        if (found) return found;
    }
    return null;
}

interface ChannelData {
    channel: number;
    label: string;
    hasScale: boolean;
    min: number;
    trim: number;
    max: number;
}

function pct(value: number, min: number, max: number): number {
    return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
}

// ── Vertical bar (bottom dock) ─────────────────────────────────────────────

interface VerticalBarProps {
    hasScale: boolean;
    currentPct: number;
    trimPct: number;
}

function VerticalBar({hasScale, currentPct, trimPct}: VerticalBarProps) {
    return (
        <div className="relative mx-2 flex-1 bg-layer-02">
            {hasScale && (
                <>
                    <div
                        className="absolute inset-x-0 bottom-0 bg-state-info transition-[height] duration-75"
                        style={{height: `${currentPct}%`}}
                    />
                    <div
                        className="absolute inset-x-0 bg-text-helper"
                        style={{bottom: `${trimPct}%`, height: "1px"}}
                    />
                </>
            )}
        </div>
    );
}

// ── Horizontal bar (side dock) ─────────────────────────────────────────────

interface HorizontalBarProps {
    hasScale: boolean;
    currentPct: number;
    trimPct: number;
}

function HorizontalBar({hasScale, currentPct, trimPct}: HorizontalBarProps) {
    return (
        <div className="relative h-4 flex-1 bg-layer-02">
            {hasScale && (
                <>
                    <div
                        className="absolute inset-y-0 left-0 bg-state-info transition-[width] duration-75"
                        style={{width: `${currentPct}%`}}
                    />
                    <div
                        className="absolute inset-y-0 bg-text-helper"
                        style={{left: `${trimPct}%`, width: "1px"}}
                    />
                </>
            )}
        </div>
    );
}

// ── Bottom dock: vertical channel strips ───────────────────────────────────

function BottomStrip({ch, pwm}: {ch: ChannelData; pwm: number | undefined}) {
    const trimPct = ch.hasScale ? pct(ch.trim, ch.min, ch.max) : 0;
    const currentPct = ch.hasScale && pwm !== undefined ? pct(pwm, ch.min, ch.max) : 0;

    return (
        <div className="flex w-14 shrink-0 flex-col border-r border-border-subtle-base py-1">
            <span className="truncate px-1 text-center text-micro text-text-secondary" title={ch.label}>
                {ch.label}
            </span>
            <VerticalBar hasScale={ch.hasScale} currentPct={currentPct} trimPct={trimPct} />
            <span className="px-1 pt-1 text-center font-mono text-micro text-text-primary">
                {pwm !== undefined ? pwm : "—"}
            </span>
            <span className="px-1 text-center text-micro text-text-helper">{ch.channel}</span>
        </div>
    );
}

function BottomLayout({channels, outputs}: {channels: ChannelData[]; outputs: Map<number, number>}) {
    if (channels.length === 0) {
        return (
            <div className="flex h-full items-center justify-center text-label text-text-helper">
                No enabled servo outputs.
            </div>
        );
    }
    return (
        <div className="flex h-full flex-row overflow-x-auto">
            {channels.map((ch) => (
                <BottomStrip key={ch.channel} ch={ch} pwm={outputs.get(ch.channel)} />
            ))}
        </div>
    );
}

// ── Side dock: horizontal rows ─────────────────────────────────────────────

function SideRow({ch, pwm}: {ch: ChannelData; pwm: number | undefined}) {
    const trimPct = ch.hasScale ? pct(ch.trim, ch.min, ch.max) : 0;
    const currentPct = ch.hasScale && pwm !== undefined ? pct(pwm, ch.min, ch.max) : 0;

    return (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border-subtle-base px-2">
            <span className="w-5 shrink-0 text-right font-mono text-micro text-text-helper">
                {ch.channel}
            </span>
            <span className="w-16 shrink-0 truncate text-micro text-text-secondary" title={ch.label}>
                {ch.label}
            </span>
            <HorizontalBar hasScale={ch.hasScale} currentPct={currentPct} trimPct={trimPct} />
            <span className="w-14 shrink-0 text-right font-mono text-micro text-text-primary">
                {pwm !== undefined ? `${pwm}µs` : "—"}
            </span>
        </div>
    );
}

function SideLayout({channels, outputs}: {channels: ChannelData[]; outputs: Map<number, number>}) {
    if (channels.length === 0) {
        return (
            <div className="flex h-full items-center justify-center text-label text-text-helper">
                No enabled servo outputs.
            </div>
        );
    }
    return (
        <div className="flex h-full flex-col overflow-y-auto">
            {channels.map((ch) => (
                <SideRow key={ch.channel} ch={ch} pwm={outputs.get(ch.channel)} />
            ))}
        </div>
    );
}

// ── Panel ──────────────────────────────────────────────────────────────────

export default function ServoOutputsPanel({area}: {area: PanelArea}) {
    const connection = useConnection();
    const vehicle = useVehicle();
    const live = useLiveParams();
    const outputs = useServoOutputs();

    const firmware: VehicleFirmware = vehicle.vehicleKind === "plane" ? "ArduPlane" : "ArduCopter";
    const sheetState = useParamSheet(firmware);

    const functionLabels = useMemo(() => {
        if (sheetState.status !== "ready") return new Map<number, string>();
        const param = findParam(sheetState.sheet.groups, "SERVO1_FUNCTION");
        return new Map(param?.values?.map((v) => [v.value, v.label]) ?? []);
    }, [sheetState]);

    const channels = useMemo<ChannelData[]>(() => {
        const result: ChannelData[] = [];
        for (let ch = 1; ch <= CHANNEL_COUNT; ch++) {
            const fnEntry = live.values.get(`SERVO${ch}_FUNCTION`);
            if (!fnEntry) continue;
            const fnValue = Math.round(fnEntry.value);
            if (fnValue === 0) continue;

            const min = live.values.get(`SERVO${ch}_MIN`)?.value;
            const trim = live.values.get(`SERVO${ch}_TRIM`)?.value;
            const max = live.values.get(`SERVO${ch}_MAX`)?.value;
            const hasScale =
                min !== undefined &&
                trim !== undefined &&
                max !== undefined &&
                max > min;

            result.push({
                channel: ch,
                label: functionLabels.get(fnValue) ?? String(fnValue),
                hasScale,
                min: min ?? 1000,
                trim: trim ?? 1500,
                max: max ?? 2000,
            });
        }
        return result;
    }, [live.values, functionLabels]);

    if (connection.status !== "connected") {
        return (
            <div className="flex h-full items-center justify-center text-label text-text-helper">
                Connect a vehicle to see servo outputs.
            </div>
        );
    }

    return area === "bottom" ? (
        <BottomLayout channels={channels} outputs={outputs} />
    ) : (
        <SideLayout channels={channels} outputs={outputs} />
    );
}
