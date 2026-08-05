import {TrashCan} from "@carbon/icons-react";
import type {Waypoint, WaypointAction} from "@/lib/mission/mission.ts";

const ACTION_LABELS: Record<WaypointAction, string> = {
    waypoint: "WP",
    takeoff: "Takeoff",
    loiter: "Loiter",
    returnToLaunch: "RTL",
    land: "Land",
};

interface WaypointListProps {
    waypoints: Waypoint[];
    onAltitudeChange: (id: number, altitude: number) => void;
    onSpeedChange: (id: number, speed: number | null) => void;
    onActionChange: (id: number, action: WaypointAction) => void;
    onRemove: (id: number) => void;
}

/** Sequence, position, altitude, speed override, and action type per waypoint.
 * Position itself is read-only here — edited by dragging markers on the map. */
export default function WaypointList({
    waypoints,
    onAltitudeChange,
    onSpeedChange,
    onActionChange,
    onRemove,
}: WaypointListProps) {
    if (waypoints.length === 0) {
        return (
            <div className="flex flex-1 items-center justify-center p-4 text-center text-label text-text-helper">
                Click the map to place a waypoint.
            </div>
        );
    }

    return (
        <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full border-collapse text-label">
                <thead className="sticky top-0 bg-layer-01 text-text-helper">
                    <tr className="text-left">
                        <th className="border-b border-border-subtle px-2 py-1.5 font-normal">#</th>
                        <th className="border-b border-border-subtle px-2 py-1.5 font-normal">Alt (m)</th>
                        <th className="border-b border-border-subtle px-2 py-1.5 font-normal">Spd (m/s)</th>
                        <th className="border-b border-border-subtle px-2 py-1.5 font-normal">Action</th>
                        <th className="border-b border-border-subtle px-2 py-1.5 font-normal"/>
                    </tr>
                </thead>
                <tbody>
                    {waypoints.map((waypoint, index) => (
                        <tr key={waypoint.id} className="border-b border-border-subtle-base">
                            <td className="px-2 py-1.5 text-text-helper">{index + 1}</td>
                            <td className="px-2 py-1.5">
                                <input
                                    type="number"
                                    value={waypoint.altitude}
                                    onChange={(e) => onAltitudeChange(waypoint.id, Number(e.target.value))}
                                    className="h-control-sm w-16 border border-border-subtle bg-background px-1.5 font-mono text-text-primary focus-visible:outline-none"
                                />
                            </td>
                            <td className="px-2 py-1.5">
                                <input
                                    type="number"
                                    placeholder="—"
                                    value={waypoint.speed ?? ""}
                                    onChange={(e) => {
                                        const raw = e.target.value;
                                        onSpeedChange(waypoint.id, raw === "" ? null : Number(raw));
                                    }}
                                    className="h-control-sm w-16 border border-border-subtle bg-background px-1.5 font-mono text-text-primary placeholder-text-helper focus-visible:outline-none"
                                />
                            </td>
                            <td className="px-2 py-1.5">
                                <select
                                    value={waypoint.action}
                                    onChange={(e) => onActionChange(waypoint.id, e.target.value as WaypointAction)}
                                    className="h-control-sm border border-border-subtle bg-background px-1.5 text-label text-text-primary focus-visible:outline-none"
                                >
                                    {(Object.keys(ACTION_LABELS) as WaypointAction[]).map((a) => (
                                        <option key={a} value={a}>{ACTION_LABELS[a]}</option>
                                    ))}
                                </select>
                            </td>
                            <td className="px-2 py-1.5">
                                <button
                                    type="button"
                                    onClick={() => onRemove(waypoint.id)}
                                    aria-label={`Delete waypoint ${index + 1}`}
                                    className="text-text-helper hover:text-state-danger"
                                >
                                    <TrashCan size={16}/>
                                </button>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
