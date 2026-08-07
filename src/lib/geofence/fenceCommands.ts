import {invoke} from "@tauri-apps/api/core";
import {requireBackend} from "@/lib/vehicle/connection.ts";
import type {DownloadedFence} from "./fence.ts";

export function uploadFence(points: {lat: number; lon: number}[]): Promise<void> {
    requireBackend();
    return invoke<void>("upload_fence", {points});
}

export function downloadFence(): Promise<DownloadedFence> {
    requireBackend();
    return invoke<DownloadedFence>("download_fence");
}
