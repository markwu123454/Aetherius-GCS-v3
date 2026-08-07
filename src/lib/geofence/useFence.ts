import {useCallback, useState} from "react";
import type {FenceVertex} from "./fence.ts";
import {downloadFence, uploadFence} from "./fenceCommands.ts";
import type {LiveParamEntry} from "@/lib/params/liveParams.ts";

export interface FenceApi {
    vertices: FenceVertex[];
    addVertex: (lat: number, lon: number) => void;
    removeVertex: (id: number) => void;
    moveVertex: (id: number, lat: number, lon: number) => void;
    loadVertices: (verts: {lat: number; lon: number}[]) => void;
    clear: () => void;
    upload: (onSet: (name: string, value: number) => Promise<number>) => Promise<void>;
    uploading: boolean;
    uploadError: string | null;
    download: (live: Map<string, LiveParamEntry>) => Promise<void>;
    downloading: boolean;
    downloadError: string | null;
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

let nextId = 1;

/** Arithmetic centroid of a set of lat/lon points. */
function centroid(points: {lat: number; lon: number}[]): {lat: number; lon: number} {
    const lat = points.reduce((s, p) => s + p.lat, 0) / points.length;
    const lon = points.reduce((s, p) => s + p.lon, 0) / points.length;
    return {lat, lon};
}

export function useFence(): FenceApi {
    const [vertices, setVertices] = useState<FenceVertex[]>([]);
    const [uploading, setUploading] = useState(false);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const [downloading, setDownloading] = useState(false);
    const [downloadError, setDownloadError] = useState<string | null>(null);

    const addVertex = useCallback((lat: number, lon: number) => {
        setVertices((prev) => [...prev, {id: nextId++, lat, lon}]);
    }, []);

    const removeVertex = useCallback((id: number) => {
        setVertices((prev) => prev.filter((v) => v.id !== id));
    }, []);

    const moveVertex = useCallback((id: number, lat: number, lon: number) => {
        setVertices((prev) => prev.map((v) => (v.id === id ? {...v, lat, lon} : v)));
    }, []);

    const loadVertices = useCallback((verts: {lat: number; lon: number}[]) => {
        setVertices(verts.map((v) => ({...v, id: nextId++})));
    }, []);

    const clear = useCallback(() => setVertices([]), []);

    const upload = useCallback(
        async (onSet: (name: string, value: number) => Promise<number>) => {
            if (vertices.length < 3) {
                setUploadError("A polygon fence needs at least 3 vertices.");
                return;
            }
            setUploading(true);
            setUploadError(null);
            try {
                // Set FENCE_TOTAL = N + 1 (1 return point + N polygon vertices).
                const total = vertices.length + 1;
                await onSet("FENCE_TOTAL", total);
                // Upload return point (centroid) + polygon vertices.
                const center = centroid(vertices);
                await uploadFence([center, ...vertices.map(({lat, lon}) => ({lat, lon}))]);
            } catch (e) {
                setUploadError(message(e));
                throw e;
            } finally {
                setUploading(false);
            }
        },
        [vertices],
    );

    const download = useCallback(async (live: Map<string, LiveParamEntry>) => {
        const totalEntry = live.get("FENCE_TOTAL");
        const total = totalEntry ? Math.round(totalEntry.value) : 0;
        if (total < 2) {
            setDownloadError("No fence stored on the vehicle (FENCE_TOTAL < 2).");
            return;
        }
        setDownloading(true);
        setDownloadError(null);
        try {
            const result = await downloadFence(total);
            loadVertices(result.vertices);
        } catch (e) {
            setDownloadError(message(e));
            throw e;
        } finally {
            setDownloading(false);
        }
    }, [loadVertices]);

    return {
        vertices,
        addVertex,
        removeVertex,
        moveVertex,
        loadVertices,
        clear,
        upload,
        uploading,
        uploadError,
        download,
        downloading,
        downloadError,
    };
}
