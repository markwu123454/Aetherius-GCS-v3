export type CheckCondition =
    | { type: "connected" }
    | { type: "disconnected" }
    | { type: "armed" }
    | { type: "disarmed" }
    | { type: "mode"; value: string }
    | { type: "gps_fix_min"; value: number }
    | { type: "battery_above"; value: number }
    | { type: "battery_below"; value: number }
    | { type: "prearm_pass" }
    | { type: "vehicle_kind"; value: "plane" | "multirotor" | "other" };

export interface ChecklistItem {
    id: string;
    text: string;
    checked: boolean;
    /** When this condition is true the item is automatically checked and locked. */
    autoCheck?: CheckCondition | null;
    /** When this condition is true the item is automatically unchecked and locked. */
    autoUncheck?: CheckCondition | null;
}

export interface ChecklistFile {
    version: 1;
    name: string;
    items: ChecklistItem[];
}
