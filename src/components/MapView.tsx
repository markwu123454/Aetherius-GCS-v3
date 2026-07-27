import {useEffect, useRef} from "react";
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

export default function MapView() {
    const containerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<Map | null>(null);

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
            mapRef.current?.remove();
            mapRef.current = null;
        };
    }, []);

    return <div ref={containerRef} className="h-full w-full"/>;
}