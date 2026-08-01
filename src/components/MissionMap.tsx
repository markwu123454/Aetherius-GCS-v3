import {useEffect, useRef} from "react";
import {GeoJSONSource, LngLatLike, MapMouseEvent, Marker} from "maplibre-gl";
import {useBaseMap} from "./useBaseMap";
import {resolveToken} from "../airspace/airspace";
import type {MissionApi} from "../mission/useMission";

const ROUTE_SOURCE_ID = "mission-route";
const ROUTE_LAYER_ID = "mission-route-line";

interface MissionMapProps {
    mission: MissionApi;
}

/**
 * The mission editor's own map — a fresh `useBaseMap` instance, not the
 * docked `MapView`, so building a draft doesn't fight with the vehicle's live
 * position/follow-camera behavior on the same canvas.
 *
 * Waypoint markers are dynamic (unlike `MapView`'s one persistent vehicle
 * marker), so they're tracked in a `Map<id, Marker>` ref and reconciled
 * against `mission.waypoints` every render — added, moved, or removed to
 * match, rather than torn down and rebuilt wholesale.
 */
export default function MissionMap({mission}: MissionMapProps) {
    const {containerRef, mapRef, styleReady} = useBaseMap();
    const markersRef = useRef<Map<number, Marker>>(new Map());

    // Marker event closures are registered once, when a marker is first
    // created, and outlive any single render — so they read the mutators
    // through a ref rather than closing over `mission` directly, the same
    // pattern `MapView.tsx` uses for `following`. Without it, edits made
    // after a later render (a fresh `addWaypoint`/`removeWaypoint` identity
    // isn't the concern here since those are stable via `useCallback`, but
    // `mission` as a whole is a new object every render) would still call
    // whichever closure happened to be current when that marker was added.
    const missionRef = useRef(mission);
    useEffect(() => {
        missionRef.current = mission;
    }, [mission]);

    // Click empty map -> add a waypoint. Runs once `useBaseMap`'s own effect
    // has created the map (same-commit ordering as `MapView.tsx`'s listener
    // effect). Marker clicks never reach this: marker elements are DOM
    // overlays outside the map canvas, so a click on one doesn't fire the
    // map's own "click" event.
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;

        const onClick = (event: MapMouseEvent) => {
            missionRef.current.addWaypoint(event.lngLat.lat, event.lngLat.lng);
        };
        map.on("click", onClick);
        return () => {
            map.off("click", onClick);
        };
    }, [mapRef]);

    // The route line: one GeoJSON source/layer added once the style is ready,
    // then kept current with `setData` on every waypoint change — a
    // different access pattern from the airspace effect in `MapView.tsx`,
    // which only re-styles static geometry and never calls `setData`.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !styleReady) return;

        if (!map.getSource(ROUTE_SOURCE_ID)) {
            map.addSource(ROUTE_SOURCE_ID, {
                type: "geojson",
                data: {type: "Feature", properties: {}, geometry: {type: "LineString", coordinates: []}},
            });
            map.addLayer({
                id: ROUTE_LAYER_ID,
                type: "line",
                source: ROUTE_SOURCE_ID,
                paint: {"line-color": resolveToken("--color-blue-60"), "line-width": 2},
            });
        }
    }, [styleReady]);

    useEffect(() => {
        const map = mapRef.current;
        if (!map || !styleReady) return;

        const source = map.getSource(ROUTE_SOURCE_ID) as GeoJSONSource | undefined;
        source?.setData({
            type: "Feature",
            properties: {},
            geometry: {
                type: "LineString",
                coordinates: mission.waypoints.map((waypoint) => [waypoint.lon, waypoint.lat]),
            },
        });
    }, [mapRef, styleReady, mission.waypoints]);

    // Waypoint markers: reconciled against `mission.waypoints` by id every
    // render, rather than diffed against the previous render's list — the
    // list is short enough (a hand-placed mission, not a telemetry stream)
    // that a full pass each time is simpler than tracking what changed.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !styleReady) return;

        const markers = markersRef.current;
        const seen = new Set<number>();

        for (const waypoint of mission.waypoints) {
            seen.add(waypoint.id);
            const lngLat: LngLatLike = [waypoint.lon, waypoint.lat];
            const existing = markers.get(waypoint.id);

            if (existing) {
                existing.setLngLat(lngLat);
                continue;
            }

            const element = document.createElement("div");
            element.style.width = "18px";
            element.style.height = "18px";
            element.style.borderRadius = "50%";
            element.style.background = resolveToken("--color-blue-60");
            element.style.border = "2px solid white";
            element.style.boxShadow = "0 1px 2px rgba(0, 0, 0, 0.6)";
            element.style.cursor = "pointer";

            const marker = new Marker({element, draggable: true}).setLngLat(lngLat).addTo(map);
            const id = waypoint.id;

            marker.on("dragend", () => {
                const at = marker.getLngLat();
                missionRef.current.moveWaypoint(id, at.lat, at.lng);
            });
            element.addEventListener("click", (event) => {
                event.stopPropagation();
                missionRef.current.removeWaypoint(id);
            });

            markers.set(id, marker);
        }

        for (const [id, marker] of markers) {
            if (!seen.has(id)) {
                marker.remove();
                markers.delete(id);
            }
        }
    }, [mapRef, styleReady, mission.waypoints]);

    // Markers are this component's own state, tied to the waypoint list
    // rather than the map instance — `useBaseMap` tears down the map itself,
    // but knows nothing about these, so their cleanup stays here.
    useEffect(() => {
        return () => {
            for (const marker of markersRef.current.values()) {
                marker.remove();
            }
            markersRef.current.clear();
        };
    }, []);

    return <div ref={containerRef} className="h-full w-full"/>;
}
