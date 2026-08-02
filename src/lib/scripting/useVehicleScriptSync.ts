import {useEffect, useRef, useState} from "react";
import {clearVehicleCache, syncVehicleScripts} from "./scriptFiles.ts";

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export interface VehicleScriptSync {
    /** The mirror is fully populated — safe to list/open `/vehicle` now. */
    ready: boolean;
    syncing: boolean;
    error: string | null;
    retry: () => void;
}

/**
 * Vehicle scripts are mirrored to a local cache the moment the vehicle
 * connects (see `sync_vehicle_scripts` in scripting.rs) rather than read
 * live over FTP on every click. `ready` gates the rest of the scripting UI
 * on that mirror actually being populated, not just on the link being up —
 * `useFileTree`'s vehicle side has no idea this sync exists, it just trusts
 * whatever boolean it's handed means "safe to list now". On disconnect the
 * mirror is deleted outright rather than kept around for a future reconnect,
 * since a different vehicle could show up next with different files at the
 * same paths.
 */
export function useVehicleScriptSync(connected: boolean): VehicleScriptSync {
    const [ready, setReady] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Bumped on every connect/disconnect so a sync result that lands after
    // the connection has already moved on gets thrown away instead of
    // resurrecting stale ready/error state.
    const generation = useRef(0);

    const runSync = () => {
        const gen = ++generation.current;
        setSyncing(true);
        setError(null);
        setReady(false);
        syncVehicleScripts()
            .then(() => {
                if (generation.current === gen) setReady(true);
            })
            .catch((err) => {
                if (generation.current === gen) setError(message(err));
            })
            .finally(() => {
                if (generation.current === gen) setSyncing(false);
            });
    };

    useEffect(() => {
        generation.current++;
        if (connected) {
            runSync();
        } else {
            setReady(false);
            setSyncing(false);
            setError(null);
            void clearVehicleCache();
        }
        // `runSync` is intentionally not a dependency — it's re-created every
        // render but only ever needs to run in response to `connected`
        // actually changing, or via the returned `retry`.
    }, [connected]);

    return {ready, syncing, error, retry: runSync};
}
