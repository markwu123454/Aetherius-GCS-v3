import {listen} from "@tauri-apps/api/event";
import {createStore} from "@/lib/store.ts";
import {
    cancelDownload as cancelDownloadCommand,
    DOWNLOAD_CANCELLED,
    downloadLog as downloadLogCommand,
    listDownloadedLogs,
    listLogs,
    LogEntry,
} from "./logs.ts";

/** The raw event shape the backend emits — just the byte counts. Rate and
 * ETA are derived on this side, against wall-clock time measured from when
 * the download started. */
interface RawProgress {
    id: number;
    received: number;
    total: number;
}

export interface DownloadProgress extends RawProgress {
    /** `received / total`, 0–100. */
    percent: number;
    /** Average throughput since the download started. `0` until the first
     * progress event lands. */
    bytesPerSec: number;
    /** `null` until `bytesPerSec` is known. */
    etaSeconds: number | null;
}

interface LogsState {
    entries: LogEntry[];
    listing: boolean;
    listError: string | null;
    downloadingId: number | null;
    progress: DownloadProgress | null;
    downloadError: string | null;
    savedPaths: Map<number, string>;
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Module-level store for the Logs page — not a React hook's local state,
 * on purpose. A download has to keep running (and its progress/cancel
 * button has to keep working) whether or not the Logs page happens to be
 * the thing currently on screen: navigating to Log Analysis or back to the
 * workspace mid-download shouldn't lose track of it, and the backend only
 * tracks one in-flight download at a time (`logs/mod.rs`'s `LogsState`),
 * so the frontend needs exactly one source of truth too, not one per
 * mounted component. See `store.ts` and `useServoOutputs.ts` for the same
 * pattern elsewhere.
 */
const store = createStore<LogsState>({
    entries: [],
    listing: false,
    listError: null,
    downloadingId: null,
    progress: null,
    downloadError: null,
    savedPaths: new Map(),
});

export const logsStore = store;

// When the current download started, for the rate/ETA math below — a
// module-level variable rather than component state, since the progress
// event listener that reads it is itself module-level (see below).
let downloadStart: {id: number; startedAt: number} | null = null;

// Registered once, at module load, rather than inside a component effect —
// this is what makes progress keep updating even while no component is
// mounted to display it.
listen<RawProgress>("log-download-progress", (event) => {
    const payload = event.payload;
    if (!downloadStart || downloadStart.id !== payload.id) {
        return; // a stale event from a download this store no longer owns
    }
    const elapsedSec = (Date.now() - downloadStart.startedAt) / 1000;
    const bytesPerSec = elapsedSec > 0 ? payload.received / elapsedSec : 0;
    const remaining = payload.total - payload.received;
    const etaSeconds = bytesPerSec > 0 ? remaining / bytesPerSec : null;
    const percent = (payload.received / payload.total) * 100;
    store.update((s) => ({...s, progress: {...payload, percent, bytesPerSec, etaSeconds}}));
}).catch(() => {});

/**
 * Lists what's on the vehicle and cross-references it against what's
 * already on disk for this vehicle (`listDownloadedLogs`, scoped by the
 * connected board's own hardware UID), so a log downloaded in an earlier
 * session — or before the app was last restarted — still shows as saved.
 */
export async function refreshLogs(): Promise<void> {
    store.update((s) => ({...s, listing: true, listError: null}));
    try {
        const [entries, downloaded] = await Promise.all([listLogs(), listDownloadedLogs()]);
        store.update((s) => {
            const savedPaths = new Map(s.savedPaths);
            for (const d of downloaded) savedPaths.set(d.id, d.path);
            return {...s, entries, savedPaths};
        });
    } catch (err) {
        store.update((s) => ({...s, listError: message(err)}));
    } finally {
        store.update((s) => ({...s, listing: false}));
    }
}

/**
 * Starts downloading `entry`. A no-op if a download is already in flight —
 * the backend only tracks one at a time, so this is the single call site
 * that can start one, rather than trusting every caller not to double-fire.
 */
export async function downloadLog(entry: LogEntry): Promise<void> {
    if (store.getSnapshot().downloadingId !== null) {
        return;
    }
    downloadStart = {id: entry.id, startedAt: Date.now()};
    store.update((s) => ({
        ...s,
        downloadingId: entry.id,
        downloadError: null,
        progress: {id: entry.id, received: 0, total: entry.size, percent: 0, bytesPerSec: 0, etaSeconds: null},
    }));
    try {
        const path = await downloadLogCommand(entry.id, entry.size);
        store.update((s) => ({...s, savedPaths: new Map(s.savedPaths).set(entry.id, path)}));
    } catch (err) {
        // A user-initiated cancel isn't a failure — leave it quiet rather
        // than showing it as an error.
        if (message(err) !== DOWNLOAD_CANCELLED) {
            store.update((s) => ({...s, downloadError: message(err)}));
        }
    } finally {
        downloadStart = null;
        store.update((s) => ({...s, downloadingId: null, progress: null}));
    }
}

/** Cancels the in-flight download, if any. */
export function cancelCurrentDownload(): void {
    const id = store.getSnapshot().downloadingId;
    if (id !== null) {
        void cancelDownloadCommand(id);
    }
}
