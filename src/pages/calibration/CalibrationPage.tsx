import {useEffect, useMemo, useState} from "react";
import {useConnection} from "@/lib/vehicle/useConnection.ts";
import {useVehicle} from "@/lib/vehicle/useVehicle.ts";
import {useLiveParams} from "@/lib/params/useLiveParams.ts";
import {LiveParamEntry} from "@/lib/params/liveParams.ts";
import {paramDefaultStatus} from "@/lib/calibration/paramDefaultStatus.ts";
import RadioCalibrationPanel from "./RadioCalibrationPanel.tsx";
import AccelCalibrationPanel from "./AccelCalibrationPanel.tsx";
import GyroCalibrationPanel from "./GyroCalibrationPanel.tsx";
import CompassCalibrationPanel from "./CompassCalibrationPanel.tsx";
import LevelHorizonCalibrationPanel from "./LevelHorizonCalibrationPanel.tsx";
import EscCalibrationPanel, {escCalibrationNotNeeded} from "./EscCalibrationPanel.tsx";
import {VehicleKind} from "@/lib/vehicle/vehicle.ts";
import {escCalibrationInProgress, useEscCalibration} from "@/lib/calibration/escCalibration.ts";

type CalibrationStatus = "complete" | "incomplete" | "not-needed" | "unknown";

interface CalibrationItem {
    id: string;
    label: string;
    status: CalibrationStatus;
}

