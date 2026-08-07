/** Every full-screen page the app can navigate to, by id. */
export type PageId =
    | "firmware"
    | "calibration"
    | "setup"
    | "parameters"
    | "scripting"
    | "logs"
    | "mission"
    | "geofence"
    | "settings"
    | "about";

export const PAGE_TITLES: Record<PageId, string> = {
    firmware: "Firmware",
    calibration: "Calibration",
    setup: "Setup",
    parameters: "Parameters",
    scripting: "Scripting",
    logs: "Logs",
    mission: "Mission",
    geofence: "Geofence",
    settings: "Settings",
    about: "About",
};
