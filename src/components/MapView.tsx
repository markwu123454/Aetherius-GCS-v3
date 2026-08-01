import {useEffect, useRef, useState} from "react";
import {createRoot, type Root} from "react-dom/client";
import {LngLatLike, Marker} from "maplibre-gl";
import {AirportLocation, Drone, LocationCurrent} from "@carbon/icons-react";
import {VehicleKind, VehiclePosition} from "../vehicle/vehicle";
import {AIRSPACE_CLASSES, airspaceColor} from "../airspace/airspace";
import type {AirspaceState} from "../airspace/useAirspace";
import {useBaseMap} from "./useBaseMap";

/** Camera zoom the first fix settles at — close enough to be useful, not so
 * close that a GPS jump before the fix settles reads as a wild camera swing. */
const FIRST_FIX_ZOOM = 17;

/**
 * `LocationCurrent`'s arrow tip points ~45° off north (up-and-right) in its
 * own artwork, not straight up. Rotating it to a compass heading has to
 * correct for that, or a heading of 0 (north) would visibly point northeast.
 */
const LOCATION_CURRENT_BEARING = 45;

/** `Drone` has no "front" in its artwork — four rotors in a symmetric X — so
 * there is no offset to correct for; it rotates along with heading anyway. */
function VehicleMarkerIcon({kind}: {kind: VehicleKind | null}) {
    return kind === "multirotor" ? <Drone size={28}/> : <LocationCurrent size={28}/>;
}

function markerRotation(position: VehiclePosition, kind: VehicleKind | null): number {
    return kind === "plane" || kind === null || kind === "other"
        ? position.heading - LOCATION_CURRENT_BEARING
        : position.heading;
}

interface MapViewProps {
    position: VehiclePosition | null;
    vehicleKind: VehicleKind | null;
    airspace: AirspaceState;
}

