import {useEffect, useRef, useState} from "react";
import {createRoot, type Root} from "react-dom/client";
import {Marker} from "maplibre-gl";
import {AirportLocation, Drone, LocationCurrent} from "@carbon/icons-react";
import {VehicleKind, VehiclePosition} from "@/lib/vehicle/vehicle.ts";
import {AIRSPACE_CLASSES, airspaceColor} from "@/lib/airspace/airspace.ts";
import type {AirspaceState} from "@/lib/airspace/useAirspace.ts";
import {useBaseMap} from "@/lib/map/useBaseMap.ts";

/** Camera zoom the first fix settles at — close enough to be useful, not so
 * close that a GPS jump before the fix settles reads as a wild camera swing. */
const FIRST_FIX_ZOOM = 17;

/**
 * `LocationCurrent`'s arrow tip points ~45° off north (up-and-right) in its
 * own artwork, not straight up. Rotating it to a compass heading has to
 * correct for that, or a heading of 0 (north) would visibly point northeast.
 */
const LOCATION_CURRENT_BEARING = 45;

/**
 * Bounds on the gap between two fixes used to pace the interpolation below.
 * Below the floor, a near-zero interval would turn into a near-infinite
 * interpolation speed for one frame; above the ceiling (a link hiccup, or
 * simply the first fix after connecting), a fix that arrived late is snapped
 * to rather than eased toward, so catching up doesn't play out as visible
 * slow motion.
 */
const MIN_INTERPOLATE_MS = 20;
const MAX_INTERPOLATE_MS = 500;

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

/** Shortest-path interpolation across the 0/360 wrap, so a heading crossing
 * north turns the marker the short way rather than spinning it almost all
 * the way around. */
function lerpAngle(a: number, b: number, t: number): number {
    const delta = ((((b - a) % 360) + 540) % 360) - 180;
    return a + delta * t;
}

