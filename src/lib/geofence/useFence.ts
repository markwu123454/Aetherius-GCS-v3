import {useCallback, useEffect, useRef, useState} from "react";
import type {FenceCircle, FencePolygon, FenceVertex} from "./fence.ts";
import {destinationPoint, distanceMeters} from "./fence.ts";
import {downloadFence, uploadFence} from "./fenceCommands.ts";

/** How long the upload button shows "Uploaded" before reverting. */
const UPLOAD_SUCCESS_DISPLAY_MS = 2000;

export interface FenceApi {
    polygons: FencePolygon[];
    selectedId: number | null;
    addPolygon: () => void;
    removePolygon: (polygonId: number) => void;
    selectPolygon: (polygonId: number) => void;
    addVertex: (lat: number, lon: number) => void;
    removeVertex: (vertexId: number) => void;
    moveVertex: (vertexId: number, lat: number, lon: number) => void;
    circles: FenceCircle[];
    selectedCircleId: number | null;
    addCircle: () => void;
    removeCircle: (circleId: number) => void;
    selectCircle: (circleId: number) => void;
    /** Routes a map click to whichever placement step the selected circle is waiting on. */
    placeCircle: (lat: number, lon: number) => void;
    /** Moves the whole circle (center + edge, so its radius/bearing is preserved). */
    moveCircleCenter: (circleId: number, lat: number, lon: number) => void;
    /** Moves just the edge point — sets it exactly wherever it's dragged to. */
    moveCircleEdge: (circleId: number, lat: number, lon: number) => void;
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

export function useFence(): FenceApi {
    const [polygons, setPolygons] = useState<FencePolygon[]>([]);
    const [selectedId, setSelectedId] = useState<number | null>(null);
    const [circles, setCircles] = useState<FenceCircle[]>([]);
    const [selectedCircleId, setSelectedCircleId] = useState<number | null>(null);
    const [uploading, setUploading] = useState(false);
    const [uploaded, setUploaded] = useState(false);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const [downloading, setDownloading] = useState(false);
    const [downloadError, setDownloadError] = useState<string | null>(null);

    // Mirrors of selectedId/selectedCircleId, updated synchronously (unlike
    // the state itself, which only takes effect on the next render). Callers
    // that select a shape and immediately act on it in the same tick — e.g.
    // import, which does addPolygon() then addVertex() in a loop before
    // React ever re-renders — need the *just-selected* id right now, not
    // whatever was selected when this render's closures were created.
    const selectedIdRef = useRef<number | null>(null);
    const selectedCircleIdRef = useRef<number | null>(null);

    const applySelectedId = useCallback((id: number | null) => {
        selectedIdRef.current = id;
        setSelectedId(id);
    }, []);

    const applySelectedCircleId = useCallback((id: number | null) => {
        selectedCircleIdRef.current = id;
        setSelectedCircleId(id);
    }, []);

    useEffect(() => {
        if (uploaded) {
            const t = window.setTimeout(() => setUploaded(false), UPLOAD_SUCCESS_DISPLAY_MS);
            return () => window.clearTimeout(t);
        }
    }, [uploaded]);

    const addPolygon = useCallback(() => {
        const id = nextId++;
        setPolygons((prev) => [...prev, {id, vertices: []}]);
        applySelectedId(id);
        applySelectedCircleId(null);
    }, [applySelectedId, applySelectedCircleId]);

    const removePolygon = useCallback((polygonId: number) => {
        setPolygons((prev) => prev.filter((p) => p.id !== polygonId));
        if (selectedIdRef.current === polygonId) applySelectedId(null);
    }, [applySelectedId]);

    const selectPolygon = useCallback((polygonId: number) => {
        applySelectedId(polygonId);
        applySelectedCircleId(null);
    }, [applySelectedId, applySelectedCircleId]);

    const addVertex = useCallback((lat: number, lon: number) => {
        const vertex: FenceVertex = {id: nextId++, lat, lon};
        const targetId = selectedIdRef.current;
        setPolygons((prev) => {
            const sel = prev.find((p) => p.id === targetId);
            if (!sel) return prev;
            return prev.map((p) =>
                p.id === targetId ? {...p, vertices: [...p.vertices, vertex]} : p,
            );
        });
    }, []);

    const removeVertex = useCallback((vertexId: number) => {
        setPolygons((prev) =>
            prev.map((p) => ({...p, vertices: p.vertices.filter((v) => v.id !== vertexId)})),
        );
    }, []);

    const moveVertex = useCallback((vertexId: number, lat: number, lon: number) => {
        setPolygons((prev) =>
            prev.map((p) => ({
                ...p,
                vertices: p.vertices.map((v) => (v.id === vertexId ? {...v, lat, lon} : v)),
            })),
        );
    }, []);

    const addCircle = useCallback(() => {
        const id = nextId++;
        setCircles((prev) => [...prev, {id, center: null, edge: null}]);
        applySelectedCircleId(id);
        applySelectedId(null);
    }, [applySelectedId, applySelectedCircleId]);

    const removeCircle = useCallback((circleId: number) => {
        setCircles((prev) => prev.filter((c) => c.id !== circleId));
        if (selectedCircleIdRef.current === circleId) applySelectedCircleId(null);
    }, [applySelectedCircleId]);

    const selectCircle = useCallback((circleId: number) => {
        applySelectedCircleId(circleId);
        applySelectedId(null);
    }, [applySelectedId, applySelectedCircleId]);

    // First click after selecting a circle sets its center; the second sets
    // its edge point — exactly where clicked, at whatever bearing. Clicks
    // after that are no-ops here — a placed circle is only edited by
    // dragging its markers.
    const placeCircle = useCallback((lat: number, lon: number) => {
        const targetId = selectedCircleIdRef.current;
        setCircles((prev) => {
            const sel = prev.find((c) => c.id === targetId);
            if (!sel) return prev;
            if (sel.center === null) {
                return prev.map((c) => (c.id === targetId ? {...c, center: {lat, lon}} : c));
            }
            if (sel.edge === null) {
                return prev.map((c) => (c.id === targetId ? {...c, edge: {lat, lon}} : c));
            }
            return prev;
        });
    }, []);

    const moveCircleCenter = useCallback((circleId: number, lat: number, lon: number) => {
        setCircles((prev) =>
            prev.map((c) => {
                if (c.id !== circleId || !c.center) return c;
                // Translate the edge point by the same delta so the radius
                // and bearing are preserved — dragging the center relocates
                // the whole circle instead of reshaping it.
                const edge = c.edge
                    ? {lat: c.edge.lat + (lat - c.center.lat), lon: c.edge.lon + (lon - c.center.lon)}
                    : null;
                return {...c, center: {lat, lon}, edge};
            }),
        );
    }, []);

    const moveCircleEdge = useCallback((circleId: number, lat: number, lon: number) => {
        setCircles((prev) =>
            prev.map((c) => (c.id === circleId ? {...c, edge: {lat, lon}} : c)),
        );
    }, []);

    const clear = useCallback(() => {
        setPolygons([]);
        setCircles([]);
        applySelectedId(null);
        applySelectedCircleId(null);
    }, [applySelectedId, applySelectedCircleId]);

    const upload = useCallback(async () => {
        const invalidPolygons = polygons.filter((p) => p.vertices.length < 3);
        const incompleteCircles = circles.filter((c) => c.center === null || c.edge === null);
        if (polygons.length === 0 && circles.length === 0) {
            setUploadError("Add at least one polygon or circle before uploading.");
            return;
        }
        if (invalidPolygons.length > 0) {
            setUploadError(
                `${invalidPolygons.length} polygon(s) have fewer than 3 vertices — fix or remove them first.`,
            );
            return;
        }
        if (incompleteCircles.length > 0) {
            setUploadError(
                `${incompleteCircles.length} circle(s) aren't fully placed yet — click the map to set their center and edge.`,
            );
            return;
        }
        setUploading(true);
        setUploadError(null);
        setUploaded(false);
        try {
            await uploadFence(
                polygons.map((p) => p.vertices.map(({lat, lon}) => ({lat, lon}))),
                circles.map((c) => ({
                    center: c.center!,
                    radiusM: Math.max(1, Math.round(distanceMeters(c.center!, c.edge!))),
                })),
            );
            setUploaded(true);
        } catch (e) {
            setUploadError(message(e));
            throw e;
        } finally {
            setUploading(false);
        }
    }, [polygons, circles]);

    const download = useCallback(async () => {
        setDownloading(true);
        setDownloadError(null);
        try {
            const result = await downloadFence();
            if (result.polygons.length === 0 && result.circles.length === 0) {
                setDownloadError("No fence stored on the vehicle.");
                return;
            }
            const loadedPolygons: FencePolygon[] = result.polygons.map((p) => ({
                id: nextId++,
                vertices: p.vertices.map((v) => ({id: nextId++, ...v})),
            }));
            const loadedCircles: FenceCircle[] = result.circles.map((c) => ({
                id: nextId++,
                center: c.center,
                // The vehicle only stores center + radius, not a specific
                // edge bearing — synthesize one due north. Draggable
                // afterward like any other edge point.
                edge: destinationPoint(c.center, 0, c.radiusM),
            }));
            setPolygons(loadedPolygons);
            setCircles(loadedCircles);
            applySelectedId(loadedPolygons[0]?.id ?? null);
            applySelectedCircleId(loadedPolygons.length === 0 ? loadedCircles[0]?.id ?? null : null);
        } catch (e) {
            setDownloadError(message(e));
            throw e;
        } finally {
            setDownloading(false);
        }
    }, [applySelectedId, applySelectedCircleId]);

    return {
        polygons,
        selectedId,
        addPolygon,
        removePolygon,
        selectPolygon,
        addVertex,
        removeVertex,
        moveVertex,
        circles,
        selectedCircleId,
        addCircle,
        removeCircle,
        selectCircle,
        placeCircle,
        moveCircleCenter,
        moveCircleEdge,
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
