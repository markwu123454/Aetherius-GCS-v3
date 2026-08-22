import {addProtocol} from "maplibre-gl";
import {invoke} from "@tauri-apps/api/core";
import type {MapCacheMode, MapCacheProvider, MapCacheProviders} from "@/lib/settings/settings.ts";

const PROTOCOL = "cachedtile";
const PREFIX = `${PROTOCOL}://`;

function hasBackend(): boolean {
    return "__TAURI_INTERNALS__" in window;
}

/**
 * Extracts a tile's zoom level from its resolved request URL (after
 * `{z}/{x}/{y}` substitution) — every provider below places `z` first among
 * the tile's path coordinates even though x/y order differs between them
 * (Esri and USGS use z/y/x, GSI uses z/x/y), so one path-based regex covers
 * all of them; Statkart is the exception, passing zoom as a `zoom=` query
 * param instead of a path segment.
 */
const PATH_ZOOM = (url: string): number | null => {
    const m = /\/(\d{1,2})\/\d+\/\d+(?:[.\/?]|$)/.exec(url);
    return m ? Number(m[1]) : null;
};

const QUERY_ZOOM = (paramName: string) => (url: string): number | null => {
    const m = new RegExp(`[?&]${paramName}=(\\d+)`).exec(url);
    return m ? Number(m[1]) : null;
};

interface ProviderRule {
    id: MapCacheProvider;
    /** Matched against the request URL's hostname with `endsWith`. */
    hostname: string;
    zoom: (url: string) => number | null;
}

const PROVIDER_RULES: ProviderRule[] = [
    {id: "esri", hostname: "arcgisonline.com", zoom: PATH_ZOOM},
    {id: "openfreemap", hostname: "openfreemap.org", zoom: PATH_ZOOM},
    {id: "japanGsi", hostname: "gsi.go.jp", zoom: PATH_ZOOM},
    {id: "usgsNaip", hostname: "nationalmap.gov", zoom: PATH_ZOOM},
    {id: "statkart", hostname: "statkart.no", zoom: QUERY_ZOOM("zoom")},
];

function identifyProvider(url: string): ProviderRule | null {
    try {
        const host = new URL(url).hostname;
        return PROVIDER_RULES.find((rule) => host.endsWith(rule.hostname)) ?? null;
    } catch {
        return null;
    }
}

/** Live cache configuration, mirrored from `Settings` by `useBaseMap` on
 * every settings change. Read from the MapLibre callbacks below rather than
 * threaded through as call arguments, since neither `transformRequest` nor
 * `addProtocol`'s handler are wired up per-render — they're registered once
 * and need to see whatever the setting currently is at request time. */
let mode: MapCacheMode = "readWrite";
let maxSizeMb = 512;
let maxAgeDays = 0;
let minZoom = 0;
let maxZoom = 18;
let providers: MapCacheProviders = {esri: true, openfreemap: true, japanGsi: true, statkart: true, usgsNaip: true};

export function updateMapCacheSettings(next: {
    mode: MapCacheMode;
    maxSizeMb: number;
    maxAgeDays: number;
    minZoom: number;
    maxZoom: number;
    providers: MapCacheProviders;
}): void {
    mode = next.mode;
    maxSizeMb = next.maxSizeMb;
    maxAgeDays = next.maxAgeDays;
    minZoom = next.minZoom;
    maxZoom = next.maxZoom;
    providers = next.providers;
}

function shouldCache(url: string): boolean {
    if (mode === "off") return false;
    const provider = identifyProvider(url);
    if (provider && !providers[provider.id]) return false;
    const zoom = provider?.zoom(url) ?? null;
    // Unrecognized provider or an unparsed zoom: cache it anyway rather than
    // silently dropping coverage over a URL shape that didn't match — the
    // five sources this app knows about are a closed, fixed set, so this
    // path is a defensive fallback, not the common case.
    if (zoom !== null && (zoom < minZoom || zoom > maxZoom)) return false;
    return true;
}

/** Rewrites a tile URL to route through the `cachedtile://` protocol below
 * when the current cache settings say this particular tile is worth
 * caching, otherwise returns it unchanged for a plain fetch. Callers apply
 * this only to actual tile requests (see `useBaseMap`'s `transformRequest`)
 * — style JSON, glyphs, and sprites are left alone; they're small and
 * change more often than map tiles do. */
export function maybeCachedTileUrl(url: string): string {
    return shouldCache(url) ? `${PREFIX}${url}` : url;
}

let registered = false;

/**
 * Registers the `cachedtile://` protocol once, app-wide. `addProtocol` is a
 * module-level MapLibre function rather than a per-map one, so this only
 * needs to run once no matter how many `useBaseMap()` instances exist —
 * repeat calls are a no-op.
 *
 * A fresh-enough cache hit resolves entirely on-disk, no network request at
 * all. Past `maxAgeDays` a hit still exists but is treated as stale: a
 * refetch is tried first, and the aged copy is only served if that refetch
 * fails — offline is exactly when a stale tile beats no tile. A miss always
 * fetches; the result is written back through `put_cached_tile` (which
 * enforces the size cap) unless the current mode is read-only.
 */
export function ensureTileCacheProtocol(): void {
    if (registered) return;
    registered = true;

    addProtocol(PROTOCOL, async (params, abortController) => {
        const url = params.url.slice(PREFIX.length);
        const fetchFresh = async (): Promise<ArrayBuffer> => {
            const response = await fetch(url, {signal: abortController.signal});
            if (!response.ok) throw new Error(`Tile fetch failed (${response.status}): ${url}`);
            const data = await response.arrayBuffer();
            if (hasBackend() && mode === "readWrite") {
                invoke("put_cached_tile", {url, bytesB64: bufferToBase64(data), maxSizeMb}).catch(() => {
                    // Best-effort — a failed cache write shouldn't affect the
                    // tile that already loaded.
                });
            }
            return data;
        };

        if (!hasBackend()) {
            return {data: await fetchFresh()};
        }

        let cached: {bytesB64: string; modifiedMs: number} | null = null;
        try {
            cached = await invoke<{bytesB64: string; modifiedMs: number} | null>("get_cached_tile", {url});
        } catch {
            // Cache read failed — treated the same as a miss below.
        }

        if (cached) {
            const ageMs = Date.now() - cached.modifiedMs;
            const stale = maxAgeDays > 0 && ageMs > maxAgeDays * 24 * 60 * 60 * 1000;
            if (!stale) {
                return {data: base64ToBuffer(cached.bytesB64)};
            }
            try {
                return {data: await fetchFresh()};
            } catch {
                // Offline (or the source is down) — a stale tile beats none.
                return {data: base64ToBuffer(cached.bytesB64)};
            }
        }

        return {data: await fetchFresh()};
    });
}

function base64ToBuffer(b64: string): ArrayBuffer {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

function bufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    // Chunked to avoid overflowing the call stack from spreading a whole
    // tile's bytes into `String.fromCharCode`'s arguments at once.
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

/** Current on-disk cache size, for the Settings page's usage readout.
 * Resolves to `null` outside the desktop app. */
export function getMapCacheSizeBytes(): Promise<number | null> {
    if (!hasBackend()) return Promise.resolve(null);
    return invoke<number>("map_cache_size_bytes");
}

export function clearMapCache(): Promise<void> {
    if (!hasBackend()) return Promise.resolve();
    return invoke<void>("clear_map_cache");
}
