import {useConnection} from "@/lib/vehicle/useConnection.ts";
import {isLinkIdle} from "@/lib/vehicle/connection.ts";
import {useVehicle} from "@/lib/vehicle/useVehicle.ts";
import {PanelArea} from "@/panels/panelComponents.tsx";
import Pfd from "./Pfd.tsx";
import JoystickDisplay from "./JoystickDisplay.tsx";

/**
 * Flight-instrument panel — `Pfd` and `JoystickDisplay` side by side in a
 * bottom dock, stacked in a side dock. Layout is decided by `area` rather
 * than a container-query breakpoint: the dock max-width cap (see layout.ts)
 * ensures a side dock can never grow wide enough to need a row layout, so the
 * position is a reliable proxy for available space.
 *
 * Each instrument owns its own fixed aspect ratio via `FitBox` and scales
 * into whatever grid cell it's given — the grid's only job is choosing which
 * axis to split on.
 *
 * `items-stretch` on the outer wrapper gives the grid a definite height
 * (from `h-full`), which `FitBox`'s `max-h-full` needs in order to actually
 * cap against something. Without it the grid's height would be auto-sized
 * from content, making `max-h-full` inside it circular and therefore `none`.
 */
export default function ManualPanel({area}: {area: PanelArea}) {
    const vehicle = useVehicle();
    const connection = useConnection();

    const unknown = isLinkIdle(connection.status) || vehicle.updatedAt === 0;

    const heading = vehicle.position?.heading ?? 0;
    const alt = vehicle.position?.alt ?? null;
    const roll = vehicle.attitude?.roll ?? 0;
    const pitch = vehicle.attitude?.pitch ?? 0;
    const attitudeUnknown = vehicle.attitude === null;

    const row = area === "bottom";

    return (
        <div className="flex h-full min-h-0 w-full items-stretch justify-center-safe overflow-auto bg-background p-3">
            <div className={`grid ${row ? "grid-cols-2 grid-rows-1 gap-6" : "grid-cols-1 grid-rows-2 gap-4"}`}>
                <Pfd heading={heading} roll={roll} pitch={pitch} unknown={unknown} attitudeUnknown={attitudeUnknown} groundspeed={vehicle.groundspeed} alt={alt}/>
                <JoystickDisplay/>
            </div>
        </div>
    );
}
