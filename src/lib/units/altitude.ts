/**
 * Altitude unit conversion + display, mirroring `units/speed.ts` — one
 * operator preference (`settings.altitudeUnit`) applied to every altitude
 * the backend reports (position altitude, the PFD's ALT tape). The backend
 * always speaks meters; conversion is a frontend-only presentation concern.
 *
 * Deliberately NOT applied to editable altitude fields tied to a specific
 * wire unit — the mission waypoint altitude (`Waypoint.altitude`, meters on
 * the wire), the Takeoff command's climb altitude, and `FENCE_ALT_MAX`/
 * `FENCE_ALT_MIN` (raw vehicle parameters, always meters). Same reasoning as
 * speed: no silent round-trip conversion on a value that gets sent back to
 * the vehicle.
 */

export type AltitudeUnit = "m" | "ft";

export interface AltitudeUnitDef {
    value: AltitudeUnit;
    label: string;
    suffix: string;
    fromMeters: (m: number) => number;
    decimals: number;
    /** PFD altitude tape: spacing between ticks, in this unit. */
    tapeTick: number;
    /** PFD altitude tape: every Nth tick (by value) is major/labeled. */
    tapeMajorEvery: number;
    /** PFD altitude tape: value at the top/bottom edge of the tape, in this
     * unit — chosen per unit to land close to the original ±25 m window. */
    tapeHalfRange: number;
    tapeTickDecimals: number;
}

export const ALTITUDE_UNITS: AltitudeUnitDef[] = [
    {
        value: "m",
        label: "Meters",
        suffix: "m",
        fromMeters: (v) => v,
        decimals: 1,
        tapeTick: 5,
        tapeMajorEvery: 10,
        tapeHalfRange: 25,
        tapeTickDecimals: 0,
    },
    {
        value: "ft",
        label: "Feet",
        suffix: "ft",
        fromMeters: (v) => v * 3.2808398950131,
        decimals: 0,
        tapeTick: 20,
        tapeMajorEvery: 100,
        tapeHalfRange: 80,
        tapeTickDecimals: 0,
    },
];

const BY_VALUE: Record<AltitudeUnit, AltitudeUnitDef> = Object.fromEntries(
    ALTITUDE_UNITS.map((u) => [u.value, u]),
) as Record<AltitudeUnit, AltitudeUnitDef>;

export function altitudeUnitDef(unit: AltitudeUnit): AltitudeUnitDef {
    return BY_VALUE[unit];
}

export function convertAltitude(meters: number, unit: AltitudeUnit): number {
    return BY_VALUE[unit].fromMeters(meters);
}

export function formatAltitude(meters: number | null, unit: AltitudeUnit): string {
    if (meters === null) return "—";
    const def = BY_VALUE[unit];
    return `${def.fromMeters(meters).toFixed(def.decimals)}${def.suffix}`;
}
