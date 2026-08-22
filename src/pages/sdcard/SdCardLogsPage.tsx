import {useEffect, useState} from "react";
import {listSdcardLogs, SdCardLogEntry} from "@/lib/sdcard/sdcardFiles.ts";
import SdCardPageShell from "./SdCardPageShell.tsx";

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatModified(modifiedUnix: number | null): string {
    if (modifiedUnix === null) return "Unknown";
    return new Date(modifiedUnix * 1000).toLocaleString();
}

interface LogsAreaProps {
    folder: string;
    onAnalyze: (path: string) => void;
}

function LogsArea({folder, onAnalyze}: LogsAreaProps) {
    const [entries, setEntries] = useState<SdCardLogEntry[]>([]);
    const [listing, setListing] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // `async`/`await` inside `try` rather than a `.then()`/`.catch()`
    // chain: `listSdcardLogs` throws synchronously (via `requireBackend`)
    // when called outside the desktop app, and only a `try` around the
    // call itself — not a `.catch()` attached after it — can catch that.
    const refresh = async () => {
        setListing(true);
        setError(null);
        try {
            setEntries(await listSdcardLogs(folder));
        } catch (err) {
            setError(message(err));
        } finally {
            setListing(false);
        }
    };

    // Scans as soon as a folder is picked, same reasoning as the live Logs
    // page's on-load refresh — an operator shouldn't have to know to click
    // Refresh before anything shows up.
    useEffect(() => {
        void refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [folder]);

    return (
        <div className="flex h-full w-full flex-col">
            <div className="flex h-control-sm shrink-0 items-center justify-end border-b border-border-subtle px-3">
                <button
                    type="button"
                    disabled={listing}
                    onClick={() => void refresh()}
                    className="h-control-sm w-fit border border-border-subtle px-3 text-label text-text-primary hover:enabled:bg-layer-hover-01 disabled:text-text-disabled"
                >
                    {listing ? "Scanning…" : "Refresh"}
                </button>
            </div>
            {error && (
                <div className="flex h-control-sm shrink-0 items-center border-b border-border-subtle px-3">
                    <span className="text-label text-state-danger">{error}</span>
                </div>
            )}
            <div className="min-h-0 flex-1 overflow-auto">
                <div className="flex items-center gap-4 border-b border-border-subtle bg-layer-01 px-3 py-2 text-micro text-text-helper uppercase">
                    <span className="min-w-0 flex-1">Path</span>
                    <span className="w-48 shrink-0">Modified</span>
                    <span className="w-20 shrink-0">Size</span>
                    <span className="w-[100px] shrink-0"/>
                </div>
                {entries.length === 0 ? (
                    <div className="p-6 text-center text-label text-text-helper">
                        {listing ? "Scanning for logs…" : "No .bin logs found in this folder."}
                    </div>
                ) : (
                    entries.map((entry) => (
                        <div key={entry.relativePath} className="flex items-center gap-4 border-b border-border-subtle px-3 py-2 text-label">
                            <span className="min-w-0 flex-1 truncate font-mono text-text-primary" title={entry.relativePath}>
                                {entry.relativePath}
                            </span>
                            <span className="w-48 shrink-0 text-text-secondary">{formatModified(entry.modifiedUnix)}</span>
                            <span className="w-20 shrink-0 text-text-secondary">{formatSize(entry.size)}</span>
                            <button
                                type="button"
                                onClick={() => onAnalyze(entry.absolutePath)}
                                className="h-control-sm w-fit shrink-0 border border-border-subtle px-3 text-label text-text-primary hover:enabled:bg-layer-hover-01"
                            >
                                Analyze
                            </button>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}

interface SdCardLogsPageProps {
    /** Opens Log Analysis for one of these logs' absolute on-disk path.
     * Unlike the live Logs page, there's no download step first — the file
     * is already local, so this hands `LogAnalysisPage` the same kind of
     * path a completed download would have. */
    onAnalyze: (path: string) => void;
}

/**
 * Lists `.bin` dataflash logs found anywhere under the chosen folder
 * instead of downloading them from a live vehicle over MAVLink (see the
 * live `LogsPage`). Read-only — there's nothing to write back to a log.
 */
export default function SdCardLogsPage({onAnalyze}: SdCardLogsPageProps) {
    return <SdCardPageShell noun="logs">{(folder) => <LogsArea folder={folder} onAnalyze={onAnalyze}/>}</SdCardPageShell>;
}
