import {useCallback, useRef, useState} from "react";
import {useTauriEvent} from "@/lib/tauriEvent.ts";
import {downloadLog, listLogs, LogEntry} from "./logs.ts";

/** The raw event shape the backend emits — just the byte counts. Rate and
 * ETA are derived on this side, against wall-clock time measured from when
 * `download()` was called, rather than asking the backend to do it. */
interface RawProgress {
    id: number;
    received: number;
    total: number;
}

export interface DownloadProgress extends RawProgress {
    /** Average throughput since the download started. `0` until the first
     * progress event lands. */
    bytesPerSec: number;
    /** `null` until `bytesPerSec` is known — showing "ETA: —" beats a
     * misleading "ETA: Infinity" or a divide-by-zero NaN. */
    etaSeconds: number | null;
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Drives the Logs page: list what's on the vehicle, download one at a time.
 * Downloads are sequential by construction — `downloadingId` is a single
 * slot, not a set — matching the backend, which only tracks one in-flight
 * chunk request at a time (see `logs.rs`).
 */
export function useLogs() {
    const [entries, setEntries] = useState<LogEntry[]>([]);
    const [listing, setListing] = useState(false);
    const [listError, setListError] = useState<string | null>(null);

    const [downloadingId, setDownloadingId] = useState<number | null>(null);
    const [progress, setProgress] = useState<DownloadProgress | null>(null);
    const [downloadError, setDownloadError] = useState<string | null>(null);
    // Keyed by log id so a completed download's path stays visible
    // ("saved to ...") even after downloading a different log afterward.
    const [savedPaths, setSavedPaths] = useState<Map<number, string>>(new Map());

    // When the current download started, for the rate/ETA math below —
    // a ref rather than state, since it's read from inside the event
    // handler on every progress tick, not something that itself needs to
    // trigger a render.
    const startRef = useRef<{id: number; startedAt: number} | null>(null);

    const refresh = useCallback(async () => {
        setListing(true);
        setListError(null);
        try {
            setEntries(await listLogs());
        } catch (err) {
            setListError(message(err));
        } finally {
            setListing(false);
        }
    }, []);

    const download = useCallback(async (entry: LogEntry) => {
        setDownloadingId(entry.id);
        setDownloadError(null);
        startRef.current = {id: entry.id, startedAt: Date.now()};
        setProgress({id: entry.id, received: 0, total: entry.size, bytesPerSec: 0, etaSeconds: null});
        try {
            const path = await downloadLog(entry.id, entry.size);
            setSavedPaths((prev) => new Map(prev).set(entry.id, path));
        } catch (err) {
            setDownloadError(message(err));
        } finally {
            setDownloadingId(null);
            startRef.current = null;
        }
    }, []);

    useTauriEvent<RawProgress>("log-download-progress", (payload) => {
        const start = startRef.current;
        if (!start || start.id !== payload.id) {
            return; // a stale event from a download this session no longer owns
        }
        const elapsedSec = (Date.now() - start.startedAt) / 1000;
        const bytesPerSec = elapsedSec > 0 ? payload.received / elapsedSec : 0;
        const remaining = payload.total - payload.received;
        const etaSeconds = bytesPerSec > 0 ? remaining / bytesPerSec : null;
        setProgress({...payload, bytesPerSec, etaSeconds});
    });

    return {entries, listing, listError, refresh, download, downloadingId, progress, downloadError, savedPaths};
}
