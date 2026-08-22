import {DEFAULT_AIRSPACE_SETTINGS, type AirspaceSettings} from "@/lib/airspace/classes.ts";
import type {SpeedUnit} from "@/lib/units/speed.ts";
import type {VerticalSpeedUnit} from "@/lib/units/verticalSpeed.ts";
import type {AltitudeUnit} from "@/lib/units/altitude.ts";
import type {DistanceUnit} from "@/lib/units/distance.ts";

export type DisplayMode = "windowed" | "borderless" | "fullscreen";

export type MapBaseLayer = "esri" | "openfreemap";

/**
 * - `"off"`: no automatic zoom — the operator's own zoom level stands until
 *   they change it.
 * - `"groundspeed"`: zoom out as groundspeed rises, in as it falls. This is
 *   the one that actually tracks what auto-zoom is for — how much ground the
 *   vehicle covers per second is what determines whether the visible map
 *   area is about to fall behind it. Works for multirotors too: a hover at
 *   altitude with near-zero groundspeed stays zoomed in rather than pulling
 *   out for no reason.
 * - `"altitude"`: zoom out as altitude rises. Altitude doesn't actually
 *   track ground coverage (a multirotor can sit at altitude with zero
 *   lateral speed), but some operators want the wider "cruise view" reading
 *   this gives during a climb regardless — offered as an explicit choice
 *   rather than folded into groundspeed.
 */
export type AutoZoomMode = "off" | "groundspeed" | "altitude";

export interface MapRegionalLayers {
    japanGsi: boolean;
    statkart: boolean;
    usgsNaip: boolean;
}

export const DEFAULT_MAP_REGIONAL_LAYERS: MapRegionalLayers = {
    japanGsi: false,
    statkart: false,
    usgsNaip: false,
};

/**
 * - `"off"`: cache bypassed entirely — every tile is a plain network fetch,
 *   nothing is read from or written to disk.
 * - `"readOnly"`: serve a tile from the cache when one is there, but never
 *   write a new one. For locking in a cache built ahead of a flight — e.g.
 *   panning around the field beforehand — so nothing outside that gets
 *   fetched later adds to it.
 * - `"readWrite"`: normal operation. Serve from cache when present, fetch
 *   and cache on a miss.
 */
export type MapCacheMode = "off" | "readOnly" | "readWrite";

/** Same identifier set as `MapBaseLayer` plus `MapRegionalLayers`'s keys —
 * every tile source caching can be toggled for independently. */
export type MapCacheProvider = "esri" | "openfreemap" | "japanGsi" | "statkart" | "usgsNaip";

export type MapCacheProviders = Record<MapCacheProvider, boolean>;

export const DEFAULT_MAP_CACHE_PROVIDERS: MapCacheProviders = {
    esri: true,
    openfreemap: true,
    japanGsi: true,
    statkart: true,
    usgsNaip: true,
};

/**
 * App preferences — how the operator wants the GCS to behave. Distinct from
 * vehicle parameters: these never touch the wire, and the vehicle has no
 * opinion about them.
 */
