import {MutableRefObject, useEffect, useRef, useState} from "react";
import {Map} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

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

export interface BaseMap {
    containerRef: MutableRefObject<HTMLDivElement | null>;
    mapRef: MutableRefObject<Map | null>;
    /** Layers can only be added once the style has loaded, which happens after
     * the map object exists — callers needing to add sources/layers should
     * key an effect off this rather than `mapRef.current`. */
    styleReady: boolean;
}

/**
 * The ESRI-imagery MapLibre instance shared by every map in the app: container
 * ref → map construction, error logging, style-load signal, and the
 * ResizeObserver with its `resize()` + synchronous `redraw()` flicker fix (a
 * resize reallocates the WebGL drawing buffer, which clears it, and the
 * repaint is otherwise deferred to the next animation frame — so the cleared
 * buffer gets composited first; that's one grey frame per resize event, which
 * reads as a strobe when a dock splitter is dragged quickly). Anything
 * component-specific — markers, routes, follow-camera behavior — stays in the
 * caller.
 */
export function useBaseMap(): BaseMap {
    const containerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<Map | null>(null);
    const [styleReady, setStyleReady] = useState(false);

    useEffect(() => {
        if (!containerRef.current || mapRef.current) return;

        mapRef.current = new Map({
            container: containerRef.current,
            // Cloned per instance: MapLibre attaches internal bookkeeping to
            // the style spec object it's given, so two `Map`s sharing one
            // literal reference (the docked `MapView` and a full-screen page's
            // map, both alive at once) collide and neither ever fires "load".
            style: structuredClone(ESRI_WORLD_IMAGERY_STYLE),
            center: [0, 20],
            zoom: 2,
        });

        mapRef.current.on("error", (e) => {
            console.error("Map error]: ", e);
        });

        mapRef.current.on("load", () => setStyleReady(true));

        const resizeObserver = new ResizeObserver(() => {
            const map = mapRef.current;
            if (!map) return;

            map.resize();
            map.redraw();
        });

        resizeObserver.observe(containerRef.current);

        return () => {
            resizeObserver.disconnect();
            mapRef.current?.remove();
            mapRef.current = null;
            setStyleReady(false);
        };
    }, []);

    return {containerRef, mapRef, styleReady};
}
