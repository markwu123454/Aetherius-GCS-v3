import {ReactElement, useEffect, useState} from "react";
import {
    AutoZoomMode,
    DisplayMode,
    MapBaseLayer,
    MapCacheMode,
    MapCacheProvider,
    MapRegionalLayers,
    MIN_CONSOLE_COLLAPSE_THRESHOLD,
    MIN_TELEM_RATE_HZ,
    MAX_TELEM_RATE_HZ,
    MIN_PREARM_CHECK_INTERVAL,
    MAX_PREARM_CHECK_INTERVAL,
    MIN_MAP_CACHE_MB,
    MIN_MAP_CACHE_ZOOM,
    MAX_MAP_CACHE_ZOOM,
} from "./settings.ts";
import {SettingsApi} from "./useSettings.ts";
import {AIRSPACE_CLASSES, type AirspaceClass, type AirspaceClassSettings} from "@/lib/airspace/classes.ts";
import {resolveToken} from "@/lib/airspace/airspace.ts";
import {SPEED_UNITS} from "@/lib/units/speed.ts";
import {VERTICAL_SPEED_UNITS} from "@/lib/units/verticalSpeed.ts";
import {ALTITUDE_UNITS} from "@/lib/units/altitude.ts";
import {DISTANCE_UNITS} from "@/lib/units/distance.ts";
import {clearMapCache, getMapCacheSizeBytes} from "@/lib/map/tileCache.ts";

export type SettingsCategoryComponent = (props: {settings: SettingsApi}) => ReactElement;

function clampedInt(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, Math.round(value)));
}

/** One row of the Units section — a labeled radiogroup over a unit list
 * from `lib/units/*.ts`, shared by speed/altitude/distance since all three
 * are "pick one of these unit defs" with the same shape. */
function UnitRow<T extends string>({
    name,
    label,
    options,
    value,
    onChange,
    help,
}: {
    name: string;
    label: string;
    options: {value: T; label: string; suffix: string}[];
    value: T;
    onChange: (value: T) => void;
    help: string;
}) {
    return (
        <div className="flex flex-col gap-1">
            <span className="text-body text-text-primary">{label}</span>
            <div className="flex flex-wrap gap-x-4 gap-y-1" role="radiogroup" aria-label={`${label} unit`}>
                {options.map((opt) => (
                    <label key={opt.value} className="flex items-center gap-2 text-body text-text-secondary">
                        <input
                            type="radio"
                            name={name}
                            checked={value === opt.value}
                            onChange={() => onChange(opt.value)}
                        />
                        {opt.label}
                        <span className="text-label text-text-helper">{opt.suffix}</span>
                    </label>
                ))}
            </div>
            <p className="text-label text-text-helper">{help}</p>
        </div>
    );
}

function ConnectionSettings({settings}: {settings: SettingsApi}) {
    return (
        <div className="flex flex-col gap-8">
            <section className="flex flex-col gap-2">
                <h2 className="text-heading text-text-primary">Connection</h2>
                <label className="flex items-center gap-2 text-body text-text-secondary">
                    <input
                        type="checkbox"
                        checked={settings.confirmDisconnectWhenArmed}
                        onChange={(event) => settings.set("confirmDisconnectWhenArmed", event.target.checked)}
                    />
                    Confirm before disconnecting an armed vehicle
                </label>
            </section>

            <section className="flex flex-col gap-2 border-t border-border-subtle pt-6">
                <h2 className="text-heading text-text-primary">Link</h2>
                <p className="text-label text-text-helper">Changes take effect on next connection.</p>

                <label className="flex items-center gap-2 text-body text-text-secondary">
                    Recheck prearm every
                    <input
                        type="number"
                        min={MIN_PREARM_CHECK_INTERVAL}
                        max={MAX_PREARM_CHECK_INTERVAL}
                        step={1}
                        value={settings.prearmCheckInterval}
                        onChange={(event) => {
                            const v = event.target.valueAsNumber;
                            if (Number.isFinite(v)) settings.set("prearmCheckInterval", clampedInt(v, MIN_PREARM_CHECK_INTERVAL, MAX_PREARM_CHECK_INTERVAL));
                        }}
                        className="w-16 border-b border-border-strong bg-layer-02 px-2 py-1 text-center font-mono text-body text-text-primary"
                    />
                    s
                </label>

                <label className="flex items-center gap-2 text-body text-text-secondary">
                    Telemetry rate
                    <input
                        type="number"
                        min={MIN_TELEM_RATE_HZ}
                        max={MAX_TELEM_RATE_HZ}
                        step={1}
                        value={settings.telemRateHz}
                        onChange={(event) => {
                            const v = event.target.valueAsNumber;
                            if (Number.isFinite(v)) settings.set("telemRateHz", clampedInt(v, MIN_TELEM_RATE_HZ, MAX_TELEM_RATE_HZ));
                        }}
                        className="w-16 border-b border-border-strong bg-layer-02 px-2 py-1 text-center font-mono text-body text-text-primary"
                    />
                    Hz
                </label>
                <p className="text-label text-text-helper">
                    Attitude, position, VFR HUD, and RC channels. Max 20 Hz.
                </p>
            </section>
        </div>
    );
}

