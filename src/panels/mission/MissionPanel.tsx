import {useState} from "react";
import {ArrowUp, CheckmarkFilled, Home, InProgress, RadioButton, Warning} from "@carbon/icons-react";
import {useVehicle} from "@/lib/vehicle/useVehicle.ts";
import {useConnection} from "@/lib/vehicle/useConnection.ts";
import {isLinkIdle} from "@/lib/vehicle/connection.ts";
import {sendVehicleCommand} from "@/lib/vehicle/commands.ts";
import {useUploadedMissionCount} from "@/lib/mission/useMission.ts";
import {useSettings} from "@/lib/settings/useSettings.ts";
import {formatSpeed} from "@/lib/units/speed.ts";

type MissionState = "no-mission" | "ready" | "active" | "paused" | "rtl" | "complete";

function deriveMissionState(
    mode: string,
    armed: boolean,
    currentWp: number | null,
    totalWps: number,
    unknown: boolean,
): MissionState {
    if (unknown || totalWps === 0) return "no-mission";
    // WP counter past the end — done regardless of mode or arm state.
    if (currentWp !== null && currentWp >= totalWps) return "complete";
    // Disarmed while mission was started: the vehicle landed (or aborted).
    if (!armed && currentWp !== null) return "complete";
    // Returning home — either manually triggered or because no land WP exists.
    if (mode === "RTL") return "rtl";
    if (mode === "AUTO" && currentWp !== null) return "active";
    if (mode === "LOITER" && currentWp !== null) return "paused";
    return "ready";
}

const STATE_LABEL: Record<MissionState, string> = {
    "no-mission": "No Mission",
    ready:    "Ready",
    active:   "Active",
    paused:   "Paused",
    rtl:      "RTL",
    complete: "Complete",
};

const STATE_COLOR: Record<MissionState, string> = {
    "no-mission": "text-text-helper",
    ready:    "text-text-secondary",
    active:   "text-state-ok",
    paused:   "text-state-warn",
    rtl:      "text-state-info",
    complete: "text-state-info",
};

function StateIcon({state}: {state: MissionState}) {
    const cls = STATE_COLOR[state];
    switch (state) {
        case "active":   return <InProgress     size={16} className={cls}/>;
        case "complete": return <CheckmarkFilled size={16} className={cls}/>;
        case "paused":   return <Warning         size={16} className={cls}/>;
        case "rtl":      return <Home            size={16} className={cls}/>;
        default:         return <RadioButton     size={16} className={cls}/>;
    }
}

function CtrlButton({label, onClick, disabled}: {label: string; onClick: () => void; disabled?: boolean}) {
    return (
        <button
            type="button"
            disabled={disabled}
            onClick={onClick}
            className="flex-1 border border-border-subtle py-1 text-micro text-text-secondary hover:enabled:bg-layer-hover-01 hover:enabled:text-text-primary disabled:text-text-disabled"
        >
            {label}
        </button>
    );
}

function formatDuration(totalSeconds: number): string {
    const s = Math.max(0, Math.floor(totalSeconds));
    const hh = Math.floor(s / 3600);
    const mm = (Math.floor(s / 60) % 60).toString().padStart(2, "0");
    const ss = (s % 60).toString().padStart(2, "0");
    return hh > 0 ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}

const CARDINALS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
function windCardinal(deg: number): string {
    return CARDINALS[Math.round(deg / 45) % 8];
}

const XTE_MAX_M = 30;

