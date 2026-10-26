import {useState} from "react";
import {CheckmarkFilled, DocumentDownload, DocumentExport, DocumentImport, TrashCan} from "@carbon/icons-react";
import {save as saveDialog, open as openDialog} from "@tauri-apps/plugin-dialog";
import {writeTextFile, readTextFile} from "@tauri-apps/plugin-fs";
import RallyMap from "./RallyMap.tsx";
import {useRally} from "@/lib/rally/useRally.ts";

const FILE_FILTERS = [{name: "Rally point file", extensions: ["json"]}];

interface RallyFile {
    version: 1;
    points: {lat: number; lon: number; alt: number}[];
}

async function exportRally(points: {lat: number; lon: number; alt: number}[]): Promise<void> {
    const path = await saveDialog({defaultPath: "rally.json", filters: FILE_FILTERS});
    if (!path) return;
    const payload: RallyFile = {version: 1, points};
    await writeTextFile(path, JSON.stringify(payload, null, 2));
}

async function importRally(): Promise<{lat: number; lon: number; alt: number}[] | null> {
    const path = await openDialog({multiple: false, filters: FILE_FILTERS});
    if (!path || Array.isArray(path)) return null;
    const text = await readTextFile(path);
    const data = JSON.parse(text) as Partial<RallyFile>;
    if (data.version !== 1 || !Array.isArray(data.points)) {
        throw new Error("That file isn't a recognized rally point file.");
    }
    return data.points;
}

function message(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

export default function RallyPage() {
    const rally = useRally();
    const [fileError, setFileError] = useState<string | null>(null);

    const canUpload = rally.points.length > 0 && !rally.uploading;

    const handleExport = async () => {
        setFileError(null);
        try {
            await exportRally(rally.points.map(({lat, lon, alt}) => ({lat, lon, alt})));
        } catch (e) {
            setFileError(message(e));
        }
    };

    const handleImport = async () => {
        setFileError(null);
        try {
            const imported = await importRally();
            if (!imported) return;
            rally.clear();
            for (const p of imported) {
                rally.addPoint(p.lat, p.lon);
            }
        } catch (e) {
            setFileError(message(e));
        }
    };

    return (
        <div className="flex h-full w-full">
            <div className="min-w-0 flex-1">
                <RallyMap rally={rally}/>
            </div>
            <div className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-border-subtle bg-layer-01">

                {/* Toolbar */}
                <div className="flex shrink-0 items-center gap-1 border-b border-border-subtle px-2 py-1.5">
                    <button
                        type="button"
                        onClick={() => void handleImport()}
                        className="flex items-center gap-1 px-2 py-1 text-label text-text-secondary hover:bg-layer-hover-01 hover:text-text-primary"
                    >
                        <DocumentImport size={16}/>
                        Import
                    </button>
                    <button
                        type="button"
                        disabled={rally.points.length === 0}
                        onClick={() => void handleExport()}
                        className="flex items-center gap-1 px-2 py-1 text-label text-text-secondary hover:enabled:bg-layer-hover-01 hover:enabled:text-text-primary disabled:text-text-disabled"
                    >
                        <DocumentExport size={16}/>
                        Export
                    </button>
                    <button
                        type="button"
                        disabled={rally.downloading}
                        onClick={() => void rally.download().catch(() => {})}
                        className="flex items-center gap-1 px-2 py-1 text-label text-text-secondary hover:enabled:bg-layer-hover-01 hover:enabled:text-text-primary disabled:text-text-disabled"
                    >
                        <DocumentDownload size={16}/>
                        {rally.downloading ? "Downloading…" : "From Vehicle"}
                    </button>
                </div>

                {/* Errors */}
                {(fileError || rally.uploadError || rally.downloadError) && (
                    <div className="shrink-0 border-b border-border-subtle bg-layer-02 px-3 py-1.5 text-label">
                        {fileError && <div className="text-state-danger">{fileError}</div>}
                        {rally.uploadError && <div className="text-state-danger">{rally.uploadError}</div>}
                        {rally.downloadError && <div className="text-state-danger">{rally.downloadError}</div>}
                    </div>
                )}

                <div className="border-b border-border-subtle px-2 py-1.5 text-micro text-text-helper">
                    Click the map to add a rally point — an alternate RTL
                    destination the vehicle picks over home when it's the
                    closer one. Drag a point to move it; click a selected
                    point again to remove it.
                </div>

                {/* Point list */}
                {rally.points.length === 0 ? (
                    <div className="border-b border-border-subtle px-2 py-2 text-micro text-text-disabled">
                        No rally points yet
                    </div>
                ) : (
                    <div className="border-b border-border-subtle">
                        {rally.points.map((p, i) => {
                            const isSelected = p.id === rally.selectedId;
                            return (
                                <div
                                    key={p.id}
                                    onClick={() => rally.selectPoint(p.id)}
                                    className={[
                                        "flex w-full items-center gap-2 border-b border-border-subtle-base px-2 py-1.5 text-left last:border-b-0",
                                        isSelected
                                            ? "bg-layer-selected-01 text-text-primary"
                                            : "text-text-secondary hover:bg-layer-hover-01",
                                    ].join(" ")}
                                >
                                    <span className="w-5 shrink-0 text-label text-text-helper">{i + 1}</span>
                                    <span className="flex-1 truncate font-mono text-micro">
                                        {p.lat.toFixed(6)}, {p.lon.toFixed(6)}
                                    </span>
                                    <input
                                        type="number"
                                        value={p.alt}
                                        step={5}
                                        onClick={(e) => e.stopPropagation()}
                                        onChange={(e) => rally.setAltitude(p.id, Number(e.target.value))}
                                        title="Altitude (m, relative to home)"
                                        className="h-control-sm w-16 border border-border-subtle bg-background px-1 text-right font-mono text-micro text-text-primary focus-visible:outline-none"
                                    />
                                    <span className="shrink-0 text-micro text-text-helper">m</span>
                                    <span
                                        role="button"
                                        title="Remove rally point"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            rally.removePoint(p.id);
                                        }}
                                        className="shrink-0 text-text-helper hover:text-state-danger"
                                    >
                                        <TrashCan size={14}/>
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                )}

                {/* Spacer */}
                <div className="min-h-0 flex-1"/>

                {/* Upload / Clear */}
                <div className="flex shrink-0 flex-col gap-2 border-t border-border-subtle p-3">
                    <button
                        type="button"
                        disabled={!canUpload}
                        onClick={() => void rally.upload().catch(() => {})}
                        className="flex h-control-sm w-full items-center justify-center gap-1.5 border border-border-subtle text-label text-text-primary hover:enabled:bg-layer-hover-01 disabled:text-text-disabled"
                    >
                        {rally.uploading ? (
                            "Uploading…"
                        ) : rally.uploaded ? (
                            <>
                                <CheckmarkFilled size={16} className="text-state-ok"/>
                                Uploaded
                            </>
                        ) : (
                            `Upload ${rally.points.length > 0 ? `${rally.points.length} Point${rally.points.length !== 1 ? "s" : ""}` : "Rally Points"} to Vehicle`
                        )}
                    </button>
                    <button
                        type="button"
                        disabled={rally.points.length === 0}
                        onClick={rally.clear}
                        className="h-control-sm w-full border border-border-subtle text-label text-text-secondary hover:enabled:bg-layer-hover-01 disabled:text-text-disabled"
                    >
                        Clear All
                    </button>
                </div>
            </div>
        </div>
    );
}
