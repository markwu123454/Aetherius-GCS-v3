import {useEffect} from "react";
import {useConnection} from "@/lib/vehicle/useConnection.ts";
import {useLogs, DownloadProgress} from "@/lib/logs/useLogs.ts";
import {LogEntry} from "@/lib/logs/logs.ts";

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRate(bytesPerSec: number): string {
    if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`;
    return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
}

function formatDuration(seconds: number): string {
    const whole = Math.max(0, Math.ceil(seconds));
    if (whole < 60) return `${whole}s`;
    return `${Math.floor(whole / 60)}m ${whole % 60}s`;
}

/** Seconds since the Unix epoch for 1980-01-01T00:00:00Z — the FAT
 * filesystem's default/uninitialized timestamp. A board that's never had a
 * GPS fix (no other UTC time source) free-runs its RTC from this default
 * rather than reporting `0`, so `LOG_ENTRY.time_utc` comes back as this
 * value (or a few seconds/minutes past it) instead of a real recorded
 * time — worth treating the same as "unknown" rather than showing a
 * misleadingly specific-looking 1980 date. */
const FAT_EPOCH_UTC_SECONDS = 315_532_800;
/** How far past the FAT default still counts as "never got a real fix" —
 * generous on purpose, since the RTC keeps ticking from that default for
 * as long as the board stays powered before a fix (or a log close) ever
 * happens. */
const FAT_EPOCH_GRACE_SECONDS = 24 * 60 * 60;

function formatTime(timeUtc: number): string {
    if (timeUtc === 0 || timeUtc < FAT_EPOCH_UTC_SECONDS + FAT_EPOCH_GRACE_SECONDS) {
        return "Unknown";
    }
    return new Date(timeUtc * 1000).toLocaleString();
}

interface LogRowProps {
    entry: LogEntry;
    downloading: boolean;
    progress: DownloadProgress | null;
    savedPath: string | undefined;
    onDownload: () => void;
    onCancel: () => void;
    onAnalyze: ((path: string) => void) | undefined;
}

function LogRow({entry, downloading, progress, savedPath, onDownload, onCancel, onAnalyze}: LogRowProps) {
    return (
        <div className="flex items-center gap-4 border-b border-border-subtle px-3 py-2 text-label">
            <span className="w-16 shrink-0 text-text-helper">#{entry.id}</span>
            <span className="w-48 shrink-0 text-text-primary">{formatTime(entry.timeUtc)}</span>
            <span className="w-20 shrink-0 text-text-secondary">{formatSize(entry.size)}</span>
            <div className="flex min-w-0 flex-1 items-center gap-2">
                {downloading && progress && (
                    <span className="text-text-helper">
                        {formatSize(progress.received)} / {formatSize(progress.total)} ({Math.round(progress.percent)}%)
                        {progress.bytesPerSec > 0 && ` · ${formatRate(progress.bytesPerSec)}`}
                        {progress.etaSeconds !== null && ` · ${formatDuration(progress.etaSeconds)} left`}
                    </span>
                )}
                {!downloading && savedPath && (
                    <span className="truncate text-state-ok" title={savedPath}>
                        Saved to {savedPath}
                    </span>
                )}
            </div>
            {savedPath && onAnalyze && (
                <button
                    type="button"
                    disabled={downloading}
                    onClick={() => onAnalyze(savedPath)}
                    className="h-control-sm w-fit shrink-0 border border-border-subtle px-3 text-label text-text-primary hover:enabled:bg-layer-hover-01 disabled:text-text-disabled"
                >
                    Analyze
                </button>
            )}
            <button
                type="button"
                onClick={downloading ? onCancel : onDownload}
                className="h-control-sm w-fit shrink-0 border border-border-subtle px-3 text-label text-text-primary hover:enabled:bg-layer-hover-01 disabled:text-text-disabled"
            >
                {downloading ? "Cancel" : savedPath ? "Re-download" : "Download"}
            </button>
        </div>
    );
}

interface LogsPageProps {
    /** Opens Log Analysis for a downloaded log's local path. Left
     * undefined has the same effect as no log being downloaded yet — no
     * row shows an Analyze button — since there's nothing to analyze
     * without somewhere to send the request. */
    onAnalyze?: (path: string) => void;
}

/**
 * Lists dataflash logs off the vehicle and downloads them to local disk.
 * Once a log is on disk, its row's Analyze button opens Log Analysis
 * (`LogAnalysisPage`) on it — see `logs/analysis.rs` for the parsing this
 * feeds.
 */
export default function LogsPage({onAnalyze}: LogsPageProps) {
    const connection = useConnection();
    const connected = connection.status === "connected";
    const logs = useLogs();

    // Scans on load rather than waiting for a manual Refresh click — both
    // the vehicle's own listing and what's already on disk for it (see
    // `logsStore.ts`), so a log downloaded in an earlier session shows as
    // saved the moment this page is worth showing at all.
    useEffect(() => {
        if (connected) {
            void logs.refresh();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connected]);

    if (!connected) {
        return (
            <div className="flex h-full w-full items-center justify-center text-label text-text-helper">
                Connect a vehicle to see its logs.
            </div>
        );
    }

    return (
        <div className="flex h-full w-full flex-col gap-6 p-6">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-heading text-text-primary">Logs</h2>
                    <p className="text-body text-text-secondary">
                        Dataflash logs recorded on the vehicle's SD card — one per flight, plus anything logged while
                        disarmed if <span className="font-mono">LOG_DISARMED</span> is set.
                    </p>
                </div>
                <button
                    type="button"
                    disabled={logs.listing}
                    onClick={() => void logs.refresh()}
                    className="h-control-sm w-fit border border-border-subtle px-3 text-label text-text-primary hover:enabled:bg-layer-hover-01 disabled:text-text-disabled"
                >
                    {logs.listing ? "Refreshing…" : "Refresh"}
                </button>
            </div>

            {logs.listError && <p className="text-label text-state-danger">{logs.listError}</p>}
            {logs.downloadError && <p className="text-label text-state-danger">{logs.downloadError}</p>}

            <div className="min-h-0 flex-1 overflow-auto border border-border-subtle">
                <div className="flex items-center gap-4 border-b border-border-subtle bg-layer-01 px-3 py-2 text-micro text-text-helper uppercase">
                    <span className="w-16 shrink-0">ID</span>
                    <span className="w-48 shrink-0">Recorded</span>
                    <span className="w-20 shrink-0">Size</span>
                    <span className="min-w-0 flex-1" />
                    <span className="w-[220px] shrink-0" />
                </div>
                {logs.entries.length === 0 ? (
                    <div className="p-6 text-center text-label text-text-helper">
                        {logs.listing ? "Listing logs…" : "No logs listed yet — click Refresh."}
                    </div>
                ) : (
                    logs.entries.map((entry) => (
                        <LogRow
                            key={entry.id}
                            entry={entry}
                            downloading={logs.downloadingId === entry.id}
                            progress={logs.downloadingId === entry.id ? logs.progress : null}
                            savedPath={logs.savedPaths.get(entry.id)}
                            onDownload={() => void logs.download(entry)}
                            onCancel={logs.cancel}
                            onAnalyze={onAnalyze}
                        />
                    ))
                )}
            </div>
        </div>
    );
}
