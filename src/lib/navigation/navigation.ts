/** Every full-screen page the app can navigate to, by id. */
export type PageId = "settings" | "parameters" | "mission";

export const PAGE_TITLES: Record<PageId, string> = {
    settings: "Settings",
    parameters: "Parameters",
    mission: "Mission",
};
