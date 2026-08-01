import {useConnection} from "@/lib/vehicle/useConnection.ts";
import {isLinkIdle} from "@/lib/vehicle/connection.ts";
import {useVehicle} from "@/lib/vehicle/useVehicle.ts";
import {useNow} from "@/lib/vehicle/useMockVehicle.ts";
import {PrearmReason} from "@/lib/vehicle/vehicle.ts";
import {TONE_TEXT} from "@/components/topmenu/StatusChip.tsx";

function ReasonRow({reason, now}: {reason: PrearmReason; now: number}) {
    const age = Math.max(0, Math.round((now - reason.lastSeen) / 1000));
    return (
        <div className="flex items-start justify-between gap-2 border-b border-border-subtle/40 px-2 py-1.5 last:border-b-0">
            <span className={`text-label ${TONE_TEXT.danger}`}>{reason.text}</span>
            <span className="shrink-0 text-micro text-text-helper tabular-nums">{age}s ago</span>
        </div>
    );
}

/**
 * Shows ArduPilot's own `PreArm:` reasons — the actual output of its arming
 * logic — rather than any GCS-side reinterpretation of them. `SYS_STATUS`'s
 * per-sensor bitmask was considered for a second "Checks" section here, but
 * it answers a different question ("is this sensor chip alive") than arming
 * does ("do the checks pass"), and the two can visibly disagree — an
 * accelerometer can be healthy while still failing an inter-sensor
 * consistency check. Showing only the real reasons avoids that contradiction.
 */
export default function PrearmPanel() {
    const vehicle = useVehicle();
    const connection = useConnection();
    const now = useNow();

    const unknown = isLinkIdle(connection.status) || vehicle.updatedAt === 0;

    return (
        <div className="@container flex h-full min-h-0 w-full flex-col overflow-auto bg-background">
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-subtle px-3 py-2">
                <span className="text-micro text-text-helper uppercase">Prearm</span>
                <span
                    className={[
                        "border px-1.5 py-0.5 text-micro uppercase",
                        unknown
                            ? "border-border-subtle text-text-helper"
                            : vehicle.prearmPass
                              ? "border-state-ok text-state-ok"
                              : "border-state-danger text-state-danger",
                    ].join(" ")}
                >
                    {unknown ? "Unknown" : vehicle.prearmPass ? "Ready to arm" : "Not ready"}
                </span>
                {/* Backend re-triggers MAV_CMD_RUN_PREARM_CHECKS on its own timer
                    as long as a vehicle is connected — nothing here has to ask
                    for it, only display what comes back. */}
                <span className="ml-auto text-micro text-text-helper">Rechecked automatically</span>
            </div>

            <div className="min-h-0 flex-1 overflow-auto border border-border-subtle bg-layer-01 m-3">
                {vehicle.prearmReasons.length === 0 ? (
                    <div className="p-2 text-label text-text-helper">
                        {unknown ? "—" : "No failures reported."}
                    </div>
                ) : (
                    vehicle.prearmReasons.map((reason) => (
                        <ReasonRow key={reason.text} reason={reason} now={now} />
                    ))
                )}
            </div>
        </div>
    );
}
