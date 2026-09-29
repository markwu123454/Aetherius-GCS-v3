import {useState} from "react";
import {useVehicle} from "@/lib/vehicle/useVehicle.ts";
import {useReboot} from "@/lib/vehicle/useReboot.ts";
import {LiveParamEntry} from "@/lib/params/liveParams.ts";
import {useAccelCalibration} from "@/lib/calibration/useAccelCalibration.ts";
import {ACCEL_CAL_STEPS} from "@/lib/calibration/accelCalSteps.ts";
import {paramDefaultStatus, ParamDefaultStatus} from "@/lib/calibration/paramDefaultStatus.ts";
import OrientationViewport from "./viewport/OrientationViewport.tsx";

interface AccelCalibrationPanelProps {
    live: Map<string, LiveParamEntry>;
}

const STATUS_LABEL: Record<ParamDefaultStatus, string> = {
    complete: "Calibrated",
    incomplete: "Needs calibration",
    unknown: "Unknown",
};

const STATUS_TONE: Record<ParamDefaultStatus, string> = {
    complete: "text-state-ok",
    incomplete: "text-state-danger",
    unknown: "text-text-helper",
};

const LEVEL_ROTATION = {roll: 0, pitch: 0};

/**
 * Accelerometer calibration — the six-position sequence ArduPilot itself
 * drives (see `useAccelCalibration`), shown as two side-by-side 3D
 * viewports rather than QGroundControl's static per-position renders: one
 * shows the target pose, the other the vehicle's actual live attitude, with
 * a shared drag-to-orbit camera so the operator can rotate the view to match
 * however their vehicle is physically sitting on the desk once and then
 * directly compare shapes for every position, rather than mentally rotating
 * a fixed reference image six times.
 */
export default function AccelCalibrationPanel({live}: AccelCalibrationPanelProps) {
    const vehicle = useVehicle();
    const reboot = useReboot();
    const calibration = useAccelCalibration();
    const [viewYaw, setViewYaw] = useState(0);

    const status = paramDefaultStatus(live, ["INS_ACCOFFS_X", "INS_ACCOFFS_Y", "INS_ACCOFFS_Z"]);
    const targetRotation = calibration.step?.rotationDeg ?? LEVEL_ROTATION;
    const liveRotation = {roll: vehicle.attitude?.roll ?? 0, pitch: vehicle.attitude?.pitch ?? 0};

    return (
        <div className="flex w-full flex-col gap-6">
            <div>
                <h2 className="text-heading text-text-primary">Accelerometer</h2>
                <p className="text-body text-text-secondary">
                    Records accelerometer bias across six orientations so attitude and altitude readings are accurate.
                    Reference:{" "}
                    <a
                        href="https://ardupilot.org/copter/docs/common-accelerometer-calibration.html"
                        target="_blank"
                        rel="noreferrer"
                        className="text-state-info underline"
                    >
                        ArduPilot's Accelerometer Calibration docs
                    </a>
                    .
                </p>
            </div>

            {calibration.calibrating && (
                <div className="flex items-center gap-1">
                    {ACCEL_CAL_STEPS.map((step, index) => {
                        const state =
                            calibration.stepIndex < 0
                                ? "pending"
                                : index < calibration.stepIndex
                                  ? "done"
                                  : index === calibration.stepIndex
                                    ? "current"
                                    : "pending";
                        return (
                            <div
                                key={step.position}
                                title={step.label}
                                className={[
                                    "h-1.5 flex-1",
                                    state === "done" ? "bg-state-ok" : state === "current" ? "bg-state-info" : "bg-layer-02",
                                ].join(" ")}
                            />
                        );
                    })}
                </div>
            )}

            {/* "Your Vehicle" stays up whether or not a calibration is
                running — the whole point is being able to eyeball the
                vehicle's reported attitude at rest before starting and
                after saving, not just during the wizard. "Target" joins it
                only while a position is actually being asked for. */}
            <div className="flex flex-wrap gap-4">
                {calibration.calibrating && (
                    <OrientationViewport
                        label="Target"
                        rotationDeg={targetRotation}
                        viewYaw={viewYaw}
                        onViewYawChange={setViewYaw}
                    />
                )}
                <OrientationViewport
                    label="Your Vehicle"
                    rotationDeg={liveRotation}
                    viewYaw={viewYaw}
                    onViewYawChange={setViewYaw}
                />
            </div>

            {!calibration.calibrating && (
                <div className="flex flex-col gap-3">
                    <div className="flex items-center gap-2">
                        <span className="text-label text-text-helper">Status</span>
                        <span className={`text-label ${STATUS_TONE[status]}`}>{STATUS_LABEL[status]}</span>
                    </div>
                    {calibration.result === "success" && (
                        <p className="text-label text-state-ok">Calibration complete.</p>
                    )}
                    {calibration.error && <p className="text-label text-state-danger">{calibration.error}</p>}
                    <button
                        type="button"
                        onClick={calibration.start}
                        className="h-control-sm w-fit border border-border-subtle px-3 text-label text-text-primary hover:bg-layer-hover-01"
                    >
                        Calibrate
                    </button>
                </div>
            )}

            {calibration.calibrating && (
                <div className="flex flex-col gap-4">
                    <p className="text-label text-state-info">
                        {calibration.step ? calibration.step.instruction : "Waiting for the vehicle to respond…"}
                    </p>
                    {calibration.error && <p className="text-label text-state-danger">{calibration.error}</p>}

                    <button
                        type="button"
                        disabled={!calibration.step || calibration.confirming}
                        onClick={calibration.next}
                        className="h-control-sm w-fit bg-blue-60 px-3 text-label text-text-on-color hover:enabled:bg-blue-50 disabled:opacity-50"
                    >
                        {calibration.confirming ? "Confirming…" : "Next"}
                    </button>

                    {/* ArduPilot has no MAVLink command to cancel an in-progress
                        accel calibration (see `useAccelCalibration`) — its own
                        state machine keeps running regardless of what the GCS
                        sends, and a fresh start silently no-ops while the old
                        one is still open. A reboot is the only real way out
                        once this has started. */}
                    <p className="text-label text-text-helper">
                        There's no way to cancel this once started — finish all six positions, or{" "}
                        <button
                            type="button"
                            onClick={() => void reboot.reboot()}
                            disabled={reboot.pending}
                            className="text-state-info underline disabled:text-text-disabled"
                        >
                            reboot the vehicle
                        </button>{" "}
                        if you need to stop. It won't arm again until then.
                    </p>
                    {reboot.error && <p className="text-label text-state-danger">{reboot.error}</p>}
                </div>
            )}

        </div>
    );
}
