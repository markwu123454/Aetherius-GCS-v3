import {useEffect, useMemo, useState} from "react";
import {useConnection} from "@/lib/vehicle/useConnection.ts";
import {useVehicle} from "@/lib/vehicle/useVehicle.ts";
import {useLiveParams} from "@/lib/params/useLiveParams.ts";
import {LiveParamEntry} from "@/lib/params/liveParams.ts";
import {VehicleKind} from "@/lib/vehicle/vehicle.ts";
import RadioCalibrationPanel from "./RadioCalibrationPanel.tsx";
import AccelCalibrationPanel from "./AccelCalibrationPanel.tsx";
import GyroCalibrationPanel from "./GyroCalibrationPanel.tsx";
import CompassCalibrationPanel from "./CompassCalibrationPanel.tsx";

type CalibrationStatus = "complete" | "incomplete" | "not-needed" | "unknown";

interface CalibrationItem {
    id: string;
    label: string;
    description: string;
    status: CalibrationStatus;
    /** Shown in the detail pane when the status can't speak for itself —
     * either nothing here computes it, or it's gated on something worth
     * explaining. */
    note?: string;
}

const STATUS_LABEL: Record<CalibrationStatus, string> = {
    complete: "Calibrated",
    incomplete: "Needs calibration",
    "not-needed": "Not needed",
    unknown: "Unknown",
};

const STATUS_TONE: Record<CalibrationStatus, string> = {
    complete: "text-state-ok",
    incomplete: "text-state-danger",
    "not-needed": "text-text-helper",
    unknown: "text-text-helper",
};

/** QGroundControl's own convention: green dot = complete, red dot =
 * incomplete, no dot at all = optional. `unknown` isn't one of QGC's states
 * (it always has a connected vehicle by the time this page is reachable) —
 * it gets a dim dot here rather than none, so "nothing read yet" doesn't
 * look identical to "nothing needed". */
const STATUS_DOT: Record<CalibrationStatus, string | null> = {
    complete: "bg-state-ok",
    incomplete: "bg-state-danger",
    "not-needed": null,
    unknown: "bg-state-unknown",
};

function paramValue(live: Map<string, LiveParamEntry>, name: string): number | undefined {
    return live.get(name)?.value;
}

/**
 * Mirrors QGroundControl's own ArduPilot detection
 * (`APMSensorsComponent::accelSetupNeeded`): uncalibrated iff every
 * `INS_ACCOFFS` axis is still exactly the firmware's zero default.
 */
function accelStatus(live: Map<string, LiveParamEntry>): CalibrationStatus {
    const values = ["INS_ACCOFFS_X", "INS_ACCOFFS_Y", "INS_ACCOFFS_Z"].map((name) => paramValue(live, name));
    if (values.some((value) => value === undefined)) return "unknown";
    return values.every((value) => value === 0) ? "incomplete" : "complete";
}

/**
 * One compass instance (1-3), the same rule QGroundControl uses
 * (`APMSensorsComponent::compassSetupNeeded`): a `DEV_ID` of 0 means the
 * slot has no compass fitted at all; a `USE` of 0 means one is fitted but
 * the operator has switched it off; otherwise it's uncalibrated iff every
 * offset axis is still zero.
 */
function compassStatus(
    live: Map<string, LiveParamEntry>,
    instance: 1 | 2 | 3,
): {fitted: boolean; status: CalibrationStatus} {
    const suffix = instance === 1 ? "" : String(instance);
    const devId = paramValue(live, `COMPASS_DEV_ID${suffix}`);
    if (devId === undefined) return {fitted: false, status: "unknown"};
    if (devId === 0) return {fitted: false, status: "not-needed"};

    const use = paramValue(live, `COMPASS_USE${suffix}`);
    if (use === 0) return {fitted: true, status: "not-needed"};

    const offsets = [`COMPASS_OFS${suffix}_X`, `COMPASS_OFS${suffix}_Y`, `COMPASS_OFS${suffix}_Z`].map((name) =>
        paramValue(live, name),
    );
    if (use === undefined || offsets.some((value) => value === undefined)) return {fitted: true, status: "unknown"};
    return {fitted: true, status: offsets.every((value) => value === 0) ? "incomplete" : "complete"};
}

const NOT_AUTO_DETECTED =
    "Not automatically detected yet — ArduPilot's own prearm check will flag this before arming if it isn't done.";

/**
 * Every calibration this page could offer, for the connected vehicle's own
 * type. Deliberately scoped to sensor calibration only — ESC calibration and
 * motor testing are bench/system tests, not sensor corrections, and belong
 * on a future page of their own.
 */
