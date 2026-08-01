import {invoke} from "@tauri-apps/api/core";
import {requireBackend} from "../vehicle/connection";
import {Waypoint} from "./mission";

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
