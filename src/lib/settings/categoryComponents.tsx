import {ReactElement} from "react";
import {DisplayMode, MIN_CONSOLE_COLLAPSE_THRESHOLD, MIN_TELEM_RATE_HZ, MAX_TELEM_RATE_HZ, MIN_PREARM_CHECK_INTERVAL, MAX_PREARM_CHECK_INTERVAL} from "./settings.ts";
import {SettingsApi} from "./useSettings.ts";
import {AIRSPACE_CLASSES, type AirspaceClass, type AirspaceClassSettings} from "@/lib/airspace/classes.ts";
import {resolveToken} from "@/lib/airspace/airspace.ts";

export type SettingsCategoryComponent = (props: {settings: SettingsApi}) => ReactElement;

function clampedInt(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, Math.round(value)));
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
