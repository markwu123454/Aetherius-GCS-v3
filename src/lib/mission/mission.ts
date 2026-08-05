export type WaypointAction = "waypoint" | "takeoff" | "loiter" | "returnToLaunch" | "land";

export interface Waypoint {
    /** Frontend-only identity for React keys and lookups — never crosses the
     * Tauri bridge, since the backend's mission item order is what encodes
     * sequence, not this id. */
    id: number;
    lat: number;
    lon: number;
    /** Meters above home/origin, same convention as telemetry's `relativeAlt`. */
    altitude: number;
    /** m/s override, null = use autopilot default. Stored in the draft but
     * DO_CHANGE_SPEED interleaving is not yet implemented in the upload path. */
    speed: number | null;
    action: WaypointAction;
}

export const DEFAULT_WAYPOINT_ALTITUDE_M = 30;
