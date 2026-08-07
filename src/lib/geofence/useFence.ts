import {useCallback, useState} from "react";
import type {FenceVertex} from "./fence.ts";
import {downloadFence, uploadFence} from "./fenceCommands.ts";

export interface FenceApi {
    vertices: FenceVertex[];
    addVertex: (lat: number, lon: number) => void;
    removeVertex: (id: number) => void;
    moveVertex: (id: number, lat: number, lon: number) => void;
    loadVertices: (verts: {lat: number; lon: number}[]) => void;
    clear: () => void;
    upload: () => Promise<void>;
    uploading: boolean;
    uploadError: string | null;
    download: () => Promise<void>;
    downloading: boolean;
    downloadError: string | null;
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

let nextId = 1;

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

    const upload = useCallback(async () => {
        if (vertices.length < 3) {
            setUploadError("A polygon fence needs at least 3 vertices.");
            return;
        }
        setUploading(true);
        setUploadError(null);
        try {
            await uploadFence(vertices.map(({lat, lon}) => ({lat, lon})));
        } catch (e) {
            setUploadError(message(e));
            throw e;
        } finally {
            setUploading(false);
        }
    }, [vertices]);

    const download = useCallback(async () => {
        setDownloading(true);
        setDownloadError(null);
        try {
            const result = await downloadFence();
            if (result.vertices.length === 0) {
                setDownloadError("No fence stored on the vehicle.");
                return;
            }
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
