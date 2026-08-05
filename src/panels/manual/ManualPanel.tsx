/**
 * Manual flight panel — PFD (attitude, speed, altitude) and RC input monitor.
 *
 * Layout by dock position (see `area` prop):
 *
 * Bottom dock (horizontal): PFD and RC monitor sit side by side, each filling
 * an equal share of the width. Both instruments maintain their own fixed
 * aspect ratio and scale to the largest size that fits their cell.
 *
 * Side dock (vertical): PFD and RC monitor are stacked, each filling an equal
 * share of the height. Same aspect-ratio scaling applies.
 */

import {useConnection} from "@/lib/vehicle/useConnection.ts";
import {isLinkIdle} from "@/lib/vehicle/connection.ts";
import {useVehicle} from "@/lib/vehicle/useVehicle.ts";
import {PanelArea} from "@/panels/panelComponents.tsx";
import Pfd from "./Pfd.tsx";
import JoystickDisplay from "./JoystickDisplay.tsx";

export default function ManualPanel({area}: {area: PanelArea}) {
    const vehicle = useVehicle();
    const connection = useConnection();

    const unknown = isLinkIdle(connection.status) || vehicle.updatedAt === 0;

    const heading = vehicle.position?.heading ?? 0;
    const alt = vehicle.position?.alt ?? null;
    const roll = vehicle.attitude?.roll ?? 0;
    const pitch = vehicle.attitude?.pitch ?? 0;
    const attitudeUnknown = vehicle.attitude === null;

    const horizontal = area === "bottom";

    return (
        <div className={`h-full bg-background p-3 grid ${horizontal ? "grid-cols-2 grid-rows-1" : "grid-rows-2 grid-cols-1"}`}>
            <Pfd heading={heading} roll={roll} pitch={pitch} unknown={unknown} attitudeUnknown={attitudeUnknown} groundspeed={vehicle.groundspeed} alt={alt}/>
            <JoystickDisplay/>
        </div>
    );
}
