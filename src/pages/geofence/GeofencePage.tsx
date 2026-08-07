import {useEffect, useState} from "react";
import {DocumentDownload, DocumentExport, DocumentImport} from "@carbon/icons-react";
import {save as saveDialog, open as openDialog} from "@tauri-apps/plugin-dialog";
import {writeTextFile, readTextFile} from "@tauri-apps/plugin-fs";
import GeofenceMap from "./GeofenceMap.tsx";
import {useFence} from "@/lib/geofence/useFence.ts";
import {useLiveParams} from "@/lib/params/useLiveParams.ts";
import {useVehicle} from "@/lib/vehicle/useVehicle.ts";
import type {LiveParamEntry} from "@/lib/params/liveParams.ts";
import type {FenceVertex} from "@/lib/geofence/fence.ts";

const FILE_FILTERS = [{name: "Geofence file", extensions: ["json"]}];

interface FenceFile {
    version: 1;
    vertices: {lat: number; lon: number}[];
}

async function exportFence(vertices: {lat: number; lon: number}[]): Promise<void> {
    const path = await saveDialog({defaultPath: "geofence.json", filters: FILE_FILTERS});
    if (!path) return;
    const payload: FenceFile = {version: 1, vertices};
    await writeTextFile(path, JSON.stringify(payload, null, 2));
}

async function importFence(): Promise<{lat: number; lon: number}[] | null> {
    const path = await openDialog({multiple: false, filters: FILE_FILTERS});
    if (!path || Array.isArray(path)) return null;
    const text = await readTextFile(path);
    const data = JSON.parse(text) as Partial<FenceFile>;
    if (data.version !== 1 || !Array.isArray(data.vertices)) {
        throw new Error("That file isn't a recognized geofence file.");
    }
    return data.vertices;
}

function message(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

// ── Self-intersection check ────────────────────────────────────────────────

function cross(o: {lat: number; lon: number}, a: {lat: number; lon: number}, b: {lat: number; lon: number}): number {
    return (a.lon - o.lon) * (b.lat - o.lat) - (a.lat - o.lat) * (b.lon - o.lon);
}

function segmentsIntersect(
    p1: {lat: number; lon: number},
    p2: {lat: number; lon: number},
    p3: {lat: number; lon: number},
    p4: {lat: number; lon: number},
): boolean {
    const d1 = cross(p3, p4, p1);
    const d2 = cross(p3, p4, p2);
    const d3 = cross(p1, p2, p3);
    const d4 = cross(p1, p2, p4);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
        return true;
    }
    return false;
}

function isSelfIntersecting(vertices: FenceVertex[]): boolean {
    const n = vertices.length;
    if (n < 4) return false;
    for (let i = 0; i < n; i++) {
        const p1 = vertices[i]!;
        const p2 = vertices[(i + 1) % n]!;
        for (let j = i + 2; j < n; j++) {
            if (i === 0 && j === n - 1) continue; // adjacent (shares vertex 0)
            const p3 = vertices[j]!;
            const p4 = vertices[(j + 1) % n]!;
            if (segmentsIntersect(p1, p2, p3, p4)) return true;
        }
    }
    return false;
}

// ── Param row components ───────────────────────────────────────────────────

interface SelectRowProps {
    label: string;
    description: string;
    param: string;
    options: {value: number; label: string}[];
    live: Map<string, LiveParamEntry>;
    onSet: (name: string, value: number) => Promise<number>;
}

