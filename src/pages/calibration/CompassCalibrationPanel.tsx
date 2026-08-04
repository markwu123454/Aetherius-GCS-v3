import {useMemo} from "react";
import {useVehicle} from "@/lib/vehicle/useVehicle.ts";
import {sendVehicleCommand} from "@/lib/vehicle/commands.ts";
import {LiveParamEntry} from "@/lib/params/liveParams.ts";
import {useCompassCalibration} from "@/lib/calibration/useCompassCalibration.ts";
import {COMPASS_CAL_SECTION_COUNT} from "@/lib/calibration/compassCalGrid.ts";
import CompassCoverageViewport from "./viewport/CompassCoverageViewport.tsx";

interface CompassCalibrationPanelProps {
    live: Map<string, LiveParamEntry>;
}

type Tone = "ok" | "warn" | "danger";

const TONE_TEXT: Record<Tone, string> = {
    ok: "text-state-ok",
    warn: "text-state-warn",
    danger: "text-state-danger",
};

const TONE_BG: Record<Tone, string> = {
    ok: "bg-state-ok",
    warn: "bg-state-warn",
    danger: "bg-state-danger",
};

/**
 * QGroundControl's own thresholds (`APMSensorsComponent.qml`'s
 * `greenMaxThreshold`/`yellowMaxThreshold`/`fitnessRange`) — internal
 * compasses get double the allowance, since they sit closer to noisy
 * electronics than an external GPS/compass module and are expected to read
 * worse. `fitness` is RMS milligauss residual; lower is better.
 */
function fitnessTone(fitness: number, external: boolean): Tone {
    const green = external ? 8 : 16;
    const yellow = external ? 15 : 30;
    if (fitness <= green) return "ok";
    if (fitness <= yellow) return "warn";
    return "danger";
}

function FitnessBar({fitness, external}: {fitness: number; external: boolean}) {
    const green = external ? 8 : 16;
    const yellow = external ? 15 : 30;
    const range = external ? 25 : 50;
    const clampedPct = (Math.min(Math.max(fitness, 0), range) / range) * 100;
    const tone = fitnessTone(fitness, external);

    return (
        <div className="flex flex-col gap-1">
            <div className="relative h-1.5 w-full bg-layer-02">
                <div className={`absolute inset-y-0 left-0 ${TONE_BG.ok}`} style={{width: `${(green / range) * 100}%`}} />
                <div
                    className={`absolute inset-y-0 ${TONE_BG.warn}`}
                    style={{left: `${(green / range) * 100}%`, width: `${((yellow - green) / range) * 100}%`}}
                />
                <div className={`absolute inset-y-0 ${TONE_BG.danger}`} style={{left: `${(yellow / range) * 100}%`, right: 0}} />
                <div
                    className="absolute top-1/2 h-3 w-0.5 -translate-y-1/2 bg-text-primary"
                    style={{left: `${clampedPct}%`}}
                />
            </div>
            <span className={`text-micro ${TONE_TEXT[tone]}`}>{fitness.toFixed(1)} mG</span>
        </div>
    );
}

function paramValue(live: Map<string, LiveParamEntry>, name: string): number | undefined {
    return live.get(name)?.value;
}

/** `COMPASS_EXTERNAL{suffix}` for the given 0-based `MAG_CAL_PROGRESS`
 * compass id — read live so the fitness thresholds match this compass's
 * actual mounting rather than assuming. Defaults to external (the tighter
 * thresholds) if the param hasn't arrived yet, rather than silently
 * flattering a reading that might not deserve it. */
function isExternal(live: Map<string, LiveParamEntry>, compassId: number): boolean {
    const suffix = compassId === 0 ? "" : String(compassId + 1);
    const value = paramValue(live, `COMPASS_EXTERNAL${suffix}`);
    return value === undefined || value !== 0;
}

/**
 * Compass calibration — ArduPilot rotates through orientations freely rather
 * than a fixed position sequence (see `useCompassCalibration`), so the panel
 * centers on one thing QGroundControl doesn't show at all: a live coverage
 * sphere (see `compassCalGrid.ts`/`CoverageSphere`) painting which directions
 * `MAG_CAL_PROGRESS` has actually sampled, so the operator can see *which
 * way* to keep turning instead of watching a bare percentage climb.
 *
 * Fitness bars use QGroundControl's own thresholds; cancelling is a real
 * operation here (`MAV_CMD_DO_CANCEL_MAG_CAL`), unlike accel/gyro.
 */