export interface Settings {
    /** Require a second click before disconnecting a link to an armed vehicle. */
    confirmDisconnectWhenArmed: boolean;
    displayMode: DisplayMode;
    /** Unit every backend-reported horizontal speed (groundspeed, airspeed,
     * wind speed) is displayed in. Doesn't touch editable fields tied to a
     * specific wire unit — see units/speed.ts. */
    speedUnit: SpeedUnit;
    /** Unit climb rate is displayed in — separate from `speedUnit` since
     * vertical speed conventionally uses a different unit (ft/min) than
     * horizontal speed. See units/verticalSpeed.ts. */
    verticalSpeedUnit: VerticalSpeedUnit;
    /** Unit every backend-reported altitude is displayed in (position
     * altitude, the PFD's ALT tape). See units/altitude.ts for what's
     * excluded. */
    altitudeUnit: AltitudeUnit;
    /** Unit every backend-reported ground distance is displayed in (home
     * distance, waypoint distance, cross-track error, mission route
     * distance). See units/distance.ts. */
    distanceUnit: DistanceUnit;
    mapBaseLayer: MapBaseLayer;
    mapRegionalLayers: MapRegionalLayers;
    /** Per-class airspace presentation. The single source of truth for which
     * layers are drawn — the View menu writes here too, rather than keeping its
     * own idea of what is switched on. */
    airspace: AirspaceSettings;
    /** Repeats of the same console line, within the coalescing window, before
     * they stop appending as separate lines and start folding into one with a
     * running `×N` count. */
    consoleCollapseThreshold: number;
    /** Compress the map marker icon along the vehicle's pitch and roll axes to
     * suggest attitude at a glance. Purely cosmetic. */
    markerTilt: boolean;
    /** Show trailing sparklines on telemetry rows that support them. */
    telemetrySparklines: boolean;
    /** How often (seconds) the backend re-sends MAV_CMD_RUN_PREARM_CHECKS while
     * disarmed. Takes effect on next connection. */
    prearmCheckInterval: number;
    /** Rate (Hz) at which the vehicle is asked to send attitude, position,
     * VFR_HUD, and RC channels. Capped at 20 Hz — the backend's own emit
     * throttle. Takes effect on next connection. */
    telemRateHz: number;
    /** Zoom the map automatically while following the vehicle. See
     * `AutoZoomMode` for what each mode does. */
    autoZoomMode: AutoZoomMode;
    /** Persist fetched map tiles (base layer + regional overlays) to disk so
     * they're reused across sessions instead of re-downloaded — the point
     * being flying the same field again without a connection. See
     * `MapCacheMode` for what each mode does. */
    mapCacheMode: MapCacheMode;
    /** Soft cap on the on-disk tile cache, in megabytes — no upper bound
     * enforced here, the operator can type any size the disk can hold.
     * Enforced on write by evicting the oldest-downloaded tiles first, so
     * this is a ceiling, not a reservation. */
    mapCacheMaxSizeMb: number;
    /** How long a cached tile is served without trying to refresh it, in
     * days. `0` means never expire. Past this age a tile is still kept and
     * still used — a refetch is attempted first, and the aged copy is only
     * served if that refetch fails (no connection), rather than the tile
     * ever being deleted outright for age alone. */
    mapCacheMaxAgeDays: number;
    /** Tiles below this zoom are always fetched fresh, never cached — low
     * zoom tiles are negligible in size and rarely revisited, so caching
     * them buys nothing. */
    mapCacheMinZoom: number;
    /** Tiles above this zoom are always fetched fresh, never cached — tile
     * count for a given area roughly quadruples per zoom level, so this is
     * the actual lever on how much disk a cached region costs. */
    mapCacheMaxZoom: number;
    /** Per-source opt-out — caching stays off for a source even in
     * `readWrite` mode if its entry here is `false`. */
    mapCacheProviders: MapCacheProviders;
}

/** Below this, there's nothing left to collapse — the first occurrence of a
 * line is always shown on its own regardless of the setting. */
export const MIN_CONSOLE_COLLAPSE_THRESHOLD = 2;

export const MIN_PREARM_CHECK_INTERVAL = 1;
export const MAX_PREARM_CHECK_INTERVAL = 60;
export const MIN_TELEM_RATE_HZ = 1;
/** Must not exceed the backend's own 20 Hz emit throttle. */
export const MAX_TELEM_RATE_HZ = 20;

/** Floor only — below this the cache would evict on almost every write,
 * making it a no-op in practice. No ceiling: the operator can type any size
 * their disk can hold. */
export const MIN_MAP_CACHE_MB = 64;

export const MIN_MAP_CACHE_ZOOM = 0;
export const MAX_MAP_CACHE_ZOOM = 19;

export const DEFAULT_SETTINGS: Settings = {
    confirmDisconnectWhenArmed: true,
    displayMode: "windowed",
    speedUnit: "mps",
    verticalSpeedUnit: "mps",
    altitudeUnit: "m",
    distanceUnit: "m",
    mapBaseLayer: "esri",
    mapRegionalLayers: DEFAULT_MAP_REGIONAL_LAYERS,
    airspace: DEFAULT_AIRSPACE_SETTINGS,
    consoleCollapseThreshold: MIN_CONSOLE_COLLAPSE_THRESHOLD,
    markerTilt: false,
    telemetrySparklines: true,
    prearmCheckInterval: 3,
    telemRateHz: 20,
    autoZoomMode: "off",
    mapCacheMode: "readWrite",
    mapCacheMaxSizeMb: 512,
    mapCacheMaxAgeDays: 0,
    mapCacheMinZoom: MIN_MAP_CACHE_ZOOM,
    mapCacheMaxZoom: 18,
    mapCacheProviders: DEFAULT_MAP_CACHE_PROVIDERS,
};