const DISPLAY_MODES: {value: DisplayMode; label: string}[] = [
    {value: "windowed", label: "Windowed"},
    {value: "borderless", label: "Borderless"},
    {value: "fullscreen", label: "Full screen"},
];

const SWATCH_TOKENS = [
    "--color-blue-60",
    "--color-blue-40",
    "--color-red-50",
    "--color-orange-40",
    "--color-yellow-30",
    "--color-green-50",
    "--color-gray-50",
];

function AirspaceClassRow({
    id,
    label,
    value,
    defaultColor,
    onChange,
}: {
    id: AirspaceClass;
    label: string;
    value: AirspaceClassSettings;
    defaultColor: string;
    onChange: (patch: Partial<AirspaceClassSettings>) => void;
}) {
    const color = value.color ?? defaultColor;

    return (
        <div className="flex flex-col gap-2 border-b border-border-subtle py-3 last:border-b-0">
            <div className="flex items-center gap-3">
                <label className="flex flex-1 items-center gap-2 text-body text-text-secondary">
                    <input
                        type="checkbox"
                        checked={value.visible}
                        onChange={(event) => onChange({visible: event.target.checked})}
                    />
                    {label}
                </label>

                <label className="flex items-center gap-2 text-label text-text-secondary">
                    <input
                        type="checkbox"
                        checked={value.dashed}
                        onChange={(event) => onChange({dashed: event.target.checked})}
                    />
                    Dashed
                </label>
            </div>

            <div className="flex items-center gap-2 pl-6">
                {SWATCH_TOKENS.map((token) => {
                    const swatch = resolveToken(token);
                    const selected = color.toLowerCase() === swatch.toLowerCase();
                    return (
                        <button
                            key={token}
                            type="button"
                            aria-label={`${label} colour ${token.replace("--color-", "")}`}
                            aria-pressed={selected}
                            onClick={() => onChange({color: swatch})}
                            style={{backgroundColor: swatch}}
                            className={[
                                "h-5 w-5 border",
                                selected ? "border-focus ring-1 ring-focus" : "border-border-subtle",
                            ].join(" ")}
                        />
                    );
                })}

                <input
                    type="color"
                    aria-label={`${label} custom colour`}
                    value={color}
                    onChange={(event) => onChange({color: event.target.value})}
                    className="h-5 w-8 border border-border-subtle bg-layer-01"
                />

                <button
                    type="button"
                    onClick={() => onChange({color: null})}
                    disabled={value.color === null}
                    className="text-label text-text-secondary hover:text-text-primary disabled:text-text-disabled"
                >
                    Reset
                </button>

                <span className="ml-auto font-mono text-label text-text-helper">{id.toUpperCase()}</span>
            </div>
        </div>
    );
}

const BASE_LAYER_OPTIONS: {value: MapBaseLayer; label: string; description: string}[] = [
    {value: "esri", label: "ESRI World Imagery", description: "Global satellite imagery"},
    {value: "openfreemap", label: "OpenFreeMap", description: "Vector street map, offline-capable"},
];

const AUTO_ZOOM_MODES: {value: AutoZoomMode; label: string; description: string}[] = [
    {value: "off", label: "Off", description: "Zoom stays exactly where you left it"},
    {value: "groundspeed", label: "By groundspeed", description: "Zooms out as the vehicle moves faster over the ground"},
    {value: "altitude", label: "By altitude", description: "Zooms out as the vehicle climbs"},
];

