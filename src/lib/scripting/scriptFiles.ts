import {invoke} from "@tauri-apps/api/core";
import {requireBackend} from "@/lib/vehicle/connection.ts";

export type Root = "local" | "vehicle";

export interface FsEntry {
    name: string;
    isDir: boolean;
}

/** Joins a directory path and a child name into a relative path — `""` is
 * the root, so it's the one case that doesn't want a leading slash. */
export function joinPath(dir: string, name: string): string {
    return dir === "" ? name : `${dir}/${name}`;
}

export function parentPath(path: string): string {
    const slash = path.lastIndexOf("/");
    return slash === -1 ? "" : path.slice(0, slash);
}

// --- Local: $APPDATA/scripts ---

export function listLocalDir(path: string): Promise<FsEntry[]> {
    requireBackend();
    return invoke<FsEntry[]>("list_local_dir", {path});
}

export function readLocalFile(path: string): Promise<string> {
    requireBackend();
    return invoke<string>("read_local_file", {path});
}

export function writeLocalFile(path: string, content: string): Promise<void> {
    requireBackend();
    return invoke<void>("write_local_file", {path, content});
}

export function createLocalFile(path: string): Promise<void> {
    requireBackend();
    return invoke<void>("create_local_file", {path});
}

export function createLocalDir(path: string): Promise<void> {
    requireBackend();
    return invoke<void>("create_local_dir", {path});
}

export function deleteLocal(path: string): Promise<void> {
    requireBackend();
    return invoke<void>("delete_local", {path});
}

/** `overwrite` only ever applies to a file destination — an existing folder
 * at `newPath` is always rejected, overwrite or not (see scripting.rs). */
export function renameLocal(oldPath: string, newPath: string, overwrite = false): Promise<void> {
    requireBackend();
    return invoke<void>("rename_local", {oldPath, newPath, overwrite});
}

/** Absolute on-disk path for a `/local` entry — only needed to hand a real
 * filesystem path to the OS for a native drag-out, not for anything else
 * here (every other local operation takes the relative path). */
export function absoluteLocalPath(path: string): Promise<string> {
    requireBackend();
    return invoke<string>("absolute_local_path", {path});
}

// --- Vehicle: /APM/scripts over MAVLink FTP ---

export function listVehicleDir(path: string): Promise<FsEntry[]> {
    requireBackend();
    return invoke<FsEntry[]>("list_vehicle_dir", {path});
}

export function uploadToVehicle(localPath: string, remotePath: string): Promise<void> {
    requireBackend();
    return invoke<void>("upload_to_vehicle", {localPath, remotePath});
}

export function downloadFromVehicle(remotePath: string, localPath: string, overwrite = false): Promise<void> {
    requireBackend();
    return invoke<void>("download_vehicle_file", {remotePath, localPath, overwrite});
}

export function readVehicleFile(path: string): Promise<string> {
    requireBackend();
    return invoke<string>("read_vehicle_file", {path});
}

export function writeVehicleFile(path: string, content: string): Promise<void> {
    requireBackend();
    return invoke<void>("write_vehicle_file", {path, content});
}

export function createVehicleFile(path: string): Promise<void> {
    requireBackend();
    return invoke<void>("create_vehicle_file", {path});
}

export function createVehicleDir(path: string): Promise<void> {
    requireBackend();
    return invoke<void>("create_vehicle_dir", {path});
}

export function deleteVehicle(path: string, isDir: boolean): Promise<void> {
    requireBackend();
    return invoke<void>("delete_vehicle", {path, isDir});
}

/** Same `overwrite` contract as `renameLocal`. */
export function renameVehicle(oldPath: string, newPath: string, overwrite = false): Promise<void> {
    requireBackend();
    return invoke<void>("rename_vehicle", {oldPath, newPath, overwrite});
}

/** Absolute path of a `/vehicle` entry in the local mirror — see
 * `absoluteLocalPath` above; same purpose, same caveat that it's a cache
 * path, not anything that exists on the vehicle itself. */
export function absoluteVehiclePath(path: string): Promise<string> {
    requireBackend();
    return invoke<string>("absolute_vehicle_path", {path});
}

/** Clears and re-downloads the entire `/vehicle` mirror from the aircraft
 * over MAVLink FTP — call once when the vehicle connects (or when retrying
 * after a failed sync), not on every read. */
export function syncVehicleScripts(): Promise<void> {
    requireBackend();
    return invoke<void>("sync_vehicle_scripts");
}

/** Wipes the `/vehicle` mirror — call on disconnect so a stale mirror never
 * outlives the connection it was built from. */
export function clearVehicleCache(): Promise<void> {
    requireBackend();
    return invoke<void>("clear_vehicle_cache");
}
