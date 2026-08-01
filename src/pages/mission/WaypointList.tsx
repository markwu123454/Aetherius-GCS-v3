import {TrashCan} from "@carbon/icons-react";
import type {Waypoint} from "../../lib/mission/mission.ts";

interface WaypointListProps {
    waypoints: Waypoint[];
    onAltitudeChange: (id: number, altitude: number) => void;
    onRemove: (id: number) => void;
}

/** Sequence, position, and an editable altitude for each waypoint — position
 * itself is read-only here since it's edited by dragging the marker on the
 * map, not by typing coordinates. */
export default function WaypointList({waypoints, onAltitudeChange, onRemove}: WaypointListProps) {
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
                        <th className="border-b border-border-subtle px-2 py-1.5 font-normal">Lat</th>
                        <th className="border-b border-border-subtle px-2 py-1.5 font-normal">Lon</th>
                        <th className="border-b border-border-subtle px-2 py-1.5 font-normal">Alt (m)</th>
                        <th className="border-b border-border-subtle px-2 py-1.5 font-normal"/>
                    </tr>
                </thead>
                <tbody>
                    {waypoints.map((waypoint, index) => (
                        <tr key={waypoint.id} className="border-b border-border-subtle-base">
                            <td className="px-2 py-1.5 text-text-helper">{index + 1}</td>
                            <td className="px-2 py-1.5 font-mono text-text-secondary">{waypoint.lat.toFixed(6)}</td>
                            <td className="px-2 py-1.5 font-mono text-text-secondary">{waypoint.lon.toFixed(6)}</td>
                            <td className="px-2 py-1.5">
                                <input
                                    type="number"
                                    value={waypoint.altitude}
                                    onChange={(event) => onAltitudeChange(waypoint.id, Number(event.target.value))}
                                    className="h-control-sm w-20 border border-border-subtle bg-background px-1.5 font-mono text-text-primary focus-visible:outline-none"
                                />
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
