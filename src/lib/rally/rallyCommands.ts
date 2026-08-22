import {invoke} from "@tauri-apps/api/core";
import {requireBackend} from "@/lib/vehicle/connection.ts";
import type {DownloadedRallyPoint} from "./rally.ts";

export function uploadRally(points: {lat: number; lon: number; alt: number}[]): Promise<void> {
    requireBackend();
    return invoke<void>("upload_rally", {points});
}

export async function downloadRally(): Promise<DownloadedRallyPoint[]> {
    requireBackend();
    return invoke<DownloadedRallyPoint[]>("download_rally");
}
