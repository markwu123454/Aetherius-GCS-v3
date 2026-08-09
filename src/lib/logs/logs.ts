import {invoke} from "@tauri-apps/api/core";
import {requireBackend} from "@/lib/vehicle/connection.ts";

export interface LogEntry {
    id: number;
    /** Seconds since the Unix epoch. `0` means the vehicle had no RTC/GPS
     * time to stamp the log with when it was written — shown as unknown
     * rather than as the 1970 epoch. */
    timeUtc: number;
    size: number;
}

/**
 * Lists every dataflash log currently on the vehicle. Backed by ArduPilot's
 * `LOG_REQUEST_LIST`/`LOG_ENTRY` exchange (see `logs.rs`), which can take a
 * couple of seconds — the backend already retries for missing entries
 * before this resolves, so a caller doesn't need its own retry loop.
 */
export function listLogs(): Promise<LogEntry[]> {
    requireBackend();
    return invoke<LogEntry[]>("list_logs");
}

/**
 * Downloads one log's raw bytes to local disk and returns the path it was
 * saved to. `size` must be the value from that log's `LogEntry` — it's what
 * the backend uses to know when the transfer is complete. Emits
 * `log-download-progress` events (`{id, received, total}`) for the duration
 * of the transfer; subscribe before awaiting this if a progress bar is
 * needed, since large logs can take a while over a slow link.
 */
export function downloadLog(id: number, size: number): Promise<string> {
    requireBackend();
    return invoke<string>("download_log", {id, size});
}

/** The error message `downloadLog` rejects with when it stopped because of
 * `cancelDownload` rather than a real failure — matches the backend's
 * `CANCELLED` constant in `logs.rs`. */
export const DOWNLOAD_CANCELLED = "cancelled";

/**
 * Requests that an in-flight `downloadLog` for `id` stop after its current
 * chunk. A no-op if `id` isn't the download actually in progress. Doesn't
 * itself reject or resolve the pending `downloadLog` call — that promise
 * settles on its own once the backend loop notices and unwinds, rejecting
 * with `DOWNLOAD_CANCELLED`.
 */
export function cancelDownload(id: number): Promise<void> {
    requireBackend();
    return invoke("cancel_download", {id});
}

export interface DownloadedLog {
    id: number;
    path: string;
}

/**
 * Scans the connected vehicle's own logs folder on disk (scoped by its
 * hardware UID — see `vehicle_profile.rs`) for logs already downloaded, so
 * a log saved in an earlier session still shows as saved rather than only
 * ones `downloadLog` personally ran this session.
 */
export function listDownloadedLogs(): Promise<DownloadedLog[]> {
    requireBackend();
    return invoke<DownloadedLog[]>("list_downloaded_logs");
}
