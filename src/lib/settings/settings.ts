import {DEFAULT_AIRSPACE_SETTINGS, type AirspaceSettings} from "@/lib/airspace/classes.ts";

export type DisplayMode = "windowed" | "borderless" | "fullscreen";

/**
 * App preferences — how the operator wants the GCS to behave. Distinct from
 * vehicle parameters: these never touch the wire, and the vehicle has no
 * opinion about them.
 */
export interface Settings {
    /** Require a second click before disconnecting a link to an armed vehicle. */
    confirmDisconnectWhenArmed: boolean;
    displayMode: DisplayMode;
    /** Per-class airspace presentation. The single source of truth for which
     * layers are drawn — the View menu writes here too, rather than keeping its
     * own idea of what is switched on. */
    airspace: AirspaceSettings;
}

export const DEFAULT_SETTINGS: Settings = {
    confirmDisconnectWhenArmed: true,
    displayMode: "windowed",
    airspace: DEFAULT_AIRSPACE_SETTINGS,
};