export default function CompassCalibrationPanel({live}: CompassCalibrationPanelProps) {
    const vehicle = useVehicle();
    const calibration = useCompassCalibration();

    const rotationDeg = {
        roll: vehicle.attitude?.roll ?? 0,
        pitch: vehicle.attitude?.pitch ?? 0,
        yaw: vehicle.attitude?.yaw ?? 0,
    };

    // Union across every compass currently calibrating — "how much of the
    // sphere has at least one compass sampled," the simplest single signal
    // to rotate against when several compasses are running at once.
    const coveredMask = useMemo(() => {
        const combined = new Array<boolean>(COMPASS_CAL_SECTION_COUNT).fill(false);
        for (const compass of calibration.progress.values()) {
            compass.coveredMask.forEach((covered, i) => {
                if (covered) combined[i] = true;
            });
        }
        return combined;
    }, [calibration.progress]);

    const compassIds = useMemo(() => {
        const ids = new Set<number>();
        calibration.progress.forEach((_, id) => ids.add(id));
        calibration.reports.forEach((_, id) => ids.add(id));
        return [...ids].sort((a, b) => a - b);
    }, [calibration.progress, calibration.reports]);

    const done = !calibration.calibrating && calibration.reports.size > 0;
    const allSucceeded = done && [...calibration.reports.values()].every((report) => report.success);

    return (
        <div className="flex w-full gap-8">
            {/* The coverage sphere is the whole point of this panel — it
                gets the dominant share of the width instead of being
                squeezed into the same narrow column as the accel/gyro forms,
                which have nothing comparable to show. */}
            <div className="min-w-0 flex-1">
                <CompassCoverageViewport rotationDeg={rotationDeg} coveredMask={coveredMask} />
            </div>

            <div className="flex w-full max-w-sm shrink-0 flex-col gap-6">
                <div>
                    <h2 className="text-heading text-text-primary">Compass</h2>
                    <p className="text-body text-text-secondary">
                        Corrects magnetometer offsets so heading is accurate. Rotate the vehicle slowly through as
                        many orientations as you can — nose down, tail down, each side down, upside down, and
                        everything in between — until every compass's coverage fills in.
                    </p>
                </div>

                {compassIds.length > 0 && (
                    <div className="flex flex-col gap-3">
                        {compassIds.map((id) => {
                            const compassProgress = calibration.progress.get(id);
                            const report = calibration.reports.get(id);
                            return (
                                <div key={id} className="flex flex-col gap-1">
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="text-label text-text-primary">Compass {id + 1}</span>
                                        {!report && (
                                            <span className="text-label text-text-helper">
                                                {compassProgress?.completionPct ?? 0}%
                                            </span>
                                        )}
                                        {report && (
                                            <span className={`text-label ${TONE_TEXT[report.success ? "ok" : "danger"]}`}>
                                                {report.success ? "Passed" : "Failed"}
                                            </span>
                                        )}
                                    </div>
                                    {report && <FitnessBar fitness={report.fitness} external={isExternal(live, id)} />}
                                </div>
                            );
                        })}
                    </div>
                )}

                {done && (
                    <div className="flex flex-col gap-2 border border-border-subtle p-3">
                        <p className={`text-label ${TONE_TEXT[allSucceeded ? "ok" : "danger"]}`}>
                            {allSucceeded
                                ? "Calibration complete. Reboot the vehicle before arming."
                                : "Calibration failed on at least one compass — try again, rotating more slowly."}
                        </p>
                        {allSucceeded && (
                            <button
                                type="button"
                                onClick={() => void sendVehicleCommand({type: "reboot"})}
                                className="h-control-sm w-fit bg-blue-60 px-3 text-label text-text-on-color hover:enabled:bg-blue-50"
                            >
                                Reboot Vehicle
                            </button>
                        )}
                    </div>
                )}

                {calibration.error && <p className="text-label text-state-danger">{calibration.error}</p>}

                <div className="flex gap-2">
                    <button
                        type="button"
                        disabled={calibration.calibrating}
                        onClick={() => void calibration.start()}
                        className="h-control-sm w-fit border border-border-subtle px-3 text-label text-text-primary hover:enabled:bg-layer-hover-01 disabled:text-text-disabled"
                    >
                        {calibration.calibrating ? "Calibrating…" : done ? "Recalibrate" : "Calibrate"}
                    </button>
                    {calibration.calibrating && (
                        <button
                            type="button"
                            onClick={calibration.cancel}
                            className="h-control-sm border border-border-subtle px-3 text-label text-text-secondary hover:enabled:bg-layer-hover-01"
                        >
                            Cancel
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
