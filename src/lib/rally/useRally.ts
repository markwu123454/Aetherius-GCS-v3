import {useCallback, useEffect, useRef, useState} from "react";
import type {RallyPointDraft} from "./rally.ts";
import {downloadRally, uploadRally} from "./rallyCommands.ts";

/** How long the upload button shows "Uploaded" before reverting — matches
 * `geofence/useFence.ts`. */
const UPLOAD_SUCCESS_DISPLAY_MS = 2000;

/** Default transit/loiter altitude for a point placed by clicking the map,
 * meters relative to home — a reasonable starting guess, always editable
 * afterward. */
const DEFAULT_ALT_M = 50;

export interface RallyApi {
    points: RallyPointDraft[];
    selectedId: number | null;
    /** Places a new point at the given position and selects it. */
    addPoint: (lat: number, lon: number) => void;
    removePoint: (pointId: number) => void;
    selectPoint: (pointId: number) => void;
    movePoint: (pointId: number, lat: number, lon: number) => void;
    setAltitude: (pointId: number, alt: number) => void;
    clear: () => void;
    upload: () => Promise<void>;
    uploading: boolean;
    uploaded: boolean;
    uploadError: string | null;
    download: () => Promise<void>;
    downloading: boolean;
    downloadError: string | null;
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

let nextId = 1;

export function useRally(): RallyApi {
    const [points, setPoints] = useState<RallyPointDraft[]>([]);
    const [selectedId, setSelectedId] = useState<number | null>(null);
    const [uploading, setUploading] = useState(false);
    const [uploaded, setUploaded] = useState(false);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const [downloading, setDownloading] = useState(false);
    const [downloadError, setDownloadError] = useState<string | null>(null);

    // Same reasoning as `useFence`'s `selectedIdRef`: `download` selects the
    // first loaded point immediately after replacing the whole list, in the
    // same tick — a plain state read there would still see the old value.
    const selectedIdRef = useRef<number | null>(null);
    const applySelectedId = useCallback((id: number | null) => {
        selectedIdRef.current = id;
        setSelectedId(id);
    }, []);

    useEffect(() => {
        if (uploaded) {
            const t = window.setTimeout(() => setUploaded(false), UPLOAD_SUCCESS_DISPLAY_MS);
            return () => window.clearTimeout(t);
        }
    }, [uploaded]);

    const addPoint = useCallback((lat: number, lon: number) => {
        const id = nextId++;
        setPoints((prev) => [...prev, {id, lat, lon, alt: DEFAULT_ALT_M}]);
        applySelectedId(id);
    }, [applySelectedId]);

    const removePoint = useCallback((pointId: number) => {
        setPoints((prev) => prev.filter((p) => p.id !== pointId));
        if (selectedIdRef.current === pointId) applySelectedId(null);
    }, [applySelectedId]);

    const selectPoint = useCallback((pointId: number) => {
        applySelectedId(pointId);
    }, [applySelectedId]);

    const movePoint = useCallback((pointId: number, lat: number, lon: number) => {
        setPoints((prev) => prev.map((p) => (p.id === pointId ? {...p, lat, lon} : p)));
    }, []);

    const setAltitude = useCallback((pointId: number, alt: number) => {
        setPoints((prev) => prev.map((p) => (p.id === pointId ? {...p, alt} : p)));
    }, []);

    const clear = useCallback(() => {
        setPoints([]);
        applySelectedId(null);
    }, [applySelectedId]);

    const upload = useCallback(async () => {
        if (points.length === 0) {
            setUploadError("Add at least one rally point before uploading.");
            return;
        }
        setUploading(true);
        setUploadError(null);
        setUploaded(false);
        try {
            await uploadRally(points.map(({lat, lon, alt}) => ({lat, lon, alt})));
            setUploaded(true);
        } catch (e) {
            setUploadError(message(e));
            throw e;
        } finally {
            setUploading(false);
        }
    }, [points]);

    const download = useCallback(async () => {
        setDownloading(true);
        setDownloadError(null);
        try {
            const result = await downloadRally();
            if (result.length === 0) {
                setDownloadError("No rally points stored on the vehicle.");
                return;
            }
            const loaded: RallyPointDraft[] = result.map((p) => ({id: nextId++, ...p}));
            setPoints(loaded);
            applySelectedId(loaded[0]?.id ?? null);
        } catch (e) {
            setDownloadError(message(e));
            throw e;
        } finally {
            setDownloading(false);
        }
    }, [applySelectedId]);

    return {
        points,
        selectedId,
        addPoint,
        removePoint,
        selectPoint,
        movePoint,
        setAltitude,
        clear,
        upload,
        uploading,
        uploaded,
        uploadError,
        download,
        downloading,
        downloadError,
    };
}
