import {invoke} from "@tauri-apps/api/core";
import {requireBackend} from "@/lib/vehicle/connection.ts";
import {Waypoint} from "./mission.ts";

/**
 * Uploads the whole waypoint list in one call — the backend owns the
 * MISSION_COUNT / MISSION_REQUEST_INT / MISSION_ITEM_INT handshake with the
 * vehicle from here, including the ArduPilot home-item quirk. Rejects with a
 * human-readable message sourced from the backend, same shape as
 * `sendVehicleCommand`.
 */
export function uploadMission(waypoints: Waypoint[]): Promise<void> {
    requireBackend();
    return invoke<void>("upload_mission", {waypoints});
}

export interface DownloadedMission {
    waypoints: Omit<Waypoint, "id">[];
    /** Mission items the vehicle reported that don't map onto the editor's
     * five actions (e.g. DO_* items) — dropped rather than guessed at. */
    skipped: number;
}

/**
 * Pulls the mission currently stored on the vehicle — the backend owns the
 * MISSION_REQUEST_LIST / MISSION_COUNT / MISSION_REQUEST_INT handshake, drops
 * ArduPilot's home item (seq 0) the same way `upload_mission` synthesizes it,
 * and reports how many items it couldn't translate back into a waypoint.
 */
export function downloadMission(): Promise<DownloadedMission> {
    requireBackend();
    return invoke<DownloadedMission>("download_mission");
}
