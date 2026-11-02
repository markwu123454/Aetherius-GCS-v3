import {useSettings} from "@/lib/settings/useSettings.ts";
import {formatAltitude} from "@/lib/units/altitude.ts";
import {formatVerticalSpeed} from "@/lib/units/verticalSpeed.ts";
import type {VehicleState} from "@/lib/vehicle/vehicle.ts";

function degrees(value: number | null | undefined): string {
    return value == null ? "—" : `${Math.round(value)}°`;
}

/** Zero-padded to three digits, the way a compass heading is read out. */
function heading(value: number | null | undefined): string {
    if (value == null) {
        return "—";
    }
    const wrapped = ((Math.round(value) % 360) + 360) % 360;
    return `${wrapped.toString().padStart(3, "0")}°`;
}

/**
 * The numbers behind the two instruments either side of it — attitude,
 * heading, throttle output, altitude and climb — for when the exact value
 * matters more than the picture. Cell widths never follow their values, so a
 * sign appearing or a digit more doesn't shuffle the grid while flying.
 *
 * `horizontal` is the panel's own orientation. Side by side in a bottom dock
 * puts this in a tall, narrow slot: two fixed-width columns, left out entirely
 * (against `ManualPanel`'s `@container`) when the dock is too narrow to fit
 * them beside both instruments rather than squeezing those down to nothing —
 * they're what the panel is for. Stacked in a side dock it's a wide, short
 * slot: three columns sharing the dock's width.
 */
export default function ManualReadout({vehicle, unknown, stale, horizontal}: {
    vehicle: VehicleState;
    /** Nothing reported yet — every value reads as "—". */
    unknown: boolean;
    /** The link has gone quiet — values are kept but dimmed. */
    stale: boolean;
    horizontal: boolean;
}) {
    const {altitudeUnit, verticalSpeedUnit} = useSettings();

    const cells: [string, string][] = [
        ["Roll", degrees(vehicle.attitude?.roll)],
        ["Pitch", degrees(vehicle.attitude?.pitch)],
        ["Hdg", heading(vehicle.position?.heading ?? vehicle.attitude?.yaw)],
        ["Thr", vehicle.throttle === null ? "—" : `${vehicle.throttle}%`],
        ["Alt", formatAltitude(vehicle.position?.alt ?? null, altitudeUnit)],
        ["Climb", formatVerticalSpeed(vehicle.climbRate, verticalSpeedUnit)],
    ];

    return (
        <div
            className={`gap-2 self-center justify-self-center ${
                horizontal
                    ? "hidden grid-cols-[repeat(2,5.5rem)] @min-[34rem]:grid"
                    : "grid w-full max-w-[18rem] grid-cols-3"
            }`}
        >
            {cells.map(([label, value]) => (
                <div key={label} className="flex flex-col items-center border border-border-subtle bg-layer-01 py-1">
                    <span className="text-micro text-text-helper uppercase">{label}</span>
                    <span className={`font-mono text-label tabular-nums ${stale ? "text-text-helper" : "text-text-primary"}`}>
                        {unknown ? "—" : value}
                    </span>
                </div>
            ))}
        </div>
    );
}
