/** Every full-screen page the app can navigate to, by id. */
export type PageId = "settings" | "parameters";

export const PAGE_TITLES: Record<PageId, string> = {
    settings: "Settings",
    parameters: "Parameters",
};
