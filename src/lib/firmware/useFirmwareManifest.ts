import {useSyncExternalStore} from "react";
import {createStore} from "@/lib/store.ts";
import {fetchFirmwareManifest, FirmwareOption, ManifestVehicleType} from "./firmwareFlash.ts";

export type FirmwareManifestState =
    | {status: "loading"}
    | {status: "error"; message: string}
    | {status: "ready"; options: FirmwareOption[]};

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

const VEHICLE_TYPES: ManifestVehicleType[] = ["Copter", "Plane"];

const manifestStore = createStore<Map<ManifestVehicleType, FirmwareManifestState>>(
    new Map(VEHICLE_TYPES.map((type) => [type, {status: "loading"}])),
);

async function load(vehicletype: ManifestVehicleType): Promise<void> {
    manifestStore.update((prev) => new Map(prev).set(vehicletype, {status: "loading"}));
    try {
        const options = await fetchFirmwareManifest(vehicletype);
        manifestStore.update((prev) => new Map(prev).set(vehicletype, {status: "ready", options}));
    } catch (error) {
        manifestStore.update((prev) => new Map(prev).set(vehicletype, {status: "error", message: message(error)}));
    }
}

// Both catalogs are the same ArduPilot-published board list regardless of
// which vehicle is connected (or whether one is at all) — fetched once at
// module load so they're already sitting there the first time the Firmware
// page opens, rather than starting a multi-second download every visit.
for (const type of VEHICLE_TYPES) {
    void load(type);
}

export function retryFirmwareManifest(vehicletype: ManifestVehicleType): void {
    void load(vehicletype);
}

export function useFirmwareManifest(vehicletype: ManifestVehicleType): FirmwareManifestState {
    const snapshot = useSyncExternalStore(manifestStore.subscribe, manifestStore.getSnapshot);
    return snapshot.get(vehicletype) ?? {status: "loading"};
}
