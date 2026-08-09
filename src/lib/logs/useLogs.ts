import {useSyncExternalStore} from "react";
import {cancelCurrentDownload, downloadLog, logsStore, refreshLogs} from "./logsStore.ts";

export type {DownloadProgress} from "./logsStore.ts";

/**
 * Reads the module-level logs store (`logsStore.ts`) — listing, download
 * progress, and saved paths all live there rather than in this hook, so
 * they keep updating whether or not the Logs page is the thing currently
 * mounted. This hook is just the React-facing read side of it.
 */
export function useLogs() {
    const state = useSyncExternalStore(logsStore.subscribe, logsStore.getSnapshot);
    return {
        entries: state.entries,
        listing: state.listing,
        listError: state.listError,
        refresh: refreshLogs,
        download: downloadLog,
        cancel: cancelCurrentDownload,
        downloadingId: state.downloadingId,
        progress: state.progress,
        downloadError: state.downloadError,
        savedPaths: state.savedPaths,
    };
}
