import {useCallback, useState} from "react";
import {listen} from "@tauri-apps/api/event";
import {DEFAULT_WAYPOINT_ALTITUDE_M, Waypoint, WaypointAction} from "./mission.ts";
import {uploadMission} from "./missionCommands.ts";
import {sendVehicleCommand} from "@/lib/vehicle/commands.ts";
import {createStore} from "@/lib/store.ts";
import {useSyncExternalStore} from "react";
import type {ConnectionStatus} from "@/lib/vehicle/connection.ts";

export interface MissionApi {
    waypoints: Waypoint[];
    addWaypoint: (lat: number, lon: number) => void;
    removeWaypoint: (id: number) => void;
    moveWaypoint: (id: number, lat: number, lon: number) => void;
    setAltitude: (id: number, altitude: number) => void;
    setSpeed: (id: number, speed: number | null) => void;
    setAction: (id: number, action: WaypointAction) => void;
    loadWaypoints: (saved: Omit<Waypoint, "id">[]) => void;
    clear: () => void;
    upload: () => Promise<void>;
    uploading: boolean;
    uploadError: string | null;
    start: () => Promise<void>;
    starting: boolean;
    startError: string | null;
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

// Module-level rather than per-hook: `useMission` is only ever called once
// (in `App.tsx`), but a plain counter is simpler than pulling in a uuid
// dependency for ids that only need to be unique within one session.
let nextId = 1;

/** Updated on successful upload so the MissionPanel can show WP progress
 * without prop-threading the draft through the panel registration chain. */
const uploadedCountStore = createStore<number>(0);

export function useUploadedMissionCount(): number {
    return useSyncExternalStore(uploadedCountStore.subscribe, uploadedCountStore.getSnapshot);
}

/** The actual uploaded waypoints — set alongside uploadedCountStore on a
 * successful upload so MapView can render the route without prop-threading. */
const uploadedWaypointsStore = createStore<Waypoint[]>([]);

export function useUploadedWaypoints(): Waypoint[] {
    return useSyncExternalStore(uploadedWaypointsStore.subscribe, uploadedWaypointsStore.getSnapshot);
}

// Uploaded mission state belongs to the connection — reset it when the link
// drops so a reconnect to a different vehicle doesn't show stale WP data.
listen<ConnectionStatus>("link-status", (event) => {
    const status = event.payload;
    if (status !== "connected" && status !== "connecting" && status !== "losing") {
        uploadedCountStore.set(0);
        uploadedWaypointsStore.set([]);
    }
}).catch(() => {});

/**
 * The mission draft itself: no backend persistence, no Load/Save — closing
 * the page (or an accidental back-button press) discards it, which is
 * expected for v1, not an oversight. Called once in `App.tsx` and handed to
 * both `MissionPage` (the editor) and `TopBar` (the "Upload to Vehicle" menu
 * item), since the two are siblings and page-local state would be
 * unreachable from the menu.
 */
export function useMission(): MissionApi {
    const [waypoints, setWaypoints] = useState<Waypoint[]>([]);
    const [uploading, setUploading] = useState(false);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const [starting, setStarting] = useState(false);
    const [startError, setStartError] = useState<string | null>(null);

    const addWaypoint = useCallback((lat: number, lon: number) => {
        setWaypoints((prev) => [
            ...prev,
            {id: nextId++, lat, lon, altitude: DEFAULT_WAYPOINT_ALTITUDE_M, speed: null, action: "waypoint"},
        ]);
    }, []);

    const removeWaypoint = useCallback((id: number) => {
        setWaypoints((prev) => prev.filter((waypoint) => waypoint.id !== id));
    }, []);

    const moveWaypoint = useCallback((id: number, lat: number, lon: number) => {
        setWaypoints((prev) => prev.map((waypoint) => (waypoint.id === id ? {...waypoint, lat, lon} : waypoint)));
    }, []);

    const setAltitude = useCallback((id: number, altitude: number) => {
        setWaypoints((prev) => prev.map((waypoint) => (waypoint.id === id ? {...waypoint, altitude} : waypoint)));
    }, []);

    const setSpeed = useCallback((id: number, speed: number | null) => {
        setWaypoints((prev) => prev.map((waypoint) => (waypoint.id === id ? {...waypoint, speed} : waypoint)));
    }, []);

    const setAction = useCallback((id: number, action: WaypointAction) => {
        setWaypoints((prev) => prev.map((waypoint) => (waypoint.id === id ? {...waypoint, action} : waypoint)));
    }, []);

    const loadWaypoints = useCallback((saved: Omit<Waypoint, "id">[]) => {
        setWaypoints(saved.map((wp) => ({...wp, id: nextId++})));
    }, []);

    const clear = useCallback(() => setWaypoints([]), []);

    const upload = useCallback(async () => {
        setUploading(true);
        setUploadError(null);
        try {
            await uploadMission(waypoints);
            uploadedCountStore.set(waypoints.length);
            uploadedWaypointsStore.set([...waypoints]);
        } catch (error) {
            setUploadError(message(error));
            throw error;
        } finally {
            setUploading(false);
        }
    }, [waypoints]);

    const start = useCallback(async () => {
        setStarting(true);
        setStartError(null);
        try {
            await sendVehicleCommand({type: "startMission"});
        } catch (error) {
            setStartError(message(error));
            throw error;
        } finally {
            setStarting(false);
        }
    }, []);

    return {
        waypoints,
        addWaypoint,
        removeWaypoint,
        moveWaypoint,
        setAltitude,
        setSpeed,
        setAction,
        loadWaypoints,
        clear,
        upload,
        uploading,
        uploadError,
        start,
        starting,
        startError,
    };
}
