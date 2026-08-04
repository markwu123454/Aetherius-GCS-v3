import {useSyncExternalStore} from "react";
import {listen} from "@tauri-apps/api/event";
import {createStore} from "@/lib/store.ts";
import {ConnectionStatus} from "@/lib/vehicle/connection.ts";
import {clearVehicleCache, syncVehicleScripts} from "./scriptFiles.ts";

export interface VehicleScriptSync {
    /** The mirror is fully populated — safe to list/open `/vehicle` now. */
    ready: boolean;
    syncing: boolean;
    error: string | null;
    retry: () => void;
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

interface SyncState {
    ready: boolean;
    syncing: boolean;
    error: string | null;
}

const syncStore = createStore<SyncState>({ready: false, syncing: false, error: null});

// Bumped on every connect/disconnect so a sync result that lands after the
// connection has already moved on gets thrown away instead of resurrecting
// stale ready/error state.
let generation = 0;

function runSync(): void {
    const gen = ++generation;
    syncStore.set({ready: false, syncing: true, error: null});
    syncVehicleScripts()
        .then(() => {
            if (generation === gen) syncStore.set({ready: true, syncing: false, error: null});
        })
        .catch((err) => {
            if (generation === gen) syncStore.set({ready: false, syncing: false, error: message(err)});
        });
}

/**
 * Vehicle scripts are mirrored to a local cache the moment the vehicle
 * connects (see `sync_vehicle_scripts` in scripting.rs) rather than read
 * live over FTP on every click. `ready` gates the rest of the scripting UI
 * on that mirror actually being populated, not just on the link being up —
 * `useFileTree`'s vehicle side has no idea this sync exists, it just reacts
 * to `ready`'s own edge. On disconnect the mirror is deleted outright rather
 * than kept around for a future reconnect, since a different vehicle could
 * show up next with different files at the same paths.
 *
 * Subscribed once, at module load, rather than per component — the mirror
 * needs to track the connection whether or not the Scripting page is
 * currently open, same reasoning `vehicleStore` documents for telemetry.
 */
listen<ConnectionStatus>("link-status", (event) => {
    generation++;
    if (event.payload === "connected") {
        runSync();
    } else {
        syncStore.set({ready: false, syncing: false, error: null});
        void clearVehicleCache();
    }
}).catch(() => {
    // No Tauri backend — the store just never updates.
});

export function useVehicleScriptSync(): VehicleScriptSync {
    const state = useSyncExternalStore(syncStore.subscribe, syncStore.getSnapshot);
    return {...state, retry: runSync};
}

/** For stores that need to react to the sync's ready/not-ready edge without
 * subscribing to it as a React value themselves — see `useFileTree`. */
export function subscribeVehicleScriptSync(listener: () => void): () => void {
    return syncStore.subscribe(listener);
}

export function getVehicleScriptSync(): SyncState {
    return syncStore.getSnapshot();
}
