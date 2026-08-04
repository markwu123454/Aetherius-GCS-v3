import {useCallback} from "react";
import {useVehicle} from "@/lib/vehicle/useVehicle.ts";
import {useGyroCalibration} from "@/lib/calibration/useGyroCalibration.ts";

/** Peak rotation rate, in deg/s across all three axes, below which the
 * vehicle counts as "still enough to calibrate" — comfortably above normal
 * sensor noise sitting on a desk, comfortably below anything being handled. */
const STILL_THRESHOLD_DPS = 2;

/**
 * Gyroscope calibration — ArduPilot's entire flow is one command
 * (`MAV_CMD_PREFLIGHT_CALIBRATION` param1=1) that holds the link for a few
 * seconds while it samples bias at rest; see `useGyroCalibration`.
 *
 * QGroundControl gates this behind a confirm dialog ("place the vehicle on a
 * surface and leave it still, click OK") with no feedback about whether that
 * condition is actually met — a vehicle quietly vibrating, or nudged
 * mid-sample, produces a bad bias with no visible warning either way. This
 * panel instead reads the live gyro rates off ATTITUDE and gates the button
 * on them directly, so the operator sees "Still"/"Moving" before and during
 * the hold instead of just trusting their own eyes.
 */
export default function GyroCalibrationPanel() {
    const vehicle = useVehicle();
    const calibration = useGyroCalibration();

    const maxRate = vehicle.attitude
        ? Math.max(
              Math.abs(vehicle.attitude.rollRateDps),
              Math.abs(vehicle.attitude.pitchRateDps),
              Math.abs(vehicle.attitude.yawRateDps),
          )
        : null;
    const still = maxRate !== null && maxRate < STILL_THRESHOLD_DPS;

    const start = useCallback(() => {
        void calibration.start();
    }, [calibration]);

    return (
        <div className="flex w-full max-w-lg flex-col gap-6">
            <div>
                <h2 className="text-heading text-text-primary">Gyroscope</h2>
                <p className="text-body text-text-secondary">
                    Samples gyro bias while the vehicle sits still, so it doesn't drift when it should be at rest.
                    ArduPilot already does this automatically on every boot — run it manually only if the vehicle
                    was disturbed while powering up.
                </p>
            </div>

            <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                    <span className="text-label text-text-helper">Vehicle</span>
                    <span className={`text-label ${still ? "text-state-ok" : "text-state-danger"}`}>
                        {maxRate === null ? "Waiting for attitude data…" : still ? "Still" : "Moving — hold it still"}
                    </span>
                </div>
                {maxRate !== null && (
                    <p className="text-micro text-text-helper">Peak rotation rate: {maxRate.toFixed(1)}°/s</p>
                )}
            </div>

            {calibration.result === "success" && <p className="text-label text-state-ok">Calibration complete.</p>}
            {calibration.error && <p className="text-label text-state-danger">{calibration.error}</p>}

            <button
                type="button"
                disabled={!still || calibration.calibrating}
                onClick={start}
                className="h-control-sm w-fit border border-border-subtle px-3 text-label text-text-primary hover:enabled:bg-layer-hover-01 disabled:text-text-disabled"
            >
                {calibration.calibrating ? "Calibrating — hold still…" : "Calibrate"}
            </button>
        </div>
    );
}