export default function MapView({position, vehicleKind, airspace}: MapViewProps) {
    const {containerRef, mapRef, styleReady} = useBaseMap();
    const markerRef = useRef<Marker | null>(null);
    const iconRootRef = useRef<Root | null>(null);
    const hasCenteredRef = useRef(false);
    const [following, setFollowing] = useState(false);

    // Read inside the position effect without making it a dependency — the
    // effect should only re-run on a new fix, never on a follow-state toggle,
    // or the button's own animated recenter gets cut off by an instant jump
    // from this effect firing a second time right behind it.
    const followingRef = useRef(false);
    useEffect(() => {
        followingRef.current = following;
    }, [following]);

    // Runs after `useBaseMap`'s own effect within the same commit, so the map
    // instance already exists. These listeners die with the map itself (torn
    // down by `useBaseMap`'s cleanup), so there's nothing to unregister here.
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;

        // The operator taking the camera back: dragstart fires solely for
        // pointer-driven pan, never for our own jumpTo/easeTo.
        map.on("dragstart", () => setFollowing(false));

        // Zoom needs an extra check dragstart doesn't: zoomstart fires for
        // both a user's wheel/pinch/double-click *and* our own easeTo (the
        // first-fix flight-in changes zoom too). `originalEvent` is only set
        // for the former, so this doesn't cancel follow the moment it starts.
        map.on("zoomstart", (event) => {
            if (event.originalEvent) {
                setFollowing(false);
            }
        });
    }, [mapRef]);

    // The marker and its React icon root are this component's own, unlike the
    // map itself — `useBaseMap` knows nothing about them, so their teardown
    // stays here.
    useEffect(() => {
        return () => {
            iconRootRef.current?.unmount();
            iconRootRef.current = null;
            markerRef.current?.remove();
            markerRef.current = null;
        };
    }, []);

    // Airspace layers. Each class gets a source plus a fill and an outline, all
    // added once and then shown or hidden — tearing them down on every toggle
    // would re-upload the geometry to the GPU, and Class E is 4,327 polygons.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !styleReady) return;

        for (const definition of AIRSPACE_CLASSES) {
            const geometry = airspace.loaded.get(definition.id);
            if (!geometry) continue;

            const settings = airspace.classes[definition.id];
            const color = airspaceColor(definition.id, settings);
            const sourceId = `airspace-${definition.id}`;
            const fillId = `${sourceId}-fill`;
            const lineId = `${sourceId}-line`;

            if (!map.getSource(sourceId)) {
                map.addSource(sourceId, {type: "geojson", data: geometry});
                map.addLayer({
                    id: fillId,
                    type: "fill",
                    source: sourceId,
                    // Low enough to read as a tint over satellite imagery —
                    // these overlap heavily, and stacked shelves at a busy
                    // field would otherwise turn the ground opaque.
                    paint: {"fill-color": color, "fill-opacity": 0.08},
                });
                // Solid and dashed are two layers toggled by visibility rather
                // than one whose dash array is edited. MapLibre has no value
                // meaning "no dashes", so going from dashed back to solid on a
                // live layer has nothing to set.
                map.addLayer({
                    id: lineId,
                    type: "line",
                    source: sourceId,
                    paint: {"line-color": color, "line-width": 1.5},
                });
                map.addLayer({
                    id: `${lineId}-dashed`,
                    type: "line",
                    source: sourceId,
                    paint: {"line-color": color, "line-width": 1.5, "line-dasharray": [3, 2]},
                });
            }

            map.setPaintProperty(fillId, "fill-color", color);
            map.setPaintProperty(lineId, "line-color", color);
            map.setPaintProperty(`${lineId}-dashed`, "line-color", color);

            const shown = settings.visible;
            map.setLayoutProperty(fillId, "visibility", shown ? "visible" : "none");
            map.setLayoutProperty(lineId, "visibility", shown && !settings.dashed ? "visible" : "none");
            map.setLayoutProperty(
                `${lineId}-dashed`,
                "visibility",
                shown && settings.dashed ? "visible" : "none",
            );
        }
    }, [styleReady, airspace.loaded, airspace.classes]);

    useEffect(() => {
        const map = mapRef.current;
        if (!map || !position) return;

        const lngLat: LngLatLike = [position.lon, position.lat];

        if (!markerRef.current) {
            const element = document.createElement("div");
            element.style.width = "28px";
            element.style.height = "28px";
            // A flat SVG reads as a decal on the imagery without this; the
            // drop shadow is what makes it look like it's sitting above the map.
            element.style.filter = "drop-shadow(0 1px 2px rgba(0, 0, 0, 0.6))";
            element.style.color = "var(--color-blue-60)";

            iconRootRef.current = createRoot(element);
            markerRef.current = new Marker({element, rotationAlignment: "map"}).setLngLat(lngLat).addTo(map);
        } else {
            markerRef.current.setLngLat(lngLat);
        }

        markerRef.current.setRotation(markerRotation(position, vehicleKind));
        iconRootRef.current?.render(<VehicleMarkerIcon kind={vehicleKind}/>);

        if (!hasCenteredRef.current) {
            // First fix ever: worth an animated flight in from the world view,
            // and worth taking over the camera for even if the operator hasn't
            // asked to follow yet — there is nothing else on screen to look at.
            hasCenteredRef.current = true;
            setFollowing(true);
            map.easeTo({center: lngLat, zoom: FIRST_FIX_ZOOM, duration: 800});
        } else if (followingRef.current) {
            // Instant, not eased: fixes arrive ~10/s, and animating each one
            // would just queue eases faster than they can finish.
            map.jumpTo({center: lngLat});
        }
    }, [position, vehicleKind]);

    const recenter = () => {
        setFollowing(true);
        const map = mapRef.current;
        if (map && position) {
            map.easeTo({center: [position.lon, position.lat], duration: 400});
        }
    };

    return (
        <div className="relative h-full w-full">
            <div ref={containerRef} className="h-full w-full"/>
            <button
                type="button"
                onClick={recenter}
                aria-pressed={following}
                title={following ? "Following vehicle" : "Follow vehicle"}
                className={[
                    "absolute bottom-4 right-4 flex h-control-sm w-control-sm items-center justify-center",
                    "border border-border-subtle shadow-overlay",
                    following
                        ? "bg-blue-60 text-text-on-color"
                        : "bg-layer-01 text-text-secondary hover:bg-layer-hover-01 hover:text-text-primary",
                ].join(" ")}
            >
                <AirportLocation size={18}/>
            </button>
        </div>
    );
}
