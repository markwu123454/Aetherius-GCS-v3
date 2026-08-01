import MissionMap from "./MissionMap";
import WaypointList from "./WaypointList";
import type {MissionApi} from "../mission/useMission";

interface MissionPageProps {
    mission: MissionApi;
}

/**
 * The mission editor: its own full-screen map (not the docked `MapView`) so
 * building a draft never interferes with monitoring the live vehicle, plus a
 * sidebar for the waypoint list and the upload/start/clear controls. `mission`
 * is owned by `App.tsx`, not this page — see the wiring note there for why
 * (the TopBar menu's "Upload to Vehicle" needs to reach it too).
 */
export default function MissionPage({mission}: MissionPageProps) {
    return (
        <div className="flex h-full w-full">
            <div className="min-w-0 flex-1">
                <MissionMap mission={mission}/>
            </div>
            <div className="flex w-80 shrink-0 flex-col border-l border-border-subtle bg-layer-01">
                <WaypointList
                    waypoints={mission.waypoints}
                    onAltitudeChange={mission.setAltitude}
                    onRemove={mission.removeWaypoint}
                />
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