const STATUS_LABEL: Record<CalibrationStatus, string> = {
    complete: "Calibrated",
    incomplete: "Needs calibration",
    "not-needed": "Not needed",
    unknown: "Unknown",
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

// ArduPilot firmware defaults for every RC channel, straight out of QGC's
// APMRadioComponent::setupComplete() comment.
const RC_MIN_DEFAULT = 1100;
const RC_MAX_DEFAULT = 1900;
const RC_TRIM_DEFAULT = 1500;
const RCMAP_PARAMS = ["RCMAP_ROLL", "RCMAP_PITCH", "RCMAP_THROTTLE", "RCMAP_YAW"] as const;

/**
 * Mirrors `APMRadioComponent::setupComplete()` from QGroundControl:
 *
 * 1. All four attitude axes must be mapped to a channel (RCMAP_* > 0).
 * 2. At least one of those channels must have had its MIN/MAX/TRIM changed
 *    away from ArduPilot's factory defaults (1100 / 1900 / 1500). If every
 *    mapped channel is still at the factory values the radio has never been
 *    calibrated.
 *
 * In practice RCMAP_* always ships >0 on ArduPilot (Roll=1 Pitch=2
 * Throttle=3 Yaw=4), so the real test is almost always just whether any
 * RC{n}_MIN/MAX/TRIM differs from the defaults.
 */
function radioStatus(live: Map<string, LiveParamEntry>): CalibrationStatus {
    const channels: number[] = [];
    for (const param of RCMAP_PARAMS) {
        const value = paramValue(live, param);
        if (value === undefined) return "unknown";
        if (value <= 0) return "incomplete";
        channels.push(Math.round(value));
    }
    for (const channel of channels) {
        const min = paramValue(live, `RC${channel}_MIN`);
        const max = paramValue(live, `RC${channel}_MAX`);
        const trim = paramValue(live, `RC${channel}_TRIM`);
        if (min === undefined || max === undefined || trim === undefined) return "unknown";
        if (min !== RC_MIN_DEFAULT || max !== RC_MAX_DEFAULT || trim !== RC_TRIM_DEFAULT) {
            return "complete";
        }
    }
    return "incomplete";
}

/**
 * Level horizon writes AHRS_TRIM_X and AHRS_TRIM_Y (roll and pitch offsets in
 * radians). Both default to 0.0 — which is also a valid result when the board
 * happens to be perfectly level — so zero-trims can't be distinguished from
 * "never calibrated". Any non-zero value is unambiguous: the procedure ran.
 */
function levelHorizonStatus(live: Map<string, LiveParamEntry>): CalibrationStatus {
    const trimX = paramValue(live, "AHRS_TRIM_X");
    const trimY = paramValue(live, "AHRS_TRIM_Y");
    if (trimX === undefined || trimY === undefined) return "unknown";
    return trimX !== 0 || trimY !== 0 ? "complete" : "unknown";
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

/**
 * Every calibration this page could offer, for the connected vehicle's own
 * type. Frame setup, Servo output, and anything else that's a plain
 * parameter form rather than a calibration procedure lives on the Setup page
 * instead (see `SetupPage`), as does motor testing.
 */
function buildItems(vehicleKind: VehicleKind | null, live: Map<string, LiveParamEntry>): CalibrationItem[] {
    const items: CalibrationItem[] = [];

    items.push(
        {
            id: "accel",
            label: "Accelerometer",
            status: paramDefaultStatus(live, ["INS_ACCOFFS_X", "INS_ACCOFFS_Y", "INS_ACCOFFS_Z"]),
        },
        {
            id: "gyro",
            label: "Gyroscope",
            // Always green: ArduPilot re-runs gyro calibration automatically on
            // every boot, so a valid calibration is always present. Manual
            // calibration is only needed if the vehicle was disturbed at power-up.
            status: "complete",
        },
    );

    items.push({
        id: "levelHorizon",
        label: "Level Horizon",
        status: levelHorizonStatus(live),
    });

    for (const instance of [1, 2, 3] as const) {
        const {fitted, status} = compassStatus(live, instance);
        // A slot nothing is plugged into isn't a calibration the operator has
        // any use for — shown only while connected but still unread, so
        // "unknown" doesn't read as a compass that's silently missing.
        if (!fitted && status !== "unknown") continue;
        items.push({
            id: `compass-${instance}`,
            label: `Compass ${instance}`,
            status,
        });
    }

    // Pressure, motor interference (CompassMot) and airspeed calibration are
    // left out until each has a working panel — a listed calibration with a
    // dead button reads as broken.
    items.push({
        id: "radio",
        label: "Radio",
        status: radioStatus(live),
    });

    // ArduCopter only: Plane has no ESC calibration of its own, and heli
    // builds compile it out — the parameter existing is the real test.
    if (vehicleKind === "multirotor" && live.has("ESC_CALIBRATION")) {
        items.push({
            id: "esc",
            label: "ESC",
            // ArduPilot keeps no record of a completed ESC calibration.
            status: escCalibrationNotNeeded(paramValue(live, "MOT_PWM_TYPE")) ? "not-needed" : "unknown",
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

/**
 * Accelerometer, gyroscope, level horizon, compass, radio and ESC — see
 * `buildItems`. Accelerometer/compass status mirrors
 * QGroundControl's own ArduPilot detection, read from the same live
 * parameter map the Parameters page uses.
 */
export default function CalibrationPage() {
    const connection = useConnection();
    const vehicle = useVehicle();
    const connected = connection.status === "connected";
    const live = useLiveParams();

    const items = useMemo(() => buildItems(vehicle.vehicleKind, live.values), [vehicle.vehicleKind, live.values]);
    const esc = useEscCalibration();
    const escActive = escCalibrationInProgress(esc);

    const [selectedId, setSelectedId] = useState<string | null>(null);
    useEffect(() => {
        // A fresh vehicle type (or the very first load) starts on its first
        // item; a selection that's no longer in the list — e.g. a compass
        // that stopped reporting — falls back the same way rather than
        // pointing at nothing.
        if (escActive && selectedId !== "esc" && items.some((item) => item.id === "esc")) {
            setSelectedId("esc");
        } else if (!items.some((item) => item.id === selectedId)) {
            setSelectedId(items[0]?.id ?? null);
        }
        // Only re-run on the guide starting, not on every selection change —
        // otherwise picking another item mid-calibration would snap back.
    }, [items, escActive]);

    const escPanel = (
        <EscCalibrationPanel
            live={live.values}
            connected={connected}
            linkLost={connection.status === "lost"}
            armed={vehicle.armed}
            radioCalibrated={radioStatus(live.values) === "unknown" ? null : radioStatus(live.values) === "complete"}
            paramsTotal={live.total}
            onSet={live.setParam}
        />
    );

    if (!connected) {
        // ESC calibration takes the link down on purpose, more than once —
        // keep the guide on screen rather than "No vehicle connected".
        if (escActive) {
            return <div className="h-full w-full overflow-auto p-6">{escPanel}</div>;
        }
        return (
            <div className="flex h-full w-full items-center justify-center text-label text-text-helper">
                No vehicle connected
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
                    ) : selected.id === "esc" ? (
                        escPanel
                    ) : selected.id === "levelHorizon" ? (
                        <LevelHorizonCalibrationPanel live={live.values} vehicleKind={vehicle.vehicleKind}/>
                    ) : null)}
            </div>
        </div>
    );
}
