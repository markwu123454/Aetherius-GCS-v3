/**
 * Manual flight panel — PFD (attitude, speed, altitude), a numeric readout,
 * and RC input monitor.
 *
 * Layout by dock position (see `area` prop):
 *
 * Bottom dock (horizontal): PFD, readout and RC monitor sit side by side. The
 * two instruments split the width left over once the readout has taken its
 * own natural width between them. Both maintain their own fixed aspect ratio
 * and scale to the largest size that fits their cell.
 *
 * Side dock (vertical): the same three stacked, the instruments splitting the
 * height left over around the readout. Same aspect-ratio scaling applies.
 */

import {useConnection} from "@/lib/vehicle/useConnection.ts";
import {isLinkFailing, isLinkIdle} from "@/lib/vehicle/connection.ts";
import {useVehicle} from "@/lib/vehicle/useVehicle.ts";
import {PanelArea} from "@/panels/panelComponents.tsx";
import Pfd from "./Pfd.tsx";
import ManualReadout from "./ManualReadout.tsx";
import JoystickDisplay from "./JoystickDisplay.tsx";

export default function ManualPanel({area}: {area: PanelArea}) {
    const vehicle = useVehicle();
    const connection = useConnection();

    const unknown = isLinkIdle(connection.status) || vehicle.updatedAt === 0;
    const stale = isLinkFailing(connection.status);

    const heading = vehicle.position?.heading ?? 0;
    const alt = vehicle.position?.alt ?? null;
    const roll = vehicle.attitude?.roll ?? 0;
    const pitch = vehicle.attitude?.pitch ?? 0;
    const attitudeUnknown = vehicle.attitude === null;

    const horizontal = area === "bottom";

    return (
        <div
            className={`@container grid h-full gap-3 bg-background p-3 ${
                horizontal
                    ? "grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] grid-rows-1"
                    : "grid-cols-1 grid-rows-[minmax(0,1fr)_auto_minmax(0,1fr)]"
            }`}
        >
            <Pfd heading={heading} roll={roll} pitch={pitch} unknown={unknown} attitudeUnknown={attitudeUnknown} groundspeed={vehicle.groundspeed} alt={alt}/>
            <ManualReadout vehicle={vehicle} unknown={unknown} stale={stale} horizontal={horizontal}/>
            <JoystickDisplay/>
        </div>
    );
}
