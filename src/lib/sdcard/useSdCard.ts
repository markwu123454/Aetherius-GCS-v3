import {useSyncExternalStore} from "react";
import {open as openDialog} from "@tauri-apps/plugin-dialog";
import {createStore} from "@/lib/store.ts";

const STORAGE_KEY = "aetherius.sdcard.folder";

function loadFolder(): string | null {
    try {
        return window.localStorage.getItem(STORAGE_KEY);
    } catch {
        return null;
    }
}

function saveFolder(path: string | null): void {
    try {
        if (path) {
            window.localStorage.setItem(STORAGE_KEY, path);
        } else {
            window.localStorage.removeItem(STORAGE_KEY);
        }
    } catch {
        // Not being able to remember the last folder across launches is not
        // worth failing over — worst case the user re-picks it.
    }
}

// Module-scope store (see `store.ts`), same reasoning as `treeStore` in
// `useFileTree.ts`: the "Choose Folder" menu item and the three SD Card
// pages all need to agree on the same folder whether or not any of them
// happen to be mounted at the time it changes.
const folderStore = createStore<string | null>(loadFolder());

/** Opens the native folder picker and adopts the result as the SD card
 * root. Cancelling (or picking nothing) leaves whatever folder was already
 * active in place, rather than clearing it. */
async function chooseFolder(): Promise<void> {
    const path = await openDialog({directory: true, multiple: false});
    if (!path || Array.isArray(path)) return; // user cancelled
    folderStore.set(path);
    saveFolder(path);
}

function clearFolder(): void {
    folderStore.set(null);
    saveFolder(null);
}

export interface SdCard {
    /** Absolute path to the folder currently backing SD Card mode, or
     * `null` if none has been chosen yet. Persisted across launches. */
    folder: string | null;
    chooseFolder: () => void;
    clearFolder: () => void;
}

/**
 * SD Card mode's data source — a folder on disk standing in for a live
 * vehicle connection. The Logs / Parameters / Scripts pages under SD Card
 * read from whatever this hook reports rather than from `useConnection`.
 */
export function useSdCard(): SdCard {
    const folder = useSyncExternalStore(folderStore.subscribe, folderStore.getSnapshot);
    return {folder, chooseFolder: () => void chooseFolder(), clearFolder};
}
