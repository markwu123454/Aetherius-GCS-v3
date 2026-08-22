import {useEffect, useRef} from "react";
import {GeoJSONSource, LngLatLike, MapMouseEvent, Marker} from "maplibre-gl";
import {useBaseMap} from "@/lib/map/useBaseMap.ts";
import {resolveToken} from "@/lib/airspace/airspace.ts";
import {useVehicle} from "@/lib/vehicle/useVehicle.ts";
import type {RallyApi} from "@/lib/rally/useRally.ts";
import type {RallyPointDraft} from "@/lib/rally/rally.ts";

const POINT_SOURCE = "rally-points";
const POINT_LAYER = "rally-points-circle";
const VEHICLE_ZOOM = 15;

function buildFeatureCollection(points: RallyPointDraft[], selectedId: number | null): GeoJSON.FeatureCollection {
    return {
        type: "FeatureCollection",
        features: points.map((p) => ({
            type: "Feature",
            properties: {selected: p.id === selectedId},
            geometry: {type: "Point", coordinates: [p.lon, p.lat]},
        })),
    };
}

interface RallyMapProps {
    rally: RallyApi;
}

/**
 * Click anywhere on empty map to drop a new rally point; drag a marker to
 * relocate it; click a marker to remove it — the same interaction shape as
 * `GeofenceMap`'s vertex markers, minus everything about polygons/circles
 * this page has no equivalent of.
 */
export default function RallyMap({rally}: RallyMapProps) {
    const {containerRef, mapRef, styleReady} = useBaseMap();
    const markersRef = useRef<Map<number, Marker>>(new Map());
    const vehicleMarkerRef = useRef<Marker | null>(null);
    const hasCenteredRef = useRef(false);
    const vehicle = useVehicle();

    const rallyRef = useRef(rally);
    useEffect(() => { rallyRef.current = rally; }, [rally]);

    // Click on empty map → add a new point there.
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        const onClick = (event: MapMouseEvent) => {
            rallyRef.current.addPoint(event.lngLat.lat, event.lngLat.lng);
        };
        map.on("click", onClick);
        return () => { map.off("click", onClick); };
    }, [mapRef]);

    // Add source + layer once style is ready.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !styleReady) return;
        if (map.getSource(POINT_SOURCE)) return;

        const blue = resolveToken("--color-blue-40");

        map.addSource(POINT_SOURCE, {
            type: "geojson",
            data: {type: "FeatureCollection", features: []},
        });
        map.addLayer({
            id: POINT_LAYER,
            type: "circle",
            source: POINT_SOURCE,
            paint: {
                "circle-radius": ["case", ["get", "selected"], 10, 7],
                "circle-color": blue,
                "circle-opacity": 0.25,
                "circle-stroke-width": ["case", ["get", "selected"], 2.5, 1.5],
                "circle-stroke-color": blue,
            },
        });
    }, [styleReady, mapRef]);

    // Keep the halo FeatureCollection in sync with React state.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !styleReady) return;
        const source = map.getSource(POINT_SOURCE) as GeoJSONSource | undefined;
        if (!source) return;
        source.setData(buildFeatureCollection(rally.points, rally.selectedId));
    }, [mapRef, styleReady, rally.points, rally.selectedId]);

    // Reconcile draggable point markers.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !styleReady) return;

        const markers = markersRef.current;
        const seen = new Set<number>();

        for (const [index, point] of rally.points.entries()) {
            seen.add(point.id);
            const lngLat: LngLatLike = [point.lon, point.lat];

            const existing = markers.get(point.id);
            if (existing) {
                existing.setLngLat(lngLat);
                (existing.getElement().firstChild as HTMLElement).textContent = String(index + 1);
                continue;
            }

            const el = document.createElement("div");
            el.style.width = "20px";
            el.style.height = "20px";
            el.style.borderRadius = "50%";
            el.style.background = resolveToken("--color-blue-40");
            el.style.border = "2px solid white";
            el.style.boxShadow = "0 1px 2px rgba(0,0,0,0.6)";
            el.style.cursor = "pointer";
            el.style.display = "flex";
            el.style.alignItems = "center";
            el.style.justifyContent = "center";

            const label = document.createElement("span");
            label.textContent = String(index + 1);
            label.style.fontSize = "11px";
            label.style.fontWeight = "600";
            label.style.color = "#000";
            label.style.pointerEvents = "none";
            el.appendChild(label);

            const marker = new Marker({element: el, draggable: true}).setLngLat(lngLat).addTo(map);
            const pointId = point.id;

            marker.on("dragend", () => {
                const at = marker.getLngLat();
                rallyRef.current.movePoint(pointId, at.lat, at.lng);
            });

            el.addEventListener("click", (e) => {
                e.stopPropagation();
                if (rallyRef.current.selectedId === pointId) {
                    rallyRef.current.removePoint(pointId);
                } else {
                    rallyRef.current.selectPoint(pointId);
                }
            });

            markers.set(pointId, marker);
        }

        for (const [id, marker] of markers) {
            if (!seen.has(id)) {
                marker.remove();
                markers.delete(id);
            }
        }
    }, [mapRef, styleReady, rally.points]);

    // Read-only vehicle dot, same as `GeofenceMap`.
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
