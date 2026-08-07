import {useEffect, useRef} from "react";
import {GeoJSONSource, LngLatLike, MapMouseEvent, Marker} from "maplibre-gl";
import {useBaseMap} from "@/lib/map/useBaseMap.ts";
import {resolveToken} from "@/lib/airspace/airspace.ts";
import {useVehicle} from "@/lib/vehicle/useVehicle.ts";
import type {FenceApi} from "@/lib/geofence/useFence.ts";

const POLYGON_SOURCE = "fence-polygon";
const FILL_LAYER = "fence-fill";
const OUTLINE_LAYER = "fence-outline";
const VEHICLE_ZOOM = 15;

interface GeofenceMapProps {
    fence: FenceApi;
    selfIntersecting: boolean;
}

/**
 * The geofence editor's map — a fresh `useBaseMap` instance so drawing a fence
 * doesn't interfere with the main workspace's vehicle-follow camera.
 *
 * Click anywhere on the map to add a vertex. Click a vertex marker to remove
 * it. Drag a vertex to move it. The polygon fill and outline are kept in sync
 * with `fence.vertices` via `setData` on every change, same pattern as
 * `MissionMap`'s route line.
 */
export default function GeofenceMap({fence, selfIntersecting}: GeofenceMapProps) {
    const {containerRef, mapRef, styleReady} = useBaseMap();
    const markersRef = useRef<Map<number, Marker>>(new Map());
    const vehicleMarkerRef = useRef<Marker | null>(null);
    const hasCenteredRef = useRef(false);
    const vehicle = useVehicle();

    // Same stable-closure trick as MissionMap: marker event handlers are
    // registered once but need the current mutators, so they read through a ref.
    const fenceRef = useRef(fence);
    useEffect(() => {
        fenceRef.current = fence;
    }, [fence]);

    // Click empty map → add a vertex. Marker clicks stop propagation so they
    // don't also add a vertex.
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        const onClick = (event: MapMouseEvent) => {
            fenceRef.current.addVertex(event.lngLat.lat, event.lngLat.lng);
        };
        map.on("click", onClick);
        return () => { map.off("click", onClick); };
    }, [mapRef]);

    // Add the polygon GeoJSON source and two layers (fill + outline) once the
    // style is ready, then update their data on every vertex change.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !styleReady) return;
        if (!map.getSource(POLYGON_SOURCE)) {
            map.addSource(POLYGON_SOURCE, {
                type: "geojson",
                data: {type: "Feature", properties: {}, geometry: {type: "Polygon", coordinates: [[]]}},
            });
            map.addLayer({
                id: FILL_LAYER,
                type: "fill",
                source: POLYGON_SOURCE,
                paint: {
                    "fill-color": resolveToken("--color-yellow-30"),
                    "fill-opacity": 0.15,
                },
            });
            map.addLayer({
                id: OUTLINE_LAYER,
                type: "line",
                source: POLYGON_SOURCE,
                paint: {
                    "line-color": resolveToken("--color-yellow-30"),
                    "line-width": 2,
                },
            });
        }
    }, [styleReady]);

    useEffect(() => {
        const map = mapRef.current;
        if (!map || !styleReady) return;
        const source = map.getSource(POLYGON_SOURCE) as GeoJSONSource | undefined;
        if (!source) return;

        const verts = fence.vertices;
        // A polygon needs ≥ 3 points; close the ring by repeating the first
        // vertex. With < 3 points show a line so the operator can see where
        // the first vertex landed.
        const coords = verts.map((v) => [v.lon, v.lat]);
        const ring = verts.length >= 3 ? [...coords, coords[0]!] : coords;

        source.setData({
            type: "Feature",
            properties: {},
            geometry: {
                type: verts.length >= 3 ? "Polygon" : "LineString",
                coordinates: verts.length >= 3 ? [ring] : ring,
            } as GeoJSON.Geometry,
        });
    }, [mapRef, styleReady, fence.vertices]);

    // Swap fill/outline to red when the polygon is self-intersecting.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !styleReady) return;
        const color = selfIntersecting
            ? resolveToken("--color-red-50")
            : resolveToken("--color-yellow-30");
        if (map.getLayer(FILL_LAYER)) {
            map.setPaintProperty(FILL_LAYER, "fill-color", color);
        }
        if (map.getLayer(OUTLINE_LAYER)) {
            map.setPaintProperty(OUTLINE_LAYER, "line-color", color);
        }
    }, [mapRef, styleReady, selfIntersecting]);

    // Vertex markers: reconciled by id on every render, same pattern as
    // MissionMap's waypoint markers.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !styleReady) return;

        const markers = markersRef.current;
        const seen = new Set<number>();

        for (const vertex of fence.vertices) {
            seen.add(vertex.id);
            const lngLat: LngLatLike = [vertex.lon, vertex.lat];
            const existing = markers.get(vertex.id);
            if (existing) {
                existing.setLngLat(lngLat);
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

            const marker = new Marker({element: el, draggable: true}).setLngLat(lngLat).addTo(map);
            const id = vertex.id;

            marker.on("dragend", () => {
                const at = marker.getLngLat();
                fenceRef.current.moveVertex(id, at.lat, at.lng);
            });
            el.addEventListener("click", (e) => {
                e.stopPropagation();
                fenceRef.current.removeVertex(id);
            });

            markers.set(id, marker);
        }

        for (const [id, marker] of markers) {
            if (!seen.has(id)) {
                marker.remove();
                markers.delete(id);
            }
        }
    }, [mapRef, styleReady, fence.vertices]);

    // Read-only vehicle dot, centers on first GPS fix received.
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
            for (const marker of markersRef.current.values()) marker.remove();
            markersRef.current.clear();
            vehicleMarkerRef.current?.remove();
            vehicleMarkerRef.current = null;
        };
    }, []);

    return <div ref={containerRef} className="h-full w-full"/>;
}
