import {invoke} from "@tauri-apps/api/core";
import {requireBackend} from "@/lib/vehicle/connection.ts";

export interface FsEntry {
    name: string;
    isDir: boolean;
}

/** Joins a directory path and a child name into a relative path — `""` is
 * the root, so it's the one case that doesn't want a leading slash. Same
 * shape as `scripting/scriptFiles.ts`'s, kept separate rather than shared
 * since this module's root is an arbitrary user-chosen folder, not a fixed
 * one. */
export function joinPath(dir: string, name: string): string {
    return dir === "" ? name : `${dir}/${name}`;
}

export function parentPath(path: string): string {
    const slash = path.lastIndexOf("/");
    return slash === -1 ? "" : path.slice(0, slash);
}

// Every function here takes `root` explicitly (the folder from
// `useSdCard`) rather than the backend holding onto it — stateless calls
// can't drift out of sync with whatever folder is currently chosen, even
// across a `chooseFolder()` pick mid-session.

export function listSdcardDir(root: string, path: string): Promise<FsEntry[]> {
    requireBackend();
    return invoke<FsEntry[]>("list_sdcard_dir", {root, path});
}

export function readSdcardFile(root: string, path: string): Promise<string> {
    requireBackend();
    return invoke<string>("read_sdcard_file", {root, path});
}

export function writeSdcardFile(root: string, path: string, content: string): Promise<void> {
    requireBackend();
    return invoke<void>("write_sdcard_file", {root, path, content});
}

export function createSdcardFile(root: string, path: string): Promise<void> {
    requireBackend();
    return invoke<void>("create_sdcard_file", {root, path});
}

export function createSdcardDir(root: string, path: string): Promise<void> {
    requireBackend();
    return invoke<void>("create_sdcard_dir", {root, path});
}

export function deleteSdcard(root: string, path: string): Promise<void> {
    requireBackend();
    return invoke<void>("delete_sdcard", {root, path});
}

/** Same `overwrite` contract as `scripting/scriptFiles.ts`'s `renameLocal`. */
export function renameSdcard(root: string, oldPath: string, newPath: string, overwrite = false): Promise<void> {
    requireBackend();
    return invoke<void>("rename_sdcard", {root, oldPath, newPath, overwrite});
}

export interface SdCardLogEntry {
    relativePath: string;
    absolutePath: string;
    size: number;
    /** Seconds since the Unix epoch — `null` if the filesystem couldn't
     * report a modified time. */
    modifiedUnix: number | null;
}

/** Recursively finds every `.bin` dataflash log under `root` — a real SD
 * card nests these a couple of folders down (`APM/LOGS/*.BIN`), so this
 * doesn't require the folder picker to land exactly on that subfolder. */
export function listSdcardLogs(root: string): Promise<SdCardLogEntry[]> {
    requireBackend();
    return invoke<SdCardLogEntry[]>("list_sdcard_logs", {root});
}

export interface ScriptsDirResolution {
    /** Absolute path — either where scripts were actually found, or (when
     * `exists` is `false`) the canonical `APM/scripts` location a "create
     * it" action should create. */
    path: string;
    exists: boolean;
}

/** Finds where ArduPilot actually keeps Lua scripts under `root`
 * (`APM/scripts`, same convention as the live vehicle mirror — see
 * `scripting/scriptFiles.ts`), so the Scripts page can root itself there
 * directly instead of showing the whole card. */
export function resolveSdcardScriptsDir(root: string): Promise<ScriptsDirResolution> {
    requireBackend();
    return invoke<ScriptsDirResolution>("resolve_sdcard_scripts_dir", {root});
}

/** Creates the folder a `resolveSdcardScriptsDir` result pointed at when
 * `exists` came back `false` — takes that already-resolved absolute path
 * directly, not a `root`/relative pair. */
export function createSdcardScriptsDir(path: string): Promise<void> {
    requireBackend();
    return invoke<void>("create_sdcard_scripts_dir", {path});
}
