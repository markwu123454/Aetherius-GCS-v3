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
}

export const DEFAULT_SETTINGS: Settings = {
    confirmDisconnectWhenArmed: true,
    displayMode: "windowed",
};
