/**
 * Horizontal speed unit conversion + display, for a single operator-facing
 * preference (`settings.speedUnit`) applied to every horizontal speed the
 * backend reports — groundspeed, airspeed, wind speed. The backend itself
 * always speaks m/s (see DESIGN.md's backend/frontend split); conversion is
 * a frontend-only presentation concern.
 *
 * Climb rate (vertical speed) is deliberately a separate preference — see
 * units/verticalSpeed.ts — since aviation instruments conventionally show it
 * in a different unit (ft/min) than horizontal speed even when the rest of
 * the panel is in knots or km/h; they're treated as different quantities,
 * not the same one read two ways.
 *
 * The unit list itself is deliberately short: m/s, km/h, mph, and knots are
 * the four units an actual speedometer or GCS offers. Units with no
 * real-world convention behind them (km/min, and ft/s as a *horizontal*
 * speed) were considered and dropped rather than included just because a
 * unit conversion exists for them.
 *
 * Deliberately NOT applied to editable speed fields tied to a specific wire
 * unit — the mission waypoint speed override (`Waypoint.speed`, m/s on the
 * wire) and `TRIM_ARSPD_CM` in the Trim setup panel (a raw vehicle
 * parameter). Those stay in m/s with an explicit label so what's typed is
 * exactly what gets sent, with no round-trip conversion to introduce drift.
 */

export type SpeedUnit = "mps" | "kmh" | "mph" | "kt";

export interface SpeedUnitDef {
    value: SpeedUnit;
    /** Full name for the settings dropdown. */
    label: string;
    /** Short abbreviation appended directly to a formatted value, no space —
     * matches the existing `${n.toFixed(1)}m/s` convention. */
    suffix: string;
    fromMps: (mps: number) => number;
    /** Decimal places for both the tape's center readout and inline text. */
    decimals: number;
    /** PFD speed tape: spacing between ticks, in this unit. */
    tapeTick: number;
    /** PFD speed tape: every Nth tick (by value, not index) is major/labeled. */
    tapeMajorEvery: number;
    /** PFD speed tape: value at the top/bottom edge of the tape, in this
     * unit — chosen per unit to land close to the original ±6 m/s window
     * rather than sharing one raw range across units with wildly different
     * magnitudes. */
    tapeHalfRange: number;
    /** Decimal places for the tape's own tick labels — separate from
     * `decimals` (the center readout) in case a future unit's
     * `tapeMajorEvery` isn't a whole number; every current unit's is. */
    tapeTickDecimals: number;
}

export const SPEED_UNITS: SpeedUnitDef[] = [
    {
        value: "mps",
        label: "Meters per second",
        suffix: "m/s",
        fromMps: (v) => v,
        decimals: 1,
        tapeTick: 1,
        tapeMajorEvery: 2,
        tapeHalfRange: 6,
        tapeTickDecimals: 0,
    },
    {
        value: "kmh",
        label: "Kilometers per hour",
        suffix: "km/h",
        fromMps: (v) => v * 3.6,
        decimals: 1,
        tapeTick: 5,
        tapeMajorEvery: 10,
        tapeHalfRange: 25,
        tapeTickDecimals: 0,
    },
    {
        value: "mph",
        label: "Miles per hour",
        suffix: "mph",
        fromMps: (v) => v * 2.2369362920544,
        decimals: 1,
        tapeTick: 2,
        tapeMajorEvery: 10,
        tapeHalfRange: 14,
        tapeTickDecimals: 0,
    },
    {
        value: "kt",
        label: "Knots",
        suffix: "kt",
        fromMps: (v) => v * 1.9438444924406,
        decimals: 1,
        tapeTick: 2,
        tapeMajorEvery: 10,
        tapeHalfRange: 12,
        tapeTickDecimals: 0,
    },
];

const BY_VALUE: Record<SpeedUnit, SpeedUnitDef> = Object.fromEntries(
    SPEED_UNITS.map((u) => [u.value, u]),
) as Record<SpeedUnit, SpeedUnitDef>;

export function speedUnitDef(unit: SpeedUnit): SpeedUnitDef {
    return BY_VALUE[unit];
}

export function convertSpeed(mps: number, unit: SpeedUnit): number {
    return BY_VALUE[unit].fromMps(mps);
}

/** `null` in, `"—"` out — same "don't fake precision" convention every other
 * telemetry readout in the app follows for a value that hasn't arrived yet. */
export function formatSpeed(mps: number | null, unit: SpeedUnit): string {
    if (mps === null) return "—";
    const def = BY_VALUE[unit];
    return `${def.fromMps(mps).toFixed(def.decimals)}${def.suffix}`;
}
