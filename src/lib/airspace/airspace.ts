import type {FeatureCollection, MultiPolygon, Polygon} from "geojson";
import {expandCollection, type EncodedCollection} from "./expand";
import {airspaceDefinition, type AirspaceClass, type AirspaceClassSettings} from "./classes.ts";

export * from "./classes.ts";

export interface AirspaceManifest {
    cycle: string | null;
    format: string;
    classes: Record<string, {file: string; features: number; bytes: number; worstDeviationM: number}>;
}

export type AirspaceGeometry = FeatureCollection<Polygon | MultiPolygon>;

/**
 * Fetches one class and expands its arcs into polygons.
 *
 * A missing file is not an error: Class E is generated locally rather than
 * committed (see .gitignore), so a fresh clone legitimately has B/C/D and no E.
 * Returning null lets the UI show it as unavailable instead of the map failing
 * to load.
 */
export async function loadAirspaceClass(id: AirspaceClass): Promise<AirspaceGeometry | null> {
    const response = await fetch(`airspace/class-${id}.json`);
    if (!response.ok) return null;

    const encoded = (await response.json()) as EncodedCollection;
    return expandCollection(encoded);
}

export async function loadAirspaceManifest(): Promise<AirspaceManifest | null> {
    const response = await fetch("airspace/index.json");
    return response.ok ? ((await response.json()) as AirspaceManifest) : null;
}

/** Reads a palette token off the document. */
export function resolveToken(token: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(token).trim() || "#888888";
}

/** The colour a class should actually draw in: the operator's choice, or the
 * class's palette token when they have not made one. */
export function airspaceColor(id: AirspaceClass, settings: AirspaceClassSettings): string {
    return settings.color ?? resolveToken(airspaceDefinition(id).colorToken);
}

/** "SFC" and a null ceiling both need words rather than a bare number. */
export function describeAltitude(value: number | null, code: string | null): string {
    if (code === "SFC") return "SFC";
    if (value === null) return "—";
    return `${value.toLocaleString()} ${code ?? "MSL"}`;
}