const MAP_CACHE_MODES: {value: MapCacheMode; label: string; description: string}[] = [
    {value: "off", label: "Off", description: "Every tile is a plain network fetch — nothing read from or written to disk"},
    {value: "readOnly", label: "Read-only", description: "Serve cached tiles, never add new ones — locks in a cache built ahead of time"},
    {value: "readWrite", label: "Read + write", description: "Serve cached tiles, and cache anything new as it's fetched"},
];

const MAP_CACHE_PROVIDER_OPTIONS: {key: MapCacheProvider; label: string}[] = [
    {key: "esri", label: "ESRI World Imagery"},
    {key: "openfreemap", label: "OpenFreeMap"},
    {key: "japanGsi", label: "Japan — GSI Seamless Photo"},
    {key: "statkart", label: "Norway — Kartverket Topo4"},
    {key: "usgsNaip", label: "US — USGS NAIP"},
];

function bytesToMb(bytes: number): string {
    return (bytes / (1024 * 1024)).toFixed(1);
}

type SizeUnit = "mb" | "gb";

/** The max-size input, kept as its own component only because it needs its
 * own local `unit` state — the setting itself always stores megabytes, this
 * is purely a display/entry convenience layered on top. */
function MapCacheSizeInput({settings}: {settings: SettingsApi}) {
    const [unit, setUnit] = useState<SizeUnit>("mb");
    const disabled = settings.mapCacheMode === "off";
    const displayValue = unit === "gb" ? settings.mapCacheMaxSizeMb / 1024 : settings.mapCacheMaxSizeMb;

    const commit = (raw: number) => {
        if (!Number.isFinite(raw) || raw <= 0) return;
        const mb = unit === "gb" ? raw * 1024 : raw;
        settings.set("mapCacheMaxSizeMb", Math.max(MIN_MAP_CACHE_MB, Math.round(mb)));
    };

    return (
        <label className="flex items-center gap-2 text-body text-text-secondary">
            Limit
            <input
                type="number"
                min={unit === "gb" ? MIN_MAP_CACHE_MB / 1024 : MIN_MAP_CACHE_MB}
                step={unit === "gb" ? 0.1 : 64}
                disabled={disabled}
                value={Math.round(displayValue * 100) / 100}
                onChange={(event) => commit(event.target.valueAsNumber)}
                className="w-24 border-b border-border-strong bg-layer-02 px-2 py-1 text-center font-mono text-body text-text-primary disabled:text-text-disabled"
            />
            <select
                value={unit}
                disabled={disabled}
                onChange={(event) => setUnit(event.target.value as SizeUnit)}
                className="border-b border-border-strong bg-layer-02 px-1 py-1 text-body text-text-primary disabled:text-text-disabled"
            >
                <option value="mb">MB</option>
                <option value="gb">GB</option>
            </select>
        </label>
    );
}

/** The cache's current on-disk size and a Clear button — kept as its own
 * component since the size is fetched async and isn't part of `Settings`
 * itself (it's disk state, not a preference). */
