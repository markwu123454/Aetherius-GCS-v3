import {useEffect, useRef} from "react";
import {GeoJSONSource, LngLatLike, MapMouseEvent, Marker} from "maplibre-gl";
import {useBaseMap} from "@/lib/map/useBaseMap.ts";
import {resolveToken} from "@/lib/airspace/airspace.ts";
import {useVehicle} from "@/lib/vehicle/useVehicle.ts";
import type {FenceApi} from "@/lib/geofence/useFence.ts";
import type {FenceCircle, FencePolygon} from "@/lib/geofence/fence.ts";
import {circleRingCoords, distanceMeters} from "@/lib/geofence/fence.ts";

const SHAPE_SOURCE = "fence-shapes";
const FILL_LAYER = "fence-fill";
const OUTLINE_LAYER = "fence-outline";
const VEHICLE_ZOOM = 15;

// ── Real-time intersection check (works on [lon, lat] pairs) ──────────────

function cross2d(
    o: [number, number], a: [number, number], b: [number, number],
): number {
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function segmentsIntersect(
    p1: [number, number], p2: [number, number],
    p3: [number, number], p4: [number, number],
): boolean {
    const d1 = cross2d(p3, p4, p1);
    const d2 = cross2d(p3, p4, p2);
    const d3 = cross2d(p1, p2, p3);
    const d4 = cross2d(p1, p2, p4);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))
        && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function isSelfIntersectingCoords(coords: [number, number][]): boolean {
    const n = coords.length;
    if (n < 4) return false;
    for (let i = 0; i < n; i++) {
        const p1 = coords[i]!;
        const p2 = coords[(i + 1) % n]!;
        for (let j = i + 2; j < n; j++) {
            if (i === 0 && j === n - 1) continue;
            const p3 = coords[j]!;
            const p4 = coords[(j + 1) % n]!;
            if (segmentsIntersect(p1, p2, p3, p4)) return true;
        }
    }
    return false;
}

// ── GeoJSON helpers ────────────────────────────────────────────────────────

function polygonFeature(
    polygon: FencePolygon,
    isSelected: boolean,
    isSelfIntersecting: boolean,
): GeoJSON.Feature {
    const coords: [number, number][] = polygon.vertices.map((v) => [v.lon, v.lat]);
    const ring = coords.length >= 3 ? [...coords, coords[0]!] : coords;
    return {
        type: "Feature",
        properties: {selected: isSelected, selfIntersecting: isSelfIntersecting},
        geometry:
            coords.length >= 3
                ? {type: "Polygon", coordinates: [ring]}
                : {type: "LineString", coordinates: ring},
    };
}

/** `null` while the circle is still being placed — nothing to draw as a shape yet. */
function circleFeature(
    circle: {center: {lat: number; lon: number} | null; edge: {lat: number; lon: number} | null},
    isSelected: boolean,
): GeoJSON.Feature | null {
    if (!circle.center || !circle.edge) return null;
    const radiusM = distanceMeters(circle.center, circle.edge);
    if (radiusM <= 0) return null;
    return {
        type: "Feature",
        properties: {selected: isSelected, selfIntersecting: false},
        geometry: {type: "Polygon", coordinates: [circleRingCoords(circle.center, radiusM)]},
    };
}

function buildFeatureCollection(
    polygons: FencePolygon[],
    selectedId: number | null,
    selfIntersectingIds: Set<number>,
    circles: FenceCircle[],
    selectedCircleId: number | null,
): GeoJSON.FeatureCollection {
    const features: GeoJSON.Feature[] = polygons.map((p) =>
        polygonFeature(p, p.id === selectedId, selfIntersectingIds.has(p.id)),
    );
    for (const c of circles) {
        const feature = circleFeature(c, c.id === selectedCircleId);
        if (feature) features.push(feature);
    }
    return {type: "FeatureCollection", features};
}

// ── Component ─────────────────────────────────────────────────────────────

interface GeofenceMapProps {
    fence: FenceApi;
    selfIntersectingIds: Set<number>;
}

