export type VehicleFirmware = "ArduCopter" | "ArduPlane";

export const VEHICLE_FIRMWARES: VehicleFirmware[] = ["ArduCopter", "ArduPlane"];

/**
 * Sentinel group key meaning "every group" — never a real one, since
 * ArduPilot's own `<parameters name="...">` blocks are always identifier-like
 * prefixes such as `COMPASS_` or the bare vehicle name.
 */
export const ALL_GROUPS_KEY = "*";

export interface ParamOption {
    value: number;
    label: string;
}

/**
 * One documented parameter, as published in ArduPilot's own `apm.pdef.xml`.
 * This is reference metadata only — `range`/`values`/etc. describe what the
 * firmware accepts, not what a connected vehicle currently has set.
 */
export interface ParamDef {
    name: string;
    humanName: string;
    description: string;
    user: "Standard" | "Advanced";
    units?: string;
    unitText?: string;
    range?: [number, number];
    increment?: number;
    /** Named meanings for specific values, e.g. `RTL_ALT_TYPE`'s 0/1. */
    values?: ParamOption[];
    /** Named meanings for individual bits, e.g. `SUPER_SIMPLE`'s switch mask. */
    bitmask?: ParamOption[];
    readOnly?: boolean;
    rebootRequired?: boolean;
    volatile?: boolean;
    calibration?: boolean;
}

/**
 * One `<parameters name="...">` block from the pdef file — ArduPilot's own
 * subsystem grouping (`COMPASS_`, `RC1_`, the vehicle's own top-level block),
 * not a taxonomy invented on this side.
 */
export interface ParamGroup {
    key: string;
    params: ParamDef[];
}

export interface ParamSheet {
    vehicle: VehicleFirmware;
    source: string;
    fetchedAt: string;
    groups: ParamGroup[];
}

/** `"COMPASS_"` reads better in a nav list as `"COMPASS"`. */
export function groupLabel(key: string): string {
    return key.endsWith("_") ? key.slice(0, -1) : key;
}

const cache = new Map<VehicleFirmware, Promise<ParamSheet>>();

/**
 * Fetched from `public/params/`, not bundled — each sheet is ~2MB of mostly
 * English description text, not worth shipping in the main JS chunk when most
 * sessions never open this page.
 */
export function loadParamSheet(vehicle: VehicleFirmware): Promise<ParamSheet> {
    let pending = cache.get(vehicle);
    if (!pending) {
        pending = fetch(`/params/${vehicle}.json`).then((response) => {
            if (!response.ok) {
                throw new Error(`could not load ${vehicle} parameter sheet (${response.status})`);
            }
            return response.json() as Promise<ParamSheet>;
        });
        cache.set(vehicle, pending);
    }
    return pending;
}

export interface ParamMatch {
    group: string;
    param: ParamDef;
}

interface SearchIndexEntry {
    match: ParamMatch;
    nameLower: string;
    humanNameLower: string;
}

/** One flat, lowercased entry per parameter, built once per sheet and kept
 * for the sheet's lifetime — a ~5000-parameter sheet otherwise re-runs
 * `toLowerCase()` on every name and human name on every single keystroke in
 * the search box, which is most of where that lag actually comes from
 * (`.includes()` on an already-lowercased string is cheap by comparison). */
const searchIndexCache = new WeakMap<ParamSheet, SearchIndexEntry[]>();

function getSearchIndex(sheet: ParamSheet): SearchIndexEntry[] {
    let index = searchIndexCache.get(sheet);
    if (!index) {
        index = [];
        for (const group of sheet.groups) {
            for (const param of group.params) {
                index.push({
                    match: {group: group.key, param},
                    nameLower: param.name.toLowerCase(),
                    humanNameLower: param.humanName.toLowerCase(),
                });
            }
        }
        searchIndexCache.set(sheet, index);
    }
    return index;
}

/** Substring match against both the code name and the human-readable name. */
export function searchParams(sheet: ParamSheet, query: string): ParamMatch[] {
    const q = query.trim().toLowerCase();
    if (!q) {
        return [];
    }

    const matches: ParamMatch[] = [];
    for (const entry of getSearchIndex(sheet)) {
        if (entry.nameLower.includes(q) || entry.humanNameLower.includes(q)) {
            matches.push(entry.match);
        }
    }
    return matches;
}