function lerpLngLat(a: [number, number], b: [number, number], t: number): [number, number] {
    return [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
}

/** `Drone` has no "front" in its artwork — four rotors in a symmetric X — so
 * there is no offset to correct for; it rotates along with heading anyway. */
function VehicleMarkerIcon({kind}: {kind: VehicleKind | null}) {
    return kind === "multirotor" ? <Drone size={28}/> : <LocationCurrent size={28}/>;
}

function markerRotation(heading: number, kind: VehicleKind | null): number {
    return kind === "plane" || kind === null || kind === "other" ? heading - LOCATION_CURRENT_BEARING : heading;
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

    // The tick loop's own source of truth for whether to keep calling
    // `jumpTo` — set synchronously, in the same call as `setFollowing`,
    // rather than mirrored from `following` via an effect. An effect only
    // runs after React re-renders, which during an active drag can lag the
    // tick loop's own 60fps `requestAnimationFrame` calls by several frames:
    // long enough for `jumpTo` to keep re-centering on the vehicle and cancel
    // out the drag the user is actively performing, making the map look like
    // it can't be dragged at all. Reading and writing this ref is the only
    // thing that has to be instantaneous; the `following` state is purely for
    // the button's own styling, which can lag a frame with no visible cost.
    const followingRef = useRef(false);

    function setFollowingNow(value: boolean): void {
        followingRef.current = value;
        setFollowing(value);
    }

    const vehicleKindRef = useRef(vehicleKind);
    useEffect(() => {
        vehicleKindRef.current = vehicleKind;
    }, [vehicleKind]);

    // A deliberate eased camera move in flight — the first-fix flight-in, or
    // the recenter button — that the follow tick below must not fight. Both
    // an `easeTo` and a per-frame `jumpTo` are direct camera commands; without
    // this, the very next animation frame would cut the ease off almost
    // before it starts.
    const recenteringRef = useRef(false);

    // The last two fixes and when each arrived, in browser time — what the
    // tick loop interpolates between. Not React state: nothing here should
    // trigger a render, only what the map draws on its own clock.
    const previousFixRef = useRef<{lngLat: [number, number]; heading: number; at: number} | null>(null);
    const latestFixRef = useRef<{lngLat: [number, number]; heading: number; at: number} | null>(null);

    // Runs after `useBaseMap`'s own effect within the same commit, so the map
    // instance already exists. These listeners die with the map itself (torn
    // down by `useBaseMap`'s cleanup), so there's nothing to unregister here.
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;

        // The operator taking the camera back. `mousedown`/`touchstart`, not
        // `dragstart` — `dragstart` only fires once MapLibre's own gesture
        // recognition decides the pointer has moved enough to count as a
        // drag, and every frame before that the tick loop's `jumpTo` (while
        // following) keeps winning and resetting the camera right back,
        // which for a vehicle sitting still made a whole short drag gesture
        // look completely inert. `mousedown` fires the instant the pointer
        // goes down, closing that gap — and as a side effect, a plain click
        // (not just a drag) now stops tracking too, which reads as more
        // predictable than only some pointer gestures taking the camera back.
        map.on("mousedown", () => setFollowingNow(false));
        map.on("touchstart", () => setFollowingNow(false));

        // Zoom needs an extra check dragstart doesn't: zoomstart fires for
        // both a user's wheel/pinch/double-click *and* our own easeTo (the
        // first-fix flight-in changes zoom too). `originalEvent` is only set
        // for the former, so this doesn't cancel follow the moment it starts.
        map.on("zoomstart", (event) => {
            if (event.originalEvent) {
                setFollowingNow(false);
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

    // Records each new fix and (re)creates the marker — the actual on-screen
    // position is the tick loop's job, below. Kept separate so a fix arriving
    // doesn't have to fight a still-running interpolation toward the previous
    // one: this only ever records where the marker is headed next.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !position) return;

        const lngLat: [number, number] = [position.lon, position.lat];

        previousFixRef.current = latestFixRef.current;
        latestFixRef.current = {lngLat, heading: position.heading, at: performance.now()};

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
        }

        iconRootRef.current?.render(<VehicleMarkerIcon kind={vehicleKind}/>);

        if (!hasCenteredRef.current) {
            // First fix ever: worth an animated flight in from the world view,
            // and worth taking over the camera for even if the operator hasn't
            // asked to follow yet — there is nothing else on screen to look at.
            // There's no previous fix to interpolate from either, so the tick
            // loop below just places the marker here directly.
            hasCenteredRef.current = true;
            setFollowingNow(true);
            recenteringRef.current = true;
            map.once("moveend", () => {
                recenteringRef.current = false;
            });
            map.easeTo({center: lngLat, zoom: FIRST_FIX_ZOOM, duration: 800});
        }
    }, [position, vehicleKind]);

    // Glides the marker (and, while following, the camera) between the last
    // two fixes on its own animation-frame clock, rather than hopping to each
    // new one the instant it arrives. Runs continuously, independent of how
    // often `position` actually changes — telemetry arrives in bursts at
    // whatever rate the link allows, and this is what turns that into motion
    // smooth enough to watch.
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;

        let frame: number;

        const tick = () => {
            const marker = markerRef.current;
            const latest = latestFixRef.current;

            if (marker && latest) {
                const previous = previousFixRef.current;
                let lngLat = latest.lngLat;
                let heading = latest.heading;

                if (previous) {
                    const interval = clamp(latest.at - previous.at, MIN_INTERPOLATE_MS, MAX_INTERPOLATE_MS);
                    const t = clamp((performance.now() - latest.at) / interval, 0, 1);
                    lngLat = lerpLngLat(previous.lngLat, latest.lngLat, t);
                    heading = lerpAngle(previous.heading, latest.heading, t);
                }

                marker.setLngLat(lngLat);
                marker.setRotation(markerRotation(heading, vehicleKindRef.current));

                if (followingRef.current && !recenteringRef.current) {
                    map.jumpTo({center: lngLat});
                }
            }

            frame = requestAnimationFrame(tick);
        };

        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
    }, [mapRef]);

    const recenter = () => {
        setFollowingNow(true);
        const map = mapRef.current;
        if (map && position) {
            recenteringRef.current = true;
            map.once("moveend", () => {
                recenteringRef.current = false;
            });
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
