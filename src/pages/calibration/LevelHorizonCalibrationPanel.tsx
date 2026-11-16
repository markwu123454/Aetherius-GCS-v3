import {useCallback} from "react";
import {useVehicle} from "@/lib/vehicle/useVehicle.ts";
import type {LiveParamEntry} from "@/lib/params/liveParams.ts";
import type {VehicleKind} from "@/lib/vehicle/vehicle.ts";
import {useLevelCalibration} from "@/lib/calibration/useLevelCalibration.ts";

/** Same stillness gate as `GyroCalibrationPanel` — level runs a full gyro
 * calibration first, so it needs the vehicle at least that still. */
const STILL_THRESHOLD_DPS = 2;

/** ArduPilot's `HAL_INS_TRIM_LIMIT_DEG`: `_calculate_trim` rejects any
 * resulting trim beyond this on either axis. */
const TRIM_LIMIT_DEG = 10;

function degrees(live: Map<string, LiveParamEntry>, name: string): number | null {
    const value = live.get(name)?.value;
    return value === undefined ? null : (value * 180) / Math.PI;
}

function formatDeg(value: number | null): string {
    return value === null ? "—" : `${value.toFixed(1)}°`;
}

interface LevelHorizonCalibrationPanelProps {
    live: Map<string, LiveParamEntry>;
    vehicleKind: VehicleKind | null;
}

/**
 * Level horizon — saves the board's tilt relative to the frame as
 * AHRS_TRIM_X/Y; see `useLevelCalibration` for the command itself.
 *
 * The button is gated on what ArduPilot would otherwise reject after a
 * multi-second gyro run: armed, moving, or tilted past the 10° trim limit.
 * The trim limit is checked against the live attitude, which already has the
 * current trim applied — so it is a close guide, not ArduPilot's exact test.
 */
export default function LevelHorizonCalibrationPanel({live, vehicleKind}: LevelHorizonCalibrationPanelProps) {
    const vehicle = useVehicle();
    const calibration = useLevelCalibration();

    const attitude = vehicle.attitude;
    const maxRate = attitude
        ? Math.max(Math.abs(attitude.rollRateDps), Math.abs(attitude.pitchRateDps), Math.abs(attitude.yawRateDps))
        : null;
    const still = maxRate !== null && maxRate < STILL_THRESHOLD_DPS;
    const withinLimit =
        attitude !== null && Math.abs(attitude.roll) <= TRIM_LIMIT_DEG && Math.abs(attitude.pitch) <= TRIM_LIMIT_DEG;

    const blocker = vehicle.armed
        ? "Disarm to calibrate"
        : attitude === null
          ? "Waiting for attitude data…"
          : !still
            ? "Moving — hold it still"
            : !withinLimit
              ? `Tilted more than ${TRIM_LIMIT_DEG}°`
              : null;

    const start = useCallback(() => {
        void calibration.start();
    }, [calibration]);

    return (
        <div className="flex w-full max-w-lg flex-col gap-6">
            <h2 className="text-heading text-text-primary">Level Horizon</h2>

            <p className="text-label text-text-secondary">
                {vehicleKind === "plane"
                    ? "Place the vehicle in its level flight attitude."
                    : "Place the vehicle on a level surface in its hover attitude."}
            </p>

            <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                    <span className="text-label text-text-helper">Vehicle</span>
                    <span className={`text-label ${blocker === null ? "text-state-ok" : "text-state-danger"}`}>
                        {blocker ?? "Ready"}
                    </span>
                </div>
                <div className="flex items-center gap-2">
                    <span className="text-label text-text-helper">Roll</span>
                    <span className="text-label text-text-primary">{formatDeg(attitude?.roll ?? null)}</span>
                    <span className="ml-4 text-label text-text-helper">Pitch</span>
                    <span className="text-label text-text-primary">{formatDeg(attitude?.pitch ?? null)}</span>
                </div>
                <div className="flex items-center gap-2">
                    <span className="text-label text-text-helper">Trim roll</span>
                    <span className="text-label text-text-primary">{formatDeg(degrees(live, "AHRS_TRIM_X"))}</span>
                    <span className="ml-4 text-label text-text-helper">Trim pitch</span>
                    <span className="text-label text-text-primary">{formatDeg(degrees(live, "AHRS_TRIM_Y"))}</span>
                </div>
            </div>

            {calibration.result === "success" && <p className="text-label text-state-ok">Calibration complete.</p>}
            {calibration.error && <p className="text-label text-state-danger">{calibration.error}</p>}

            <button
                type="button"
                disabled={blocker !== null || calibration.calibrating}
                onClick={start}
                className="h-control-sm w-fit border border-border-subtle px-3 text-label text-text-primary hover:enabled:bg-layer-hover-01 disabled:text-text-disabled"
            >
                {calibration.calibrating ? "Calibrating — hold still…" : "Calibrate"}
            </button>
        </div>
    );
}
