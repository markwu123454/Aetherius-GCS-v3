import {ReactElement} from "react";
import {DisplayMode} from "./settings";
import {SettingsApi} from "./useSettings";

export type SettingsCategoryComponent = (props: {settings: SettingsApi}) => ReactElement;

function ConnectionSettings({settings}: {settings: SettingsApi}) {
    return (
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
    );
}

const DISPLAY_MODES: {value: DisplayMode; label: string}[] = [
    {value: "windowed", label: "Windowed"},
    {value: "borderless", label: "Borderless"},
    {value: "fullscreen", label: "Full screen"},
];

function DisplaySettings({settings}: {settings: SettingsApi}) {
    return (
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
        </section>
    );
}

const CATEGORY_COMPONENTS: Record<string, SettingsCategoryComponent> = {
    connection: ConnectionSettings,
    display: DisplaySettings,
};

export function SettingsCategoryBody({id, settings}: {id: string; settings: SettingsApi}) {
    const Component = CATEGORY_COMPONENTS[id];
    return Component ? <Component settings={settings}/> : null;
}