function SelectRow({label, description, param, options, live, onSet}: SelectRowProps) {
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [ok, setOk] = useState(false);
    const entry = live.get(param);
    const value = entry !== undefined ? Math.round(entry.value) : undefined;

    useEffect(() => {
        if (ok) {
            const t = window.setTimeout(() => setOk(false), 1500);
            return () => window.clearTimeout(t);
        }
    }, [ok]);

    const handleChange = async (next: number) => {
        setPending(true);
        setError(null);
        setOk(false);
        try {
            await onSet(param, next);
            setOk(true);
        } catch (e) {
            setError(message(e));
        } finally {
            setPending(false);
        }
    };

    return (
        <div className="border-b border-border-subtle-base px-2 py-1.5 last:border-b-0">
            <div className="mb-1 flex items-center gap-2">
                <span className="flex-1 text-label text-text-primary">{label}</span>
                {pending && <span className="text-micro text-text-helper">…</span>}
                {ok && <span className="text-micro text-state-ok">Set</span>}
                {error && <span className="max-w-24 truncate text-micro text-state-danger" title={error}>{error}</span>}
            </div>
            <div className="text-micro text-text-helper mb-1">{description}</div>
            <select
                disabled={pending || value === undefined}
                value={value ?? ""}
                onChange={(e) => void handleChange(Number(e.target.value))}
                className="h-control-sm w-full border border-border-subtle bg-background px-1.5 text-label text-text-primary disabled:text-text-disabled"
            >
                {value === undefined && <option value="">—</option>}
                {options.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
            </select>
        </div>
    );
}

interface NumberRowProps {
    label: string;
    description: string;
    param: string;
    unit: string;
    min: number;
    max: number;
    step: number;
    decimals: number;
    live: Map<string, LiveParamEntry>;
    onSet: (name: string, value: number) => Promise<number>;
}

function NumberRow({label, description, param, unit, min, max, step, decimals, live, onSet}: NumberRowProps) {
    const entry = live.get(param);
    const liveValue = entry?.value;
    const [draft, setDraft] = useState(liveValue !== undefined ? liveValue.toFixed(decimals) : "");
    const [editing, setEditing] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [ok, setOk] = useState(false);

    useEffect(() => {
        if (!editing) setDraft(liveValue !== undefined ? liveValue.toFixed(decimals) : "");
    }, [liveValue, editing, decimals]);

    useEffect(() => {
        if (ok) {
            const t = window.setTimeout(() => setOk(false), 1500);
            return () => window.clearTimeout(t);
        }
    }, [ok]);

    const commit = async () => {
        setEditing(false);
        const num = Number(draft.trim());
        if (!draft.trim() || Number.isNaN(num) || num === liveValue) return;
        setPending(true);
        setError(null);
        setOk(false);
        try {
            await onSet(param, num);
            setOk(true);
        } catch (e) {
            setError(message(e));
        } finally {
            setPending(false);
        }
    };

    return (
        <div className="border-b border-border-subtle-base px-2 py-1.5 last:border-b-0">
            <div className="mb-1 flex items-center gap-2">
                <span className="flex-1 text-label text-text-primary">{label}</span>
                {pending && <span className="text-micro text-text-helper">…</span>}
                {ok && <span className="text-micro text-state-ok">Set</span>}
                {error && <span className="max-w-24 truncate text-micro text-state-danger" title={error}>{error}</span>}
            </div>
            <div className="text-micro text-text-helper mb-1">{description}</div>
            <div className="flex items-center gap-1.5">
                <input
                    type="number"
                    value={draft}
                    disabled={pending}
                    step={step}
                    min={min}
                    max={max}
                    placeholder={liveValue === undefined ? "—" : undefined}
                    onFocus={() => setEditing(true)}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => void commit()}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
                    }}
                    className="h-control-sm w-20 border border-border-subtle bg-background px-1.5 font-mono text-label text-text-primary placeholder:text-text-disabled focus-visible:outline-none disabled:text-text-disabled"
                />
                <span className="text-label text-text-helper">{unit}</span>
            </div>
        </div>
    );
}

function SectionHeader({title}: {title: string}) {
    return <div className="border-b border-border-subtle px-2 py-1 text-micro uppercase text-text-helper">{title}</div>;
}

// ── Fence type options ─────────────────────────────────────────────────────

