import {useState} from "react";
import {DocumentDownload, DocumentExport, DocumentImport} from "@carbon/icons-react";
import MissionMap from "./MissionMap.tsx";
import WaypointList from "./WaypointList.tsx";
import type {MissionApi} from "@/lib/mission/useMission.ts";
import type {Waypoint} from "@/lib/mission/mission.ts";
import {distanceMeters} from "@/lib/vehicle/vehicle.ts";

interface MissionPageProps {
    mission: MissionApi;
}

function totalRouteDistance(waypoints: Waypoint[]): number {
    let dist = 0;
    for (let i = 1; i < waypoints.length; i++) {
        dist += distanceMeters(waypoints[i - 1]!, waypoints[i]!);
    }
    return dist;
}

function formatDuration(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return m > 0 ? `${m} min ${s}s` : `${s}s`;
}

function saveMission(waypoints: Waypoint[]): void {
    const payload = {
        version: 1,
        waypoints: waypoints.map(({id: _id, ...rest}) => rest),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {type: "application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "mission.json";
    a.click();
    URL.revokeObjectURL(url);
}

function loadMission(onLoad: (saved: Omit<Waypoint, "id">[]) => void): void {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = () => {
        const file = input.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = JSON.parse(e.target?.result as string) as {version: number; waypoints: Omit<Waypoint, "id">[]};
                if (data.version === 1 && Array.isArray(data.waypoints)) {
                    onLoad(data.waypoints);
                }
            } catch {
                // Silently ignore malformed files
            }
        };
        reader.readAsText(file);
    };
    input.click();
}

/**
 * The mission editor: its own full-screen map (not the docked `MapView`) so
 * building a draft never interferes with monitoring the live vehicle, plus a
 * sidebar for the waypoint list and the upload/start/clear controls. `mission`
 * is owned by `App.tsx`, not this page — see the wiring note there for why
 * (the TopBar menu's "Upload to Vehicle" needs to reach it too).
 */
export default function MissionPage({mission}: MissionPageProps) {
    const [previewSpeed, setPreviewSpeed] = useState(10);

    const totalDist = totalRouteDistance(mission.waypoints);
    const estTime = previewSpeed > 0 ? totalDist / previewSpeed : null;

    return (
        <div className="flex h-full w-full">
            <div className="min-w-0 flex-1">
                <MissionMap mission={mission}/>
            </div>
            <div className="flex w-80 shrink-0 flex-col border-l border-border-subtle bg-layer-01">
                {/* Toolbar */}
                <div className="flex shrink-0 items-center gap-1 border-b border-border-subtle px-2 py-1.5">
                    <button
                        type="button"
                        title="Load from file"
                        onClick={() => loadMission(mission.loadWaypoints)}
                        className="flex items-center gap-1 px-2 py-1 text-label text-text-secondary hover:bg-layer-hover-01 hover:text-text-primary"
                    >
                        <DocumentImport size={16}/>
                        Load
                    </button>
                    <button
                        type="button"
                        title="Save to file"
                        disabled={mission.waypoints.length === 0}
                        onClick={() => saveMission(mission.waypoints)}
                        className="flex items-center gap-1 px-2 py-1 text-label text-text-secondary hover:enabled:bg-layer-hover-01 hover:enabled:text-text-primary disabled:text-text-disabled"
                    >
                        <DocumentExport size={16}/>
                        Save
                    </button>
                    <button
                        type="button"
                        title="Download from vehicle — not yet implemented"
                        disabled
                        className="flex items-center gap-1 px-2 py-1 text-label text-text-disabled"
                    >
                        <DocumentDownload size={16}/>
                        From Vehicle
                    </button>
                </div>

                {/* Waypoint list */}
                <WaypointList
                    waypoints={mission.waypoints}
                    onAltitudeChange={mission.setAltitude}
                    onSpeedChange={mission.setSpeed}
                    onActionChange={mission.setAction}
                    onRemove={mission.removeWaypoint}
                />

                {/* Stats */}
                <div className="flex shrink-0 items-center gap-3 border-t border-border-subtle px-3 py-2 text-micro text-text-helper">
                    <span>{mission.waypoints.length} WP{mission.waypoints.length !== 1 ? "s" : ""}</span>
                    {mission.waypoints.length >= 2 && (
                        <>
                            <span>{(totalDist / 1000).toFixed(2)} km</span>
                            <span className="flex items-center gap-1">
                                @
                                <input
                                    type="number"
                                    value={previewSpeed}
                                    min={1}
                                    onChange={(e) => setPreviewSpeed(Number(e.target.value))}
                                    className="w-10 bg-transparent text-center font-mono text-text-helper focus-visible:outline-none"
                                />
                                m/s
                            </span>
                            {estTime !== null && <span>~{formatDuration(estTime)}</span>}
                        </>
                    )}
                </div>

                {/* Action buttons */}
                <div className="flex shrink-0 flex-col gap-2 border-t border-border-subtle p-3">
                    {mission.uploadError && (
                        <span className="text-label text-state-danger">{mission.uploadError}</span>
                    )}
                    {mission.startError && (
                        <span className="text-label text-state-danger">{mission.startError}</span>
                    )}
                    <button
                        type="button"
                        disabled={mission.waypoints.length === 0 || mission.uploading}
                        onClick={() => void mission.upload().catch(() => {})}
                        className="h-control-sm w-full border border-border-subtle text-label text-text-primary hover:enabled:bg-layer-hover-01 disabled:text-text-disabled"
                    >
                        {mission.uploading ? "Uploading…" : "Upload to Vehicle"}
                    </button>
                    <button
                        type="button"
                        disabled={mission.starting}
                        onClick={() => void mission.start().catch(() => {})}
                        className="h-control-sm w-full border border-border-subtle text-label text-text-primary hover:enabled:bg-layer-hover-01 disabled:text-text-disabled"
                    >
                        {mission.starting ? "Starting…" : "Start Mission"}
                    </button>
                    <button
                        type="button"
                        disabled={mission.waypoints.length === 0}
                        onClick={mission.clear}
                        className="h-control-sm w-full border border-border-subtle text-label text-text-secondary hover:enabled:bg-layer-hover-01 disabled:text-text-disabled"
                    >
                        Clear
                    </button>
                </div>
            </div>
        </div>
    );
}
