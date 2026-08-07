import {LiveParamEntry} from "./liveParams.ts";
import {ParamDef, ParamGroup} from "./paramSheet.ts";

export interface ParamFileEntry {
    name: string;
    value: number;
}

const CHANGE_TOLERANCE = 1e-6;

/**
 * Serializes live parameter values as the de facto ArduPilot `.param` format
 * (`NAME,VALUE` per line) shared by Mission Planner, QGroundControl, and
 * MAVProxy — a file saved here loads cleanly in any of them, and vice versa.
 * Sorted by name and written at full precision; the rounding
 * `formatParamValue` applies for the on-screen table is lossy and wrong for
 * a file meant to be reloaded exactly.
 */
export function serializeParamFile(values: Map<string, LiveParamEntry>, firmware: string): string {
    const lines = [`# Aetherius GCS — ${firmware} — ${new Date().toISOString()}`];
    for (const name of [...values.keys()].sort()) {
        lines.push(`${name},${values.get(name)!.value}`);
    }
    return lines.join("\n") + "\n";
}

/**
 * Parses a `.param` file. Blank lines and `#`-prefixed comments (including a
 * Mission-Planner-style `FORMAT VERSION` line) are skipped. A malformed line
 * is skipped rather than aborting the whole parse — a hand-edited or
 * partially-corrupt file shouldn't lose the rest of a load over one bad line.
 */
export function parseParamFile(text: string): ParamFileEntry[] {
    const entries: ParamFileEntry[] = [];
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const [name, rawValue] = line.split(",").map((s) => s.trim());
        if (!name || rawValue === undefined || rawValue === "") continue;
        const value = Number(rawValue);
        if (Number.isNaN(value)) continue;
        entries.push({name, value});
    }
    return entries;
}

export type ParamDiffStatus = "changed" | "unrecognized" | "unchanged";

export interface ParamDiffRow {
    name: string;
    fileValue: number;
    liveValue: number | undefined;
    /** Documentation for this name from the connected firmware's param
     * sheet, when available — `null` doesn't mean anything is wrong with the
     * row, just that no flags/units can be shown for it. */
    def: ParamDef | null;
    status: ParamDiffStatus;
}

function flatParamIndex(groups: ParamGroup[]): Map<string, ParamDef> {
    const index = new Map<string, ParamDef>();
    for (const group of groups) {
        for (const param of group.params) {
            index.set(param.name, param);
        }
    }
    return index;
}

/**
 * Diffs a parsed file against the vehicle's current live values. `groups` is
 * the connected firmware's documented param sheet (`null` if it hasn't
 * loaded yet), used only to attach flags (`readOnly`/`calibration`/
 * `rebootRequired`) for display — a name missing from it still diffs fine,
 * it just shows no flags.
 *
 * "Unrecognized" means the *vehicle* never reported this name (absent from
 * `live`), not that the reference sheet doesn't document it — that's the
 * real signal that a file doesn't belong to this vehicle, e.g. a Plane file
 * loaded onto a Copter.
 */
export function buildParamDiff(
    fileEntries: ParamFileEntry[],
    live: Map<string, LiveParamEntry>,
    groups: ParamGroup[] | null,
): ParamDiffRow[] {
    const defIndex = groups ? flatParamIndex(groups) : new Map<string, ParamDef>();
    return fileEntries.map((entry): ParamDiffRow => {
        const liveEntry = live.get(entry.name);
        const def = defIndex.get(entry.name) ?? null;
        const status: ParamDiffStatus =
            liveEntry === undefined
                ? "unrecognized"
                : Math.abs(liveEntry.value - entry.value) < CHANGE_TOLERANCE
                  ? "unchanged"
                  : "changed";
        return {name: entry.name, fileValue: entry.value, liveValue: liveEntry?.value, def, status};
    });
}