const FENCE_ENABLE_OPTIONS = [
    {value: 0, label: "Disabled"},
    {value: 1, label: "Altitude"},
    {value: 2, label: "Circle"},
    {value: 3, label: "Altitude + Circle"},
    {value: 4, label: "Polygon"},
    {value: 5, label: "Circle + Polygon"},
    {value: 6, label: "Altitude + Polygon"},
    {value: 7, label: "All"},
];

const FENCE_ACTION_COPTER = [
    {value: 0, label: "Disable fence on breach"},
    {value: 1, label: "RTL"},
    {value: 2, label: "Land"},
    {value: 3, label: "SmartRTL"},
    {value: 4, label: "Brake"},
    {value: 5, label: "SmartRTL or RTL"},
];

const FENCE_ACTION_PLANE = [
    {value: 0, label: "RTL"},
    {value: 1, label: "Report only"},
    {value: 2, label: "GUIDED"},
];

// ── Page ──────────────────────────────────────────────────────────────────

export default function GeofencePage() {
    const fence = useFence();
    const live = useLiveParams();
    const vehicle = useVehicle();
    const isCopter = vehicle.vehicleKind !== "plane";
    const fenceActionOptions = isCopter ? FENCE_ACTION_COPTER : FENCE_ACTION_PLANE;

    const [fileError, setFileError] = useState<string | null>(null);

    const selfIntersecting = isSelfIntersecting(fence.vertices);

    const handleExport = async () => {
        setFileError(null);
        try {
            await exportFence(fence.vertices.map(({lat, lon}) => ({lat, lon})));
        } catch (e) {
            setFileError(message(e));
        }
    };

    const handleImport = async () => {
        setFileError(null);
        try {
            const verts = await importFence();
            if (verts) fence.loadVertices(verts);
        } catch (e) {
            setFileError(message(e));
        }
    };

    const handleDownload = async () => {
        setFileError(null);
        try {
            await fence.download();
        } catch {
            // downloadError set inside useFence
        }
    };

    const handleUpload = async () => {
        setFileError(null);
        try {
            await fence.upload();
        } catch {
            // uploadError set inside useFence
        }
    };

    const canUpload = fence.vertices.length >= 3 && !fence.uploading && !selfIntersecting;

    return (
        <div className="flex h-full w-full">
            <div className="min-w-0 flex-1">
                <GeofenceMap fence={fence} selfIntersecting={selfIntersecting}/>
            </div>
            <div className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-border-subtle bg-layer-01">
                {/* Toolbar */}
                <div className="flex shrink-0 items-center gap-1 border-b border-border-subtle px-2 py-1.5">
                    <button
                        type="button"
                        title="Import from a geofence file"
                        onClick={() => void handleImport()}
                        className="flex items-center gap-1 px-2 py-1 text-label text-text-secondary hover:bg-layer-hover-01 hover:text-text-primary"
                    >
                        <DocumentImport size={16}/>
                        Import
                    </button>
                    <button
                        type="button"
                        title="Export to a geofence file"
                        disabled={fence.vertices.length === 0}
                        onClick={() => void handleExport()}
                        className="flex items-center gap-1 px-2 py-1 text-label text-text-secondary hover:enabled:bg-layer-hover-01 hover:enabled:text-text-primary disabled:text-text-disabled"
                    >
                        <DocumentExport size={16}/>
                        Export
                    </button>
                    <button
                        type="button"
                        title="Download the fence stored on the vehicle"
                        disabled={fence.downloading}
                        onClick={() => void handleDownload()}
                        className="flex items-center gap-1 px-2 py-1 text-label text-text-secondary hover:enabled:bg-layer-hover-01 hover:enabled:text-text-primary disabled:text-text-disabled"
                    >
                        <DocumentDownload size={16}/>
                        {fence.downloading ? "Downloading…" : "From Vehicle"}
                    </button>
                </div>

                {/* Errors */}
                {(fileError || fence.uploadError || fence.downloadError) && (
                    <div className="shrink-0 border-b border-border-subtle bg-layer-02 px-3 py-1.5 text-label">
                        {fileError && <div className="text-state-danger">{fileError}</div>}
                        {fence.uploadError && <div className="text-state-danger">{fence.uploadError}</div>}
                        {fence.downloadError && <div className="text-state-danger">{fence.downloadError}</div>}
                    </div>
                )}

                {/* General */}
                <SectionHeader title="General"/>
                <SelectRow
                    label="Active fence type"
                    description="Which fence type(s) are enforced"
                    param="FENCE_ENABLE"
                    options={FENCE_ENABLE_OPTIONS}
                    live={live.values}
                    onSet={live.setParam}
                />
                <SelectRow
                    label="Breach action"
                    description="What the vehicle does when a fence is breached"
                    param="FENCE_ACTION"
                    options={fenceActionOptions}
                    live={live.values}
                    onSet={live.setParam}
                />

                {/* Altitude */}
                <SectionHeader title="Altitude fence"/>
                <NumberRow
                    label="Max altitude"
                    description="Vehicle will not climb above this"
                    param="FENCE_ALT_MAX"
                    unit="m"
                    min={10}
                    max={32767}
                    step={5}
                    decimals={0}
                    live={live.values}
                    onSet={live.setParam}
                />
                <NumberRow
                    label="Min altitude"
                    description="Vehicle will not descend below this (0 = disabled)"
                    param="FENCE_ALT_MIN"
                    unit="m"
                    min={0}
                    max={32767}
                    step={1}
                    decimals={0}
                    live={live.values}
                    onSet={live.setParam}
                />

                {/* Circle */}
                <SectionHeader title="Circle fence"/>
                <NumberRow
                    label="Radius"
                    description="Maximum distance from home"
                    param="FENCE_RADIUS"
                    unit="m"
                    min={30}
                    max={10000}
                    step={10}
                    decimals={0}
                    live={live.values}
                    onSet={live.setParam}
                />
                <NumberRow
                    label="Margin"
                    description="How far inside the fence boundary the breach triggers"
                    param="FENCE_MARGIN"
                    unit="m"
                    min={1}
                    max={10}
                    step={0.5}
                    decimals={1}
                    live={live.values}
                    onSet={live.setParam}
                />

                {/* Polygon */}
                <SectionHeader title="Polygon fence"/>
                <div className="border-b border-border-subtle px-2 py-1.5 text-micro text-text-helper">
                    Click the map to add vertices. Click a vertex to remove it. Drag to move.
                    Only one inclusion polygon supported.
                </div>

                {/* Spacer */}
                <div className="min-h-0 flex-1"/>

                {/* Stats + actions */}
                <div className="shrink-0 border-t border-border-subtle px-3 py-2 text-micro text-text-helper">
                    {fence.vertices.length} vertex{fence.vertices.length !== 1 ? "es" : ""}
                    {fence.vertices.length > 0 && fence.vertices.length < 3 && (
                        <span className="ml-2 text-state-warn">need ≥ 3</span>
                    )}
                    {selfIntersecting && (
                        <span className="ml-2 text-state-danger">polygon self-intersects</span>
                    )}
                </div>
                <div className="flex shrink-0 flex-col gap-2 border-t border-border-subtle p-3">
                    <button
                        type="button"
                        disabled={!canUpload}
                        onClick={() => void handleUpload()}
                        title={selfIntersecting ? "Polygon edges cross — fix before uploading" : undefined}
                        className="h-control-sm w-full border border-border-subtle text-label text-text-primary hover:enabled:bg-layer-hover-01 disabled:text-text-disabled"
                    >
                        {fence.uploading ? "Uploading…" : "Upload Polygon to Vehicle"}
                    </button>
                    <button
                        type="button"
                        disabled={fence.vertices.length === 0}
                        onClick={fence.clear}
                        className="h-control-sm w-full border border-border-subtle text-label text-text-secondary hover:enabled:bg-layer-hover-01 disabled:text-text-disabled"
                    >
                        Clear Polygon
                    </button>
                </div>
            </div>
        </div>
    );
}
