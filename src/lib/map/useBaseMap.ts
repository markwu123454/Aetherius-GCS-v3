import {RefObject, useEffect, useRef, useState} from "react";
import {Map, type RasterSourceSpecification, type StyleSpecification} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {useSettings} from "@/lib/settings/useSettings.ts";
import type {MapRegionalLayers} from "@/lib/settings/settings.ts";
import {ensureTileCacheProtocol, maybeCachedTileUrl, updateMapCacheSettings} from "@/lib/map/tileCache.ts";

const OPENFREEMAP_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";

function buildEsriStyle(): StyleSpecification {
    return {
        version: 8,
        sources: {
            "esri": {
                type: "raster",
                tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
                tileSize: 256,
                maxzoom: 19,
                attribution: "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
            },
        },
        layers: [{
            id: "esri-layer",
            type: "raster",
            source: "esri",
            paint: {"raster-fade-duration": 0},
        }],
    };
}

type RegionalKey = keyof MapRegionalLayers;

const REGIONAL_CONFIGS: Record<RegionalKey, {sourceId: string; layerId: string; source: RasterSourceSpecification}> = {
    usgsNaip: {
        sourceId: "regional-usgs-naip",
        layerId: "regional-usgs-naip",
        source: {
            type: "raster",
            tiles: ["https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}"],
            tileSize: 256,
            maxzoom: 16,
            bounds: [-180, 17, -60, 73], // US including Alaska and Hawaii
            attribution: "USGS, The National Map",
        },
    },
    statkart: {
        sourceId: "regional-statkart",
        layerId: "regional-statkart",
        source: {
            type: "raster",
            tiles: ["https://opencache.statkart.no/gatekeeper/gk/gk.open_gmaps?layers=topo4&zoom={z}&x={x}&y={y}"],
            tileSize: 256,
            bounds: [4.0, 57.0, 32.0, 72.0], // Norway
            attribution: "© Kartverket",
        },
    },
    japanGsi: {
        sourceId: "regional-japan-gsi",
        layerId: "regional-japan-gsi",
        source: {
            type: "raster",
            tiles: ["https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg"],
            tileSize: 256,
            maxzoom: 18,
            bounds: [122.0, 20.0, 154.0, 46.0], // Japan
            attribution: "© 国土地理院",
        },
    },
};

export interface BaseMap {
    containerRef: RefObject<HTMLDivElement | null>;
    mapRef: RefObject<Map | null>;
    /**
     * Layers can only be added once the style has loaded, which happens after
     * the map object exists — callers needing to add sources/layers should
     * key an effect off this rather than `mapRef.current`.
     */
    styleReady: boolean;
}

/**
 * The MapLibre instance shared by every map in the app: container ref → map
 * construction, style management, regional overlay toggling, error logging,
 * style-load signal, and the ResizeObserver with its `resize()` + `redraw()`
 * flicker fix.
 */