function MapCacheUsage() {
    const [sizeBytes, setSizeBytes] = useState<number | null>(null);
    const [clearing, setClearing] = useState(false);

    useEffect(() => {
        let cancelled = false;
        getMapCacheSizeBytes().then((bytes) => {
            if (!cancelled) setSizeBytes(bytes);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    const handleClear = async () => {
        setClearing(true);
        try {
            await clearMapCache();
            setSizeBytes(0);
        } finally {
            setClearing(false);
        }
    };

    return (
        <div className="flex items-center gap-3">
            <span className="text-label text-text-helper">
                {sizeBytes === null ? "—" : `${bytesToMb(sizeBytes)} MB cached`}
            </span>
            <button
                type="button"
                onClick={handleClear}
                disabled={clearing || !sizeBytes}
                className="text-label text-text-secondary hover:text-text-primary disabled:text-text-disabled"
            >
                Clear cache
            </button>
        </div>
    );
}

const REGIONAL_LAYER_OPTIONS: {key: keyof MapRegionalLayers; label: string; description: string}[] = [
    {key: "japanGsi", label: "Japan — GSI Seamless Photo", description: "Aerial imagery, Japan only"},
    {key: "statkart", label: "Norway — Kartverket Topo4", description: "Topographic map, Norway only"},
    {key: "usgsNaip", label: "US — USGS NAIP", description: "High-res aerial, continental US only"},
];

function DisplaySettings({settings}: {settings: SettingsApi}) {
    const updateAirspace = (id: AirspaceClass, patch: Partial<AirspaceClassSettings>) =>
        settings.set("airspace", {
            ...settings.airspace,
            [id]: {...settings.airspace[id], ...patch},
        });

    return (
        <div className="flex flex-col gap-8">
            <section className="flex flex-col gap-2">
                <h2 className="text-heading text-text-primary">Display</h2>
                <div className="flex flex-col gap-1" role="radiogroup" aria-label="Display mode">
                    {DISPLAY_MODES.map((mode) => (
                        <label
                            key={mode.value}
                            className="flex items-center gap-2 text-body text-text-secondary"
                        >
                            <input
                                type="radio"
                                name="display-mode"
                                checked={settings.displayMode === mode.value}
                                onChange={() => settings.set("displayMode", mode.value)}
                            />
                            {mode.label}
                        </label>
                    ))}
                </div>
                <label className="flex items-center gap-2 text-body text-text-secondary">
                    <input
                        type="checkbox"
                        checked={settings.markerTilt}
                        onChange={(event) => settings.set("markerTilt", event.target.checked)}
                    />
                    Tilt map marker with vehicle attitude (multirotor only)
                </label>
            </section>

            <section className="flex flex-col gap-2 border-t border-border-subtle pt-6">
                <h2 className="text-heading text-text-primary">Auto-zoom</h2>
                <p className="text-label text-text-helper">
                    Only takes effect while the map is following the vehicle. Zooming or panning
                    manually cancels following the same way it already does today.
                </p>
                <div className="flex flex-col gap-1" role="radiogroup" aria-label="Auto-zoom">
                    {AUTO_ZOOM_MODES.map((mode) => (
                        <label key={mode.value} className="flex items-start gap-2 text-body text-text-secondary">
                            <input
                                type="radio"
                                name="auto-zoom-mode"
                                className="mt-0.5"
                                checked={settings.autoZoomMode === mode.value}
                                onChange={() => settings.set("autoZoomMode", mode.value)}
                            />
                            <span>
                                {mode.label}
                                <span className="ml-2 text-label text-text-helper">{mode.description}</span>
                            </span>
                        </label>
                    ))}
                </div>
            </section>

            <section className="flex flex-col gap-4 border-t border-border-subtle pt-6">
                <h2 className="text-heading text-text-primary">Units</h2>

                <UnitRow
                    name="speed-unit"
                    label="Speed"
                    options={SPEED_UNITS}
                    value={settings.speedUnit}
                    onChange={(v) => settings.set("speedUnit", v)}
                    help="Groundspeed, airspeed, and wind speed. Mission speed overrides and
                        vehicle parameters stay in m/s, since that's what's sent over the wire."
                />

                <UnitRow
                    name="vertical-speed-unit"
                    label="Climb rate"
                    options={VERTICAL_SPEED_UNITS}
                    value={settings.verticalSpeedUnit}
                    onChange={(v) => settings.set("verticalSpeedUnit", v)}
                    help="Separate from Speed above — vertical speed conventionally uses its own
                        unit (ft/min) even when horizontal speed is in knots or km/h."
                />

                <UnitRow
                    name="altitude-unit"
                    label="Altitude"
                    options={ALTITUDE_UNITS}
                    value={settings.altitudeUnit}
                    onChange={(v) => settings.set("altitudeUnit", v)}
                    help="Position altitude and the PFD's ALT tape. Mission waypoint altitude,
                        the Takeoff climb altitude, and fence altitude limits stay in meters."
                />

                <UnitRow
                    name="distance-unit"
                    label="Distance"
                    options={DISTANCE_UNITS}
                    value={settings.distanceUnit}
                    onChange={(v) => settings.set("distanceUnit", v)}
                    help="Distance to home, distance to the current waypoint, cross-track
                        error, and the mission editor's route-distance stat."
                />
            </section>

            <section className="flex flex-col gap-2 border-t border-border-subtle pt-6">
                <h2 className="text-heading text-text-primary">Base map</h2>
                <div className="flex flex-col gap-1" role="radiogroup" aria-label="Base map">
                    {BASE_LAYER_OPTIONS.map((opt) => (
                        <label key={opt.value} className="flex items-start gap-2 text-body text-text-secondary">
                            <input
                                type="radio"
                                name="map-base-layer"
                                className="mt-0.5"
                                checked={settings.mapBaseLayer === opt.value}
                                onChange={() => settings.set("mapBaseLayer", opt.value)}
                            />
                            <span>
                                {opt.label}
                                <span className="ml-2 text-label text-text-helper">{opt.description}</span>
                            </span>
                        </label>
                    ))}
                </div>
            </section>

            <section className="flex flex-col gap-2 border-t border-border-subtle pt-6">
                <h2 className="text-heading text-text-primary">Regional overlays</h2>
                <p className="text-label text-text-helper">
                    Higher-resolution imagery for specific regions, layered on top of the base map.
                    Tiles outside each region return nothing and the base map shows through.
                </p>
                <div className="flex flex-col gap-1">
                    {REGIONAL_LAYER_OPTIONS.map((opt) => (
                        <label key={opt.key} className="flex items-start gap-2 text-body text-text-secondary">
                            <input
                                type="checkbox"
                                className="mt-0.5"
                                checked={settings.mapRegionalLayers[opt.key]}
                                onChange={(event) =>
                                    settings.set("mapRegionalLayers", {
                                        ...settings.mapRegionalLayers,
                                        [opt.key]: event.target.checked,
                                    })
                                }
                            />
                            <span>
                                {opt.label}
                                <span className="ml-2 text-label text-text-helper">{opt.description}</span>
                            </span>
                        </label>
                    ))}
                </div>
            </section>

            <section className="flex flex-col gap-2 border-t border-border-subtle pt-6">
                <h2 className="text-heading text-text-primary">Map cache</h2>
                <p className="text-label text-text-helper">
                    Keeps a copy of every fetched tile — base layer and regional overlays alike —
                    on disk, so they don't need re-downloading on the next launch. Useful for
                    flying the same field again without a connection. Only caches tiles you
                    actually pan or zoom over, not a pre-fetched region.
                </p>

                <div className="flex flex-col gap-1" role="radiogroup" aria-label="Map cache mode">
                    {MAP_CACHE_MODES.map((mode) => (
                        <label key={mode.value} className="flex items-start gap-2 text-body text-text-secondary">
                            <input
                                type="radio"
                                name="map-cache-mode"
                                className="mt-0.5"
                                checked={settings.mapCacheMode === mode.value}
                                onChange={() => settings.set("mapCacheMode", mode.value)}
                            />
                            <span>
                                {mode.label}
                                <span className="ml-2 text-label text-text-helper">{mode.description}</span>
                            </span>
                        </label>
                    ))}
                </div>

                <MapCacheSizeInput settings={settings}/>
                <p className="text-label text-text-helper">
                    No upper bound enforced — oldest tiles are dropped first once the cache grows
                    past whatever this is set to.
                </p>

                <label className="flex items-center gap-2 text-body text-text-secondary">
                    Refresh after
                    <input
                        type="number"
                        min={0}
                        step={1}
                        disabled={settings.mapCacheMode === "off"}
                        value={settings.mapCacheMaxAgeDays}
                        onChange={(event) => {
                            const v = event.target.valueAsNumber;
                            if (Number.isFinite(v)) settings.set("mapCacheMaxAgeDays", Math.max(0, Math.round(v)));
                        }}
                        className="w-16 border-b border-border-strong bg-layer-02 px-2 py-1 text-center font-mono text-body text-text-primary disabled:text-text-disabled"
                    />
                    days (0 = never)
                </label>
                <p className="text-label text-text-helper">
                    Past this age, a tile is refetched if there's a connection — the aged copy is
                    only kept and reused if that refetch fails, rather than the tile ever being
                    deleted for age alone.
                </p>

                <div className="flex items-center gap-2 text-body text-text-secondary">
                    Cache zoom
                    <input
                        type="number"
                        min={MIN_MAP_CACHE_ZOOM}
                        max={settings.mapCacheMaxZoom}
                        step={1}
                        disabled={settings.mapCacheMode === "off"}
                        value={settings.mapCacheMinZoom}
                        onChange={(event) => {
                            const v = event.target.valueAsNumber;
                            if (Number.isFinite(v)) settings.set("mapCacheMinZoom", clampedInt(v, MIN_MAP_CACHE_ZOOM, settings.mapCacheMaxZoom));
                        }}
                        className="w-14 border-b border-border-strong bg-layer-02 px-2 py-1 text-center font-mono text-body text-text-primary disabled:text-text-disabled"
                    />
                    to
                    <input
                        type="number"
                        min={settings.mapCacheMinZoom}
                        max={MAX_MAP_CACHE_ZOOM}
                        step={1}
                        disabled={settings.mapCacheMode === "off"}
                        value={settings.mapCacheMaxZoom}
                        onChange={(event) => {
                            const v = event.target.valueAsNumber;
                            if (Number.isFinite(v)) settings.set("mapCacheMaxZoom", clampedInt(v, settings.mapCacheMinZoom, MAX_MAP_CACHE_ZOOM));
                        }}
                        className="w-14 border-b border-border-strong bg-layer-02 px-2 py-1 text-center font-mono text-body text-text-primary disabled:text-text-disabled"
                    />
                </div>
                <p className="text-label text-text-helper">
                    Tiles outside this range are always fetched fresh, never cached.
                </p>

                <div className="flex flex-col gap-1">
                    <span className="text-body text-text-secondary">Cache these sources</span>
                    <div className="flex flex-wrap gap-x-4 gap-y-1">
                        {MAP_CACHE_PROVIDER_OPTIONS.map((opt) => (
                            <label key={opt.key} className="flex items-center gap-2 text-label text-text-secondary">
                                <input
                                    type="checkbox"
                                    disabled={settings.mapCacheMode === "off"}
                                    checked={settings.mapCacheProviders[opt.key]}
                                    onChange={(event) =>
                                        settings.set("mapCacheProviders", {
                                            ...settings.mapCacheProviders,
                                            [opt.key]: event.target.checked,
                                        })
                                    }
                                />
                                {opt.label}
                            </label>
                        ))}
                    </div>
                </div>

                <MapCacheUsage/>
            </section>

            <section className="flex max-w-2xl flex-col gap-1 border-t border-border-subtle pt-6">
                <h2 className="text-heading text-text-primary">Airspace</h2>
                <p className="pb-2 text-label text-text-helper">
                    Controlled airspace drawn over the map, from the FAA NASR cycle.
                </p>
                {AIRSPACE_CLASSES.map((definition) => (
                    <AirspaceClassRow
                        key={definition.id}
                        id={definition.id}
                        label={definition.label}
                        value={settings.airspace[definition.id]}
                        defaultColor={resolveToken(definition.colorToken)}
                        onChange={(patch) => updateAirspace(definition.id, patch)}
                    />
                ))}
            </section>
        </div>
    );
}

function PanelsSettings({settings}: {settings: SettingsApi}) {
    return (
        <div className="flex flex-col gap-8">
            <section className="flex flex-col gap-2">
                <h2 className="text-heading text-text-primary">Console</h2>
                <label className="flex items-center gap-2 text-body text-text-secondary">
                    Collapse a repeated line after
                    <input
                        type="number"
                        min={MIN_CONSOLE_COLLAPSE_THRESHOLD}
                        step={1}
                        value={settings.consoleCollapseThreshold}
                        onChange={(event) => {
                            const value = event.target.valueAsNumber;
                            if (Number.isFinite(value)) {
                                settings.set(
                                    "consoleCollapseThreshold",
                                    Math.max(MIN_CONSOLE_COLLAPSE_THRESHOLD, Math.round(value)),
                                );
                            }
                        }}
                        className="w-16 border-b border-border-strong bg-layer-02 px-2 py-1 text-center font-mono text-body text-text-primary"
                    />
                    repeats
                </label>
                <p className="text-label text-text-helper">
                    Below that, every occurrence is shown as its own line. The repeat that crosses
                    this count folds all of them into one with a running ×N count instead of piling
                    up.
                </p>
            </section>

            <section className="flex flex-col gap-2 border-t border-border-subtle pt-6">
                <h2 className="text-heading text-text-primary">Telemetry</h2>
                <label className="flex items-center gap-2 text-body text-text-secondary">
                    <input
                        type="checkbox"
                        checked={settings.telemetrySparklines}
                        onChange={(event) => settings.set("telemetrySparklines", event.target.checked)}
                    />
                    Show sparklines on telemetry rows
                </label>
                <p className="text-label text-text-helper">
                    Trailing trend charts on voltage, vibration, packet loss, and RSSI. Turn off if
                    you find them distracting.
                </p>
            </section>
        </div>
    );
}

const CATEGORY_COMPONENTS: Record<string, SettingsCategoryComponent> = {
    connection: ConnectionSettings,
    display: DisplaySettings,
    panels: PanelsSettings,
};

export function SettingsCategoryBody({id, settings}: {id: string; settings: SettingsApi}) {
    const Component = CATEGORY_COMPONENTS[id];
    return Component ? <Component settings={settings}/> : null;
}
