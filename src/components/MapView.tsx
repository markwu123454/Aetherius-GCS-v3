import {useEffect, useRef, useState} from "react";
import {createRoot, type Root} from "react-dom/client";
import {LngLatLike, Map, Marker} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {AirportLocation, Drone, LocationCurrent} from "@carbon/icons-react";
import {VehicleKind, VehiclePosition} from "../vehicle/vehicle";

const ESRI_WORLD_IMAGERY_STYLE = {
    version: 8 as const,
    sources: {
        "esri-world-imagery": {
            type: "raster" as const,
            tiles: [
                "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
            ],
            tileSize: 256,
            maxzoom: 19,
            attribution:
                "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
        },
    },
    layers: [
        {
            id: "esri-world-imagery-layer",
            type: "raster" as const,
            source: "esri-world-imagery",
            paint: {
                // Raster tiles cross-fade over 300ms by default, which reads as
                // the map fading in every time a dock opens or closes. The
                // `fadeDuration` map option does not cover raster layers.
                "raster-fade-duration": 0,
            },
        },
    ],
};

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
}

export default function MapView({position, vehicleKind}: MapViewProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<Map | null>(null);
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

    useEffect(() => {
        if (!containerRef.current || mapRef.current) return;

        mapRef.current = new Map({
            container: containerRef.current,
            style: ESRI_WORLD_IMAGERY_STYLE,
            center: [0, 20],
            zoom: 2,
        });

        mapRef.current.on("error", (e) => {
            console.error("Map error]: ", e);
        });

        // The operator taking the camera back: dragstart fires solely for
        // pointer-driven pan, never for our own jumpTo/easeTo.
        mapRef.current.on("dragstart", () => setFollowing(false));

        // Zoom needs an extra check dragstart doesn't: zoomstart fires for
        // both a user's wheel/pinch/double-click *and* our own easeTo (the
        // first-fix flight-in changes zoom too). `originalEvent` is only set
        // for the former, so this doesn't cancel follow the moment it starts.
        mapRef.current.on("zoomstart", (event) => {
            if (event.originalEvent) {
                setFollowing(false);
            }
        });

        const resizeObserver = new ResizeObserver(() => {
            const map = mapRef.current;
            if (!map) return;

            map.resize();
            // resize() reallocates the WebGL drawing buffer, which clears it,
            // and the repaint is otherwise deferred to the next animation
            // frame — so the cleared buffer gets composited first. That is one
            // grey frame per resize event, which reads as a strobe when a dock
            // splitter is dragged quickly. redraw() is synchronous, and this
            // callback runs before paint, so the buffer is never shown empty.
            map.redraw();
        });

        resizeObserver.observe(containerRef.current);

        return () => {
            resizeObserver.disconnect();
            iconRootRef.current?.unmount();
            iconRootRef.current = null;
            markerRef.current?.remove();
            markerRef.current = null;
            mapRef.current?.remove();
            mapRef.current = null;
        };
    }, []);

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