export function useBaseMap(): BaseMap {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const mapRef = useRef<Map | null>(null);
    const [styleReady, setStyleReady] = useState(false);
    const {
        mapBaseLayer, mapRegionalLayers,
        mapCacheMode, mapCacheMaxSizeMb, mapCacheMaxAgeDays, mapCacheMinZoom, mapCacheMaxZoom, mapCacheProviders,
    } = useSettings();

    // `tileCache.ts`'s protocol handler is a module singleton shared by every
    // map instance, not something re-created per map — so cache settings are
    // pushed into it here rather than closed over, letting a change take
    // effect on the very next tile request with no map teardown/rebuild.
    useEffect(() => {
        updateMapCacheSettings({
            mode: mapCacheMode,
            maxSizeMb: mapCacheMaxSizeMb,
            maxAgeDays: mapCacheMaxAgeDays,
            minZoom: mapCacheMinZoom,
            maxZoom: mapCacheMaxZoom,
            providers: mapCacheProviders,
        });
    }, [mapCacheMode, mapCacheMaxSizeMb, mapCacheMaxAgeDays, mapCacheMinZoom, mapCacheMaxZoom, mapCacheProviders]);

    // Create the map once. The initial style uses whatever base layer the settings
    // have at mount time (usually the default "esri" since settings load async).
    // If settings later change mapBaseLayer, the switch effect below handles it.
    useEffect(() => {
        if (!containerRef.current || mapRef.current) return;

        ensureTileCacheProtocol();

        const initialStyle: StyleSpecification | string =
            mapBaseLayer === "openfreemap" ? OPENFREEMAP_STYLE_URL : buildEsriStyle();

        mapRef.current = new Map({
            container: containerRef.current,
            style: typeof initialStyle === "string" ? initialStyle : structuredClone(initialStyle),
            center: [0, 20],
            zoom: 2,
            // Routes tile requests (raster tiles from the base layer and
            // regional overlays, plus OpenFreeMap's vector tiles) through the
            // on-disk cache when the current settings say to. Style JSON,
            // glyphs, and sprites are left untouched — see `tileCache.ts`.
            transformRequest: (url, resourceType) =>
                resourceType === "Tile" ? {url: maybeCachedTileUrl(url)} : {url},
        });

        mapRef.current.on("error", (e) => {
            console.error("Map error:", e);
        });

        mapRef.current.on("load", () => {
            setStyleReady(true);
        });

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
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Switch base layer when the setting changes. Skips the initial mount so the
    // creation effect above handles the first style, avoiding a redundant setStyle.
    const isFirstBaseSwitch = useRef(true);
    useEffect(() => {
        if (isFirstBaseSwitch.current) {
            isFirstBaseSwitch.current = false;
            return;
        }
        const map = mapRef.current;
        if (!map) return;

        setStyleReady(false);
        map.once("style.load", () => setStyleReady(true));
        const style: StyleSpecification | string =
            mapBaseLayer === "openfreemap" ? OPENFREEMAP_STYLE_URL : buildEsriStyle();
        map.setStyle(typeof style === "string" ? style : structuredClone(style));
    }, [mapBaseLayer]);

    // Add or remove regional overlay sources/layers whenever styleReady or the
    // regional toggles change. setStyle() wipes all custom sources, so this also
    // restores enabled overlays after a base layer switch.
    // For the OpenFreeMap vector base, overlays are inserted before the first
    // symbol layer so road labels remain on top of the raster imagery.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !styleReady) return;

        // Insert regional rasters below any GeoJSON layers (tracks, airspace,
        // mission) that callers may have added after the style loaded. If none
        // exist yet, fall back to before the first symbol layer (OpenFreeMap
        // labels) or at the top (ESRI, where callers' GeoJSON will stack above).
        const firstGeoJsonId = map.getStyle().layers.find((l) => {
            const src = (l as {source?: string}).source;
            return src && (map.getSource(src) as {type?: string} | undefined)?.type === "geojson";
        })?.id;
        const firstSymbolId =
            mapBaseLayer === "openfreemap"
                ? map.getStyle().layers.find((l) => l.type === "symbol")?.id
                : undefined;
        const insertBefore = firstGeoJsonId ?? firstSymbolId;

        for (const key of Object.keys(REGIONAL_CONFIGS) as RegionalKey[]) {
            const {sourceId, layerId, source} = REGIONAL_CONFIGS[key];
            const enabled = mapRegionalLayers[key];

            if (enabled) {
                if (!map.getSource(sourceId)) {
                    map.addSource(sourceId, source);
                    map.addLayer(
                        {id: layerId, type: "raster", source: sourceId, paint: {"raster-fade-duration": 0}},
                        insertBefore,
                    );
                }
            } else {
                if (map.getLayer(layerId)) map.removeLayer(layerId);
                if (map.getSource(sourceId)) map.removeSource(sourceId);
            }
        }
    }, [styleReady, mapRegionalLayers, mapBaseLayer]);

    return {containerRef, mapRef, styleReady};
}
