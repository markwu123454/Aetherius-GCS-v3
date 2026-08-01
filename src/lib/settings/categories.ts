export interface SettingsCategory {
    id: string;
    label: string;
}

/** Left-nav order on the Settings page. Add a category here, then a matching
 * entry in `categoryComponents.tsx` — nothing else needs to know about it. */
export const SETTINGS_CATEGORIES: SettingsCategory[] = [
    {id: "connection", label: "Connection"},
    {id: "display", label: "Display"},
    {id: "console", label: "Console"},
    {id: "airspace", label: "Airspace"},
];