function buildItems(vehicleKind: VehicleKind | null, live: Map<string, LiveParamEntry>): CalibrationItem[] {
    const items: CalibrationItem[] = [
        {
            id: "accel",
            label: "Accelerometer",
            description: "Corrects accelerometer bias so attitude and altitude readings are accurate.",
            status: accelStatus(live),
        },
        {
            id: "gyro",
            label: "Gyroscope",
            description: "Corrects gyro bias so the vehicle doesn't drift when it should be still.",
            status: "unknown",
            note: "Recalibrates automatically on every boot — run manually only if the vehicle was disturbed while powering up.",
        },
    ];

    for (const instance of [1, 2, 3] as const) {
        const {fitted, status} = compassStatus(live, instance);
        // A slot nothing is plugged into isn't a calibration the operator has
        // any use for — shown only while connected but still unread, so
        // "unknown" doesn't read as a compass that's silently missing.
        if (!fitted && status !== "unknown") continue;
        items.push({
            id: `compass-${instance}`,
            label: `Compass ${instance}`,
            description: "Corrects magnetometer offsets so heading is accurate.",
            status,
        });
    }

    items.push({
        id: "radio",
        label: "Radio",
        description: "Records each RC channel's min/max/trim so stick input maps correctly.",
        status: "unknown",
        note: NOT_AUTO_DETECTED,
    });

    if (vehicleKind === "plane") {
        const arspdType = paramValue(live, "ARSPD_TYPE");
        items.push({
            id: "airspeed",
            label: "Airspeed Sensor",
            description: "Calibrates the differential-pressure sensor used for airspeed.",
            status: arspdType === undefined ? "unknown" : arspdType === 0 ? "not-needed" : "unknown",
            note: arspdType ? NOT_AUTO_DETECTED : undefined,
        });
    }

    return items;
}

function SidebarRow({item, active, onSelect}: {item: CalibrationItem; active: boolean; onSelect: () => void}) {
    const dot = STATUS_DOT[item.status];
    return (
        <button
            type="button"
            aria-current={active}
            title={STATUS_LABEL[item.status]}
            onClick={onSelect}
            className={[
                "flex items-center gap-2 px-3 py-2 text-left text-label whitespace-nowrap",
                active
                    ? "bg-background text-text-primary"
                    : "text-text-secondary hover:bg-layer-hover-01 hover:text-text-primary",
            ].join(" ")}
        >
            {dot ? (
                <span className={`size-2 shrink-0 ${dot}`} aria-hidden="true"/>
            ) : (
                <span className="size-2 shrink-0"/>
            )}
            {item.label}
        </button>
    );
}

function DetailPane({item}: {item: CalibrationItem}) {
    return (
        <div className="flex max-w-lg flex-col gap-4">
            <div>
                <h2 className="text-heading text-text-primary">{item.label}</h2>
                <p className="text-body text-text-secondary">{item.description}</p>
            </div>

            <div className="flex items-center gap-2">
                <span className="text-label text-text-helper">Status</span>
                <span className={`text-label ${STATUS_TONE[item.status]}`}>{STATUS_LABEL[item.status]}</span>
            </div>

            {item.note && <p className="text-label text-text-helper">{item.note}</p>}

            <button
                type="button"
                disabled
                title="Not implemented yet"
                className="h-control-sm w-fit border border-border-subtle px-3 text-label text-text-disabled"
            >
                Calibrate
            </button>
        </div>
    );
}

/**
 * Sensor calibration only (accelerometer, compass, radio, airspeed) — see
 * `buildItems`. Accelerometer/compass status mirrors QGroundControl's own
 * ArduPilot detection, read from the same live parameter map the Parameters
 * page uses. Every "Calibrate" button is disabled: running an actual
 * calibration routine needs backend command support that doesn't exist yet,
 * and a button that looks live but does nothing is worse than an honestly
 * disabled one.
 */
export default function CalibrationPage() {
    const connection = useConnection();
    const vehicle = useVehicle();
    const connected = connection.status === "connected";
    const live = useLiveParams(connection.status);

    const items = useMemo(() => buildItems(vehicle.vehicleKind, live.values), [vehicle.vehicleKind, live.values]);

    const [selectedId, setSelectedId] = useState<string | null>(null);
    useEffect(() => {
        // A fresh vehicle type (or the very first load) starts on its first
        // item; a selection that's no longer in the list — e.g. a compass
        // that stopped reporting — falls back the same way rather than
        // pointing at nothing.
        if (!items.some((item) => item.id === selectedId)) {
            setSelectedId(items[0]?.id ?? null);
        }
    }, [items, selectedId]);

    if (!connected) {
        return (
            <div className="flex h-full w-full items-center justify-center text-label text-text-helper">
                Connect a vehicle to see its calibration status.
            </div>
        );
    }

    const selected = items.find((item) => item.id === selectedId) ?? null;

    return (
        <div className="flex h-full w-full">
            <nav className="flex w-48 shrink-0 flex-col border-r border-border-subtle bg-layer-01">
                {items.map((item) => (
                    <SidebarRow
                        key={item.id}
                        item={item}
                        active={item.id === selectedId}
                        onSelect={() => setSelectedId(item.id)}
                    />
                ))}
            </nav>
            <div className="min-h-0 flex-1 overflow-auto p-6">
                {selected &&
                    (selected.id === "radio" ? (
                        <RadioCalibrationPanel live={live.values} vehicleKind={vehicle.vehicleKind}/>
                    ) : selected.id === "accel" ? (
                        <AccelCalibrationPanel live={live.values}/>
                    ) : selected.id === "gyro" ? (
                        <GyroCalibrationPanel/>
                    ) : selected.id.startsWith("compass-") ? (
                        <CompassCalibrationPanel live={live.values}/>
                    ) : (
                        <DetailPane item={selected}/>
                    ))}
            </div>
        </div>
    );
}
