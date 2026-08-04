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
