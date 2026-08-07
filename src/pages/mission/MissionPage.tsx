import {useState} from "react";
import {DocumentDownload, DocumentExport, DocumentImport} from "@carbon/icons-react";
import {save as saveDialog, open as openDialog} from "@tauri-apps/plugin-dialog";
import {writeTextFile, readTextFile} from "@tauri-apps/plugin-fs";
import MissionMap from "./MissionMap.tsx";
import WaypointList from "./WaypointList.tsx";
import type {MissionApi} from "@/lib/mission/useMission.ts";
import type {Waypoint} from "@/lib/mission/mission.ts";
import {distanceMeters} from "@/lib/vehicle/vehicle.ts";

const MISSION_FILE_FILTERS = [{name: "Mission file", extensions: ["json"]}];

interface MissionFile {
    version: 1;
    waypoints: Omit<Waypoint, "id">[];
}

/** Native save dialog, not a browser download link — this is a desktop app,
 * and a silent drop into the downloads folder (what the `<a download>` trick
 * used to do here) gives the operator no say over where the file lands.
 * Mirrors `ParametersPage`'s `handleSave`. */
async function exportMission(waypoints: Waypoint[]): Promise<string | null> {
    const path = await saveDialog({
        defaultPath: "mission.json",
        filters: MISSION_FILE_FILTERS,
    });
    if (!path) return null; // user cancelled
    const payload: MissionFile = {
        version: 1,
        waypoints: waypoints.map(({id: _id, ...rest}) => rest),
    };
    await writeTextFile(path, JSON.stringify(payload, null, 2));
    return path;
}

/** Native open dialog, mirroring `ParametersPage`'s `handleLoad`. Returns
 * `null` on cancel and throws on a malformed file so the caller can show it
 * as an error rather than swallowing it. */
async function importMission(): Promise<Omit<Waypoint, "id">[] | null> {
    const path = await openDialog({multiple: false, filters: MISSION_FILE_FILTERS});
    if (!path || Array.isArray(path)) return null; // user cancelled
    const text = await readTextFile(path);
    const data = JSON.parse(text) as Partial<MissionFile>;
    if (data.version !== 1 || !Array.isArray(data.waypoints)) {
        throw new Error("That file isn't a recognized mission file.");
    }
    return data.waypoints;
}

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

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
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
    const [fileError, setFileError] = useState<string | null>(null);

    const totalDist = totalRouteDistance(mission.waypoints);
    const estTime = previewSpeed > 0 ? totalDist / previewSpeed : null;

    const handleExport = async () => {
        setFileError(null);
        try {
            await exportMission(mission.waypoints);
        } catch (error) {
            setFileError(message(error));
        }
    };

    const handleImport = async () => {
        setFileError(null);
        try {
            const waypoints = await importMission();
            if (waypoints) {
                mission.loadWaypoints(waypoints);
            }
        } catch (error) {
            setFileError(message(error));
        }
    };

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
                        title="Import from a mission file"
                        onClick={() => void handleImport()}
                        className="flex items-center gap-1 px-2 py-1 text-label text-text-secondary hover:bg-layer-hover-01 hover:text-text-primary"
                    >
                        <DocumentImport size={16}/>
                        Import
                    </button>
                    <button
                        type="button"
                        title="Export to a mission file"
                        disabled={mission.waypoints.length === 0}
                        onClick={() => void handleExport()}
                        className="flex items-center gap-1 px-2 py-1 text-label text-text-secondary hover:enabled:bg-layer-hover-01 hover:enabled:text-text-primary disabled:text-text-disabled"
                    >
                        <DocumentExport size={16}/>
                        Export
                    </button>
                    <button
                        type="button"
                        title="Download the mission currently stored on the vehicle"
                        disabled={mission.downloading}
                        onClick={() => void mission.download().catch(() => {})}
                        className="flex items-center gap-1 px-2 py-1 text-label text-text-secondary hover:enabled:bg-layer-hover-01 hover:enabled:text-text-primary disabled:text-text-disabled"
                    >
                        <DocumentDownload size={16}/>
                        {mission.downloading ? "Downloading…" : "From Vehicle"}
                    </button>
                </div>
                {(fileError || mission.downloadError || mission.downloadWarning) && (
                    <div className="shrink-0 border-b border-border-subtle bg-layer-02 px-3 py-1.5 text-label">
                        {fileError && <div className="text-state-danger">{fileError}</div>}
                        {mission.downloadError && <div className="text-state-danger">{mission.downloadError}</div>}
                        {mission.downloadWarning && <div className="text-state-warn">{mission.downloadWarning}</div>}
                    </div>
                )}

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