export default function GeofenceMap({fence, selfIntersectingIds}: GeofenceMapProps) {
    const {containerRef, mapRef, styleReady} = useBaseMap();
    // vertexId → { marker, polygonId }
    const markersRef = useRef<Map<number, {marker: Marker; polygonId: number}>>(new Map());
    // circleId → marker, kept in two maps since a circle has up to two handles
    const circleCenterMarkersRef = useRef<Map<number, Marker>>(new Map());
    const circleEdgeMarkersRef = useRef<Map<number, Marker>>(new Map());
    const vehicleMarkerRef = useRef<Marker | null>(null);
    const hasCenteredRef = useRef(false);
    const vehicle = useVehicle();

    const fenceRef = useRef(fence);
    useEffect(() => { fenceRef.current = fence; }, [fence]);

    const selfIntersectingRef = useRef(selfIntersectingIds);
    useEffect(() => { selfIntersectingRef.current = selfIntersectingIds; }, [selfIntersectingIds]);

    // Click on empty map → add vertex to selected polygon, or place the
    // selected circle's center/edge (whichever it's still waiting on).
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        const onClick = (event: MapMouseEvent) => {
            const current = fenceRef.current;
            if (current.selectedCircleId !== null) {
                current.placeCircle(event.lngLat.lat, event.lngLat.lng);
                return;
            }
            if (current.selectedId !== null) {
                current.addVertex(event.lngLat.lat, event.lngLat.lng);
            }
        };
        map.on("click", onClick);
        return () => { map.off("click", onClick); };
    }, [mapRef]);

    // Add source + layers once style is ready.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !styleReady) return;
        if (map.getSource(SHAPE_SOURCE)) return;

        const yellow = resolveToken("--color-yellow-30");
        const red = resolveToken("--color-red-50");

        map.addSource(SHAPE_SOURCE, {
            type: "geojson",
            data: {type: "FeatureCollection", features: []},
        });
        map.addLayer({
            id: FILL_LAYER,
            type: "fill",
            source: SHAPE_SOURCE,
            paint: {
                "fill-color": ["case", ["get", "selfIntersecting"], red, yellow],
                "fill-opacity": ["case", ["get", "selected"], 0.2, 0.08],
            },
        });
        map.addLayer({
            id: OUTLINE_LAYER,
            type: "line",
            source: SHAPE_SOURCE,
            paint: {
                "line-color": ["case", ["get", "selfIntersecting"], red, yellow],
                "line-width": ["case", ["get", "selected"], 2.5, 1.5],
            },
        });
    }, [styleReady, mapRef]);

    // Keep the FeatureCollection in sync with React state.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !styleReady) return;
        const source = map.getSource(SHAPE_SOURCE) as GeoJSONSource | undefined;
        if (!source) return;
        source.setData(
            buildFeatureCollection(
                fence.polygons, fence.selectedId, selfIntersectingIds,
                fence.circles, fence.selectedCircleId,
            ),
        );
    }, [
        mapRef, styleReady, fence.polygons, fence.selectedId, selfIntersectingIds,
        fence.circles, fence.selectedCircleId,
    ]);

    // Reconcile vertex markers.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !styleReady) return;

        const markers = markersRef.current;
        const seen = new Set<number>();

        for (const polygon of fence.polygons) {
            for (const vertex of polygon.vertices) {
                seen.add(vertex.id);
                const lngLat: LngLatLike = [vertex.lon, vertex.lat];

                const existing = markers.get(vertex.id);
                if (existing) {
                    existing.marker.setLngLat(lngLat);
                    continue;
                }

                const el = document.createElement("div");
                el.style.width = "14px";
                el.style.height = "14px";
                el.style.borderRadius = "2px";
                el.style.background = resolveToken("--color-yellow-30");
                el.style.border = "2px solid white";
                el.style.boxShadow = "0 1px 2px rgba(0,0,0,0.6)";
                el.style.cursor = "pointer";

                const marker = new Marker({element: el, draggable: true})
                    .setLngLat(lngLat)
                    .addTo(map);
                const vertexId = vertex.id;
                const polygonId = polygon.id;

                // Live update of polygon shape and intersection color while dragging.
                marker.on("drag", () => {
                    const src = map.getSource(SHAPE_SOURCE) as GeoJSONSource | undefined;
                    if (!src) return;

                    const at = marker.getLngLat();
                    const current = fenceRef.current;

                    const features: GeoJSON.Feature[] = current.polygons.map((p) => {
                        if (p.id !== polygonId) {
                            return polygonFeature(
                                p,
                                p.id === current.selectedId,
                                selfIntersectingRef.current.has(p.id),
                            );
                        }
                        // This polygon: substitute the dragged vertex position.
                        const coords: [number, number][] = p.vertices.map(
                            (v): [number, number] =>
                                v.id === vertexId ? [at.lng, at.lat] : [v.lon, v.lat],
                        );
                        const isIntersecting = isSelfIntersectingCoords(coords);
                        const ring =
                            coords.length >= 3 ? [...coords, coords[0]!] : coords;
                        return {
                            type: "Feature",
                            properties: {
                                selected: p.id === current.selectedId,
                                selfIntersecting: isIntersecting,
                            },
                            geometry:
                                coords.length >= 3
                                    ? {type: "Polygon", coordinates: [ring]}
                                    : {type: "LineString", coordinates: ring},
                        };
                    });
                    for (const c of current.circles) {
                        const feature = circleFeature(c, c.id === current.selectedCircleId);
                        if (feature) features.push(feature);
                    }

                    src.setData({type: "FeatureCollection", features});
                });

                marker.on("dragend", () => {
                    const at = marker.getLngLat();
                    fenceRef.current.moveVertex(vertexId, at.lat, at.lng);
                });

                el.addEventListener("click", (e) => {
                    e.stopPropagation();
                    fenceRef.current.removeVertex(vertexId);
                });

                markers.set(vertexId, {marker, polygonId});
            }
        }

        // Remove markers for vertices that no longer exist.
        for (const [id, {marker}] of markers) {
            if (!seen.has(id)) {
                marker.remove();
                markers.delete(id);
            }
        }
    }, [mapRef, styleReady, fence.polygons]);

    // Reconcile circle handles: a round center marker (drag to move the
    // whole circle) and, once placed, a square edge marker (drag to any
    // bearing/distance — the circle is just redrawn through wherever it
    // lands, nothing snaps).
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !styleReady) return;

        const centers = circleCenterMarkersRef.current;
        const edges = circleEdgeMarkersRef.current;
        const seen = new Set<number>();

        const previewCollection = (
            overrideId: number,
            overrideCenter: {lat: number; lon: number},
            overrideEdge: {lat: number; lon: number} | null,
        ): GeoJSON.FeatureCollection => {
            const current = fenceRef.current;
            const features: GeoJSON.Feature[] = current.polygons.map((p) =>
                polygonFeature(p, p.id === current.selectedId, selfIntersectingRef.current.has(p.id)),
            );
            for (const c of current.circles) {
                const isSelected = c.id === current.selectedCircleId;
                const feature = c.id === overrideId
                    ? circleFeature({center: overrideCenter, edge: overrideEdge}, isSelected)
                    : circleFeature(c, isSelected);
                if (feature) features.push(feature);
            }
            return {type: "FeatureCollection", features};
        };

        for (const circle of fence.circles) {
            if (!circle.center) continue;
            seen.add(circle.id);
            const circleId = circle.id;
            const center = circle.center;
            const centerLngLat: LngLatLike = [center.lon, center.lat];

            let centerMarker = centers.get(circleId);
            if (!centerMarker) {
                const el = document.createElement("div");
                el.style.width = "14px";
                el.style.height = "14px";
                el.style.borderRadius = "50%";
                el.style.background = resolveToken("--color-yellow-30");
                el.style.border = "2px solid white";
                el.style.boxShadow = "0 1px 2px rgba(0,0,0,0.6)";
                el.style.cursor = "move";

                centerMarker = new Marker({element: el, draggable: true}).setLngLat(centerLngLat).addTo(map);
                centerMarker.on("drag", () => {
                    const src = map.getSource(SHAPE_SOURCE) as GeoJSONSource | undefined;
                    if (!src) return;
                    const at = centerMarker!.getLngLat();
                    const current = fenceRef.current.circles.find((c) => c.id === circleId);
                    if (!current?.center) return;
                    // Translate the edge along with the center in the preview too,
                    // so dragging relocates the circle instead of visibly reshaping it.
                    const dLat = at.lat - current.center.lat;
                    const dLon = at.lng - current.center.lon;
                    const edge = current.edge
                        ? {lat: current.edge.lat + dLat, lon: current.edge.lon + dLon}
                        : null;
                    src.setData(previewCollection(circleId, {lat: at.lat, lon: at.lng}, edge));
                });
                centerMarker.on("dragend", () => {
                    const at = centerMarker!.getLngLat();
                    fenceRef.current.moveCircleCenter(circleId, at.lat, at.lng);
                });
                centers.set(circleId, centerMarker);
            } else {
                centerMarker.setLngLat(centerLngLat);
            }

            if (circle.edge) {
                const edgeLngLat: LngLatLike = [circle.edge.lon, circle.edge.lat];

                let edgeMarker = edges.get(circleId);
                if (!edgeMarker) {
                    const el = document.createElement("div");
                    el.style.width = "10px";
                    el.style.height = "10px";
                    el.style.borderRadius = "2px";
                    el.style.background = resolveToken("--color-yellow-30");
                    el.style.border = "2px solid white";
                    el.style.boxShadow = "0 1px 2px rgba(0,0,0,0.6)";
                    el.style.cursor = "pointer";

                    edgeMarker = new Marker({element: el, draggable: true}).setLngLat(edgeLngLat).addTo(map);
                    edgeMarker.on("drag", () => {
                        const src = map.getSource(SHAPE_SOURCE) as GeoJSONSource | undefined;
                        if (!src) return;
                        const at = edgeMarker!.getLngLat();
                        const currentCenter = fenceRef.current.circles.find((c) => c.id === circleId)?.center;
                        if (!currentCenter) return;
                        src.setData(previewCollection(circleId, currentCenter, {lat: at.lat, lon: at.lng}));
                    });
                    edgeMarker.on("dragend", () => {
                        const at = edgeMarker!.getLngLat();
                        fenceRef.current.moveCircleEdge(circleId, at.lat, at.lng);
                    });
                    edges.set(circleId, edgeMarker);
                } else {
                    edgeMarker.setLngLat(edgeLngLat);
                }
            } else {
                const pendingEdge = edges.get(circleId);
                if (pendingEdge) {
                    pendingEdge.remove();
                    edges.delete(circleId);
                }
            }
        }

        for (const [id, marker] of centers) {
            if (!seen.has(id)) { marker.remove(); centers.delete(id); }
        }
        for (const [id, marker] of edges) {
            if (!seen.has(id)) { marker.remove(); edges.delete(id); }
        }
    }, [mapRef, styleReady, fence.circles]);

    // Read-only vehicle dot.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !styleReady || !vehicle.position) return;
        const lngLat: LngLatLike = [vehicle.position.lon, vehicle.position.lat];
        if (!vehicleMarkerRef.current) {
            const el = document.createElement("div");
            el.style.width = "14px";
            el.style.height = "14px";
            el.style.borderRadius = "50%";
            el.style.background = resolveToken("--color-green-40");
            el.style.border = "2px solid rgba(255,255,255,0.85)";
            el.style.boxShadow = "0 1px 3px rgba(0,0,0,0.55)";
            el.style.pointerEvents = "none";
            vehicleMarkerRef.current = new Marker({element: el}).setLngLat(lngLat).addTo(map);
        } else {
            vehicleMarkerRef.current.setLngLat(lngLat);
        }
        if (!hasCenteredRef.current) {
            hasCenteredRef.current = true;
            map.easeTo({center: lngLat, zoom: VEHICLE_ZOOM, duration: 800});
        }
    }, [mapRef, styleReady, vehicle.position]);

    useEffect(() => {
        return () => {
            for (const {marker} of markersRef.current.values()) marker.remove();
            markersRef.current.clear();
            for (const marker of circleCenterMarkersRef.current.values()) marker.remove();
            circleCenterMarkersRef.current.clear();
            for (const marker of circleEdgeMarkersRef.current.values()) marker.remove();
            circleEdgeMarkersRef.current.clear();
            vehicleMarkerRef.current?.remove();
            vehicleMarkerRef.current = null;
        };
    }, []);

    return <div ref={containerRef} className="h-full w-full"/>;
}
