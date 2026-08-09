import {invoke} from "@tauri-apps/api/core";
import {requireBackend} from "@/lib/vehicle/connection.ts";
import type {DownloadedFence} from "./fence.ts";

export function uploadFence(
    polygons: {lat: number; lon: number}[][],
    circles: {center: {lat: number; lon: number}; radiusM: number}[],
): Promise<void> {
    requireBackend();
    return invoke<void>("upload_fence", {
        polygons,
        circles: circles.map(({center, radiusM}) => ({center, radius: radiusM})),
    });
}

// Shape the Rust side actually serializes — `radius`, not `radiusM`. Mapped
// to the frontend's naming convention right at this boundary.
interface RawDownloadedFence {
    polygons: {vertices: {lat: number; lon: number}[]}[];
    circles: {center: {lat: number; lon: number}; radius: number}[];
}

export async function downloadFence(): Promise<DownloadedFence> {
    requireBackend();
    const raw = await invoke<RawDownloadedFence>("download_fence");
    return {
        polygons: raw.polygons,
        circles: raw.circles.map(({center, radius}) => ({center, radiusM: radius})),
    };
}
