import {useConnection} from "@/lib/vehicle/useConnection.ts";
import {isLinkIdle} from "@/lib/vehicle/connection.ts";
import {usePrearmLastUpdate, useVehicle} from "@/lib/vehicle/useVehicle.ts";
import {useNow} from "@/lib/vehicle/useMockVehicle.ts";
import {PrearmReason} from "@/lib/vehicle/vehicle.ts";
import {TONE_TEXT} from "@/components/topmenu/StatusChip.tsx";

function ReasonRow({reason}: {reason: PrearmReason}) {
    return (
        <div className="border-b border-border-subtle/40 px-2 py-1.5 last:border-b-0">
            <span className={`text-label ${TONE_TEXT.danger}`}>{reason.text}</span>
        </div>
    );
}

function formatAge(seconds: number): string {
    if (seconds < 60) return `${seconds}s ago`;
    return `${Math.round(seconds / 60)}m ago`;
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
    const lastUpdate = usePrearmLastUpdate();
    const now = useNow();

    const unknown = isLinkIdle(connection.status) || vehicle.updatedAt === 0;
    const reasons = vehicle.prearmReasons;

    return (
        <div className="@container flex h-full min-h-0 w-full flex-col overflow-auto bg-background">
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-subtle px-3 py-2">
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
                {/* All reasons in a cycle arrive at once, so one shared
                    "how fresh" readout here replaces a per-reason age. */}
                <span className="ml-auto text-micro text-text-helper tabular-nums">
                    {lastUpdate === null ? "No updates yet" : `Last update ${formatAge(Math.round((now - lastUpdate) / 1000))}`}
                </span>
            </div>

            <div className="min-h-0 flex-1 overflow-auto border border-border-subtle bg-layer-01 m-3">
                {reasons.length === 0 ? (
                    <div className="p-2 text-label text-text-helper">
                        {unknown ? "—" : "No failures reported."}
                    </div>
                ) : (
                    reasons.map((reason) => <ReasonRow key={reason.text} reason={reason} />)
                )}
            </div>
        </div>
    );
}
