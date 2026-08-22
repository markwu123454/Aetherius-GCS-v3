/** Every full-screen page the app can navigate to, by id. */
export type PageId =
    | "firmware"
    | "calibration"
    | "setup"
    | "parameters"
    | "scripting"
    | "logs"
    | "logAnalysis"
    | "mission"
    | "geofence"
    | "rally"
    | "settings"
    | "about"
    | "inspector"
    | "sdcardLogs"
    | "sdcardScripting";

export const PAGE_TITLES: Record<PageId, string> = {
    firmware: "Firmware",
    calibration: "Calibration",
    setup: "Setup",
    parameters: "Parameters",
    scripting: "Scripting",
    logs: "Logs",
    logAnalysis: "Log Analysis",
    mission: "Mission",
    geofence: "Geofence",
    rally: "Rally Points",
    settings: "Settings",
    about: "About",
    inspector: "MAVLink Inspector",
    sdcardLogs: "SD Card – Logs",
    sdcardScripting: "SD Card – Scripts",
};

/** Where `closePage` lands instead of the bare workspace, for pages that
 * are conceptually nested under another page even though they're just
 * another flat `PageId` like any other — no page stack, just a per-page
 * override of "back"'s default target. Absent from this table means back
 * goes to the workspace, same as every page today. */
export const PAGE_BACK_TARGET: Partial<Record<PageId, PageId>> = {
    logAnalysis: "logs",
};