export default function MissionPanel() {
    const vehicle = useVehicle();
    const {speedUnit} = useSettings();
    const connection = useConnection();
    const totalWps = useUploadedMissionCount();
    const [cmdError, setCmdError] = useState<string | null>(null);

    const unknown = isLinkIdle(connection.status) || vehicle.updatedAt === 0;
    const missionState = deriveMissionState(vehicle.mode, vehicle.armed, vehicle.currentWp, totalWps, unknown);

    // extra = 2 for plane/multirotor (home + auto-takeoff prepended), 1 for others.
    const extra = (vehicle.vehicleKind === "plane" || vehicle.vehicleKind === "multirotor") ? 2 : 1;
    // 1-based index of the active user waypoint.
    const activeWpUser = vehicle.currentWp !== null ? vehicle.currentWp - (extra - 1) : 0;

    const eta =
        vehicle.nav && vehicle.groundspeed !== null && vehicle.groundspeed > 0.5
            ? vehicle.nav.wpDist / vehicle.groundspeed
            : null;

    const xte = vehicle.nav?.xtrackError ?? null;
    const xteNorm = xte !== null ? Math.max(-1, Math.min(1, xte / XTE_MAX_M)) : null;
    const xteBig = xte !== null && Math.abs(xte) >= 10;

    async function runCmd(type: "startMission" | "pauseMission" | "resumeMission" | "returnToLaunch") {
        setCmdError(null);
        try {
            await sendVehicleCommand({type});
        } catch (err) {
            setCmdError(err instanceof Error ? err.message : String(err));
        }
    }

    return (
        <div className="flex h-full flex-col overflow-auto bg-background">

            {/* Status header */}
            <div className={[
                "flex shrink-0 items-center gap-2 border-b px-2 py-1.5",
                missionState === "active" ? "border-state-ok/40 bg-state-ok/5" : "border-border-subtle",
            ].join(" ")}>
                <StateIcon state={missionState}/>
                <span className={`text-label ${STATE_COLOR[missionState]}`}>{STATE_LABEL[missionState]}</span>
                {!unknown && (
                    <span className="font-mono text-label text-text-helper">{vehicle.mode}</span>
                )}
                {vehicle.currentWp !== null && (
                    <span className="ml-auto font-mono text-label text-text-helper tabular-nums">
                        WP {vehicle.currentWp}{totalWps > 0 ? ` / ${totalWps}` : ""}
                    </span>
                )}
            </div>

            {/* Progress bar */}
            {totalWps > 0 && vehicle.currentWp !== null && (
                <div className="shrink-0 border-b border-border-subtle px-2 py-2">
                    <div className="flex items-center gap-2">
                        <div className="flex-1 overflow-hidden bg-layer-02">
                            <div
                                className="h-1.5 bg-state-ok transition-[width] duration-500 ease-productive"
                                style={{width: `${Math.min(100, (vehicle.currentWp / totalWps) * 100)}%`}}
                            />
                        </div>
                        <span className="shrink-0 font-mono text-micro text-text-helper tabular-nums">
                            {vehicle.currentWp}/{totalWps}
                        </span>
                    </div>
                </div>
            )}

            {/* DIST + ETA — the primary numbers while flying a mission */}
            <div className="grid shrink-0 grid-cols-2 border-b border-border-subtle">
                <div className="flex flex-col items-center justify-center gap-1 border-r border-border-subtle py-5">
                    <span className="font-mono text-heading font-semibold text-text-primary tabular-nums">
                        {vehicle.nav ? `${Math.round(vehicle.nav.wpDist)}` : "—"}
                    </span>
                    <span className="text-micro text-text-helper uppercase">
                        {vehicle.nav ? "m to WP" : "Dist"}
                    </span>
                </div>
                <div className="flex flex-col items-center justify-center gap-1 py-5">
                    <span className="font-mono text-heading font-semibold text-text-primary tabular-nums">
                        {eta !== null ? formatDuration(eta) : "—"}
                    </span>
                    <span className="text-micro text-text-helper uppercase">ETA</span>
                </div>
            </div>

            {/* XTE graphical bar */}
            <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle/40 px-2 py-2">
                <span className="w-7 shrink-0 text-micro text-text-helper uppercase">XTE</span>
                <div className="relative flex flex-1 items-center" style={{height: "16px"}}>
                    <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border-subtle"/>
                    <div className="absolute left-1/2 top-1/2 h-2.5 w-px -translate-x-1/2 -translate-y-1/2 bg-text-helper"/>
                    {xteNorm !== null && (
                        <div
                            className={[
                                "absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full",
                                xteBig ? "bg-state-warn" : "bg-state-ok",
                            ].join(" ")}
                            style={{left: `${50 + xteNorm * 40}%`}}
                        />
                    )}
                </div>
                <span className={[
                    "w-9 shrink-0 text-right font-mono text-label tabular-nums",
                    xteBig ? "text-state-warn" : "text-text-primary",
                ].join(" ")}>
                    {xte !== null ? `${xte.toFixed(1)}` : "—"}
                </span>
            </div>

            {/* Wind */}
            <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle/40 px-2 py-1.5">
                <span className="w-7 shrink-0 text-micro text-text-helper uppercase">Wind</span>
                {vehicle.wind ? (
                    <>
                        {/* ArrowUp rotated to show where wind is going (from° + 180°) */}
                        <div className="shrink-0 text-text-helper" style={{transform: `rotate(${vehicle.wind.dir + 180}deg)`}}>
                            <ArrowUp size={14}/>
                        </div>
                        <span className="font-mono text-label text-text-primary tabular-nums">
                            {windCardinal(vehicle.wind.dir)} {formatSpeed(vehicle.wind.speed, speedUnit)}
                        </span>
                    </>
                ) : (
                    <span className="font-mono text-label text-text-helper">—</span>
                )}
            </div>

            {/* Waypoint list — fills the remaining space with mission progress per WP */}
            {totalWps > 0 ? (
                <div className="min-h-0 flex-1 overflow-auto">
                    {Array.from({length: totalWps}, (_, i) => {
                        const wpNum = i + 1;
                        const isDone   = wpNum < activeWpUser;
                        const isActive = wpNum === activeWpUser;
                        return (
                            <div
                                key={i}
                                className={[
                                    "flex items-center gap-2 border-b border-border-subtle/30 px-2 py-1.5",
                                    isActive ? "bg-state-ok/5" : "",
                                ].join(" ")}
                            >
                                {isDone   && <CheckmarkFilled size={14} className="shrink-0 text-state-ok/50"/>}
                                {isActive && <InProgress      size={14} className="shrink-0 text-state-ok"/>}
                                {!isDone && !isActive && <RadioButton size={14} className="shrink-0 text-text-disabled"/>}
                                <span className={[
                                    "font-mono text-label tabular-nums",
                                    isDone   ? "text-text-helper line-through decoration-text-helper/40" :
                                    isActive ? "text-text-primary" :
                                               "text-text-secondary",
                                ].join(" ")}>
                                    WP {wpNum}
                                </span>
                                {isActive && vehicle.nav && (
                                    <span className="ml-auto font-mono text-micro text-text-helper tabular-nums">
                                        {Math.round(vehicle.nav.wpDist)} m
                                    </span>
                                )}
                            </div>
                        );
                    })}
                </div>
            ) : (
                <div className="flex flex-1 items-center justify-center p-4 text-center text-label text-text-helper">
                    Upload a mission to start tracking progress.
                </div>
            )}

            {/* Error */}
            {cmdError && (
                <div className="shrink-0 px-2 py-1 text-micro text-state-danger">{cmdError}</div>
            )}

            {/* Controls */}
            <div className="shrink-0 border-t border-border-subtle p-2">
                <div className="flex gap-1.5">
                    <CtrlButton label="Start"  disabled={totalWps === 0 || missionState === "active"} onClick={() => void runCmd("startMission")}/>
                    <CtrlButton label="Pause"  disabled={missionState !== "active"}                    onClick={() => void runCmd("pauseMission")}/>
                    <CtrlButton label="Resume" disabled={missionState !== "paused"}                    onClick={() => void runCmd("resumeMission")}/>
                    <CtrlButton label="RTL"    disabled={unknown}                                      onClick={() => void runCmd("returnToLaunch")}/>
                </div>
            </div>
        </div>
    );
}
