/**
 * Vertical speed (climb rate) unit conversion + display — a separate
 * preference from `units/speed.ts`'s horizontal `speedUnit`, since real
 * aviation instruments show vertical speed in a different unit (ft/min)
 * than horizontal speed even when the panel is otherwise in knots or km/h.
 * Only two units exist in practice: metric m/s, and ft/min (the unit every
 * vertical speed indicator uses). No tape widget uses this — it's plain
 * text in the Telemetry panel's Climb row.
 */

export type VerticalSpeedUnit = "mps" | "ftMin";

export interface VerticalSpeedUnitDef {
    value: VerticalSpeedUnit;
    label: string;
    suffix: string;
    fromMps: (mps: number) => number;
    decimals: number;
}

export const VERTICAL_SPEED_UNITS: VerticalSpeedUnitDef[] = [
    {value: "mps", label: "Meters per second", suffix: "m/s", fromMps: (v) => v, decimals: 1},
    {value: "ftMin", label: "Feet per minute", suffix: "ft/min", fromMps: (v) => v * 196.850393701, decimals: 0},
];

const BY_VALUE: Record<VerticalSpeedUnit, VerticalSpeedUnitDef> = Object.fromEntries(
    VERTICAL_SPEED_UNITS.map((u) => [u.value, u]),
) as Record<VerticalSpeedUnit, VerticalSpeedUnitDef>;

export function verticalSpeedUnitDef(unit: VerticalSpeedUnit): VerticalSpeedUnitDef {
    return BY_VALUE[unit];
}

export function formatVerticalSpeed(mps: number | null, unit: VerticalSpeedUnit): string {
    if (mps === null) return "—";
    const def = BY_VALUE[unit];
    return `${def.fromMps(mps).toFixed(def.decimals)}${def.suffix}`;
}
