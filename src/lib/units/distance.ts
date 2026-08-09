/**
 * Ground-distance unit conversion + display, mirroring `units/speed.ts` and
 * `units/altitude.ts` — one operator preference (`settings.distanceUnit`)
 * applied to every horizontal distance the backend reports: distance to
 * home, distance to the current waypoint, cross-track error, and the
 * mission editor's route-distance stat. The backend always speaks meters;
 * conversion is a frontend-only presentation concern.
 *
 * No tape widget uses this (unlike speed/altitude) — it's plain text
 * everywhere it appears.
 */

export type DistanceUnit = "m" | "ft" | "km" | "mi" | "nmi";

export interface DistanceUnitDef {
    value: DistanceUnit;
    label: string;
    suffix: string;
    fromMeters: (m: number) => number;
    /** Chosen per unit so a small value (cross-track error, a few meters)
     * still reads as more than "0.00" once converted to a unit as coarse as
     * km/mi. */
    decimals: number;
}

export const DISTANCE_UNITS: DistanceUnitDef[] = [
    {value: "m", label: "Meters", suffix: "m", fromMeters: (v) => v, decimals: 1},
    {value: "ft", label: "Feet", suffix: "ft", fromMeters: (v) => v * 3.2808398950131, decimals: 1},
    {value: "km", label: "Kilometers", suffix: "km", fromMeters: (v) => v / 1000, decimals: 3},
    {value: "mi", label: "Miles", suffix: "mi", fromMeters: (v) => v / 1609.344, decimals: 3},
    {value: "nmi", label: "Nautical miles", suffix: "nmi", fromMeters: (v) => v / 1852, decimals: 3},
];

const BY_VALUE: Record<DistanceUnit, DistanceUnitDef> = Object.fromEntries(
    DISTANCE_UNITS.map((u) => [u.value, u]),
) as Record<DistanceUnit, DistanceUnitDef>;

export function distanceUnitDef(unit: DistanceUnit): DistanceUnitDef {
    return BY_VALUE[unit];
}

export function convertDistance(meters: number, unit: DistanceUnit): number {
    return BY_VALUE[unit].fromMeters(meters);
}

export function formatDistance(meters: number | null, unit: DistanceUnit): string {
    if (meters === null) return "—";
    const def = BY_VALUE[unit];
    return `${def.fromMeters(meters).toFixed(def.decimals)}${def.suffix}`;
}
