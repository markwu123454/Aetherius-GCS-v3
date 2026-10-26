import {useCallback, useRef, useState} from "react";
import {sendVehicleCommand} from "@/lib/vehicle/commands.ts";
import {useTauriEvent} from "@/lib/tauriEvent.ts";
import type {ConnectionStatus} from "@/lib/vehicle/connection.ts";
import {COMPASS_CAL_SECTION_COUNT, sectionCovered} from "./compassCalGrid.ts";

/** ArduPilot's `MagCalStatus::MAG_CAL_SUCCESS`. */
const MAG_CAL_SUCCESS = 4;

export interface CompassCalProgress {
    completionPct: number;
    /** Length `COMPASS_CAL_SECTION_COUNT`, index-aligned with `compassCalGrid.ts`. */
    coveredMask: boolean[];
}

export interface CompassCalReport {
    success: boolean;
    /** RMS milligauss residual from ArduPilot's ellipsoid fit — lower is
     * better. The one calibration in this app with a real quality number. */
    fitness: number;
    /** Raw `MAG_CAL_STATUS` value from ArduPilot: 4=success, 5=failed,
     * 6=bad_orientation, 7=bad_radius. Kept raw so the UI can show the
     * specific reason without this layer having to enumerate them. */
    calStatus: number;
}

interface MagCalProgressEvent {
    compassId: number;
    calMask: number;
    completionPct: number;
    completionMask: number[];
}

interface MagCalReportEvent {
    compassId: number;
    calMask: number;
    calStatus: number;
    fitness: number;
}

/** First compass's live field from `RAW_IMU`, body frame (x nose, y right
 * wing, z belly), milligauss. Only its direction is used. */
export interface MagField {
    x: number;
    y: number;
    z: number;
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Which compass ids (0-7) a `MAV_CMD_DO_START_MAG_CAL` bitmask names. */
function idsInMask(mask: number): number[] {
    const ids: number[] = [];
    for (let bit = 0; bit < 8; bit++) {
        if (mask & (1 << bit)) {
            ids.push(bit);
        }
    }
    return ids;
}

/**
 * ArduPilot's onboard compass calibration (`MAV_CMD_DO_START_MAG_CAL`) runs
 * every requested compass in parallel: each streams its own
 * `MAG_CAL_PROGRESS` (completion percentage, plus which of the 80
 * coverage-sphere sections it's sampled — see `compassCalGrid.ts`) and finishes
 * with its own `MAG_CAL_REPORT` (pass/fail and fitness). Calibration as a
 * whole is done once every compass named in `cal_mask` has reported —
 * there's no single "finished" message for the group.
 *
 * Unlike accel/gyro, cancelling mid-calibration is a real, clean operation
 * here (`MAV_CMD_DO_CANCEL_MAG_CAL`) rather than a best-effort escape hatch.
 */
export function useCompassCalibration() {
    const [calibrating, setCalibrating] = useState(false);
    const [progress, setProgress] = useState<Map<number, CompassCalProgress>>(new Map());
    const [reports, setReports] = useState<Map<number, CompassCalReport>>(new Map());
    const [field, setField] = useState<MagField | null>(null);
    const [error, setError] = useState<string | null>(null);

    // Mirrored so the report handler can check "have all of them reported
    // yet" synchronously against the latest value, without waiting on a
    // render to see the previous report land.
    const reportsRef = useRef<Map<number, CompassCalReport>>(new Map());
    const calMaskRef = useRef<number | null>(null);

    const start = useCallback(async () => {
        setError(null);
        setProgress(new Map());
        setReports(new Map());
        setField(null);
        reportsRef.current = new Map();
        calMaskRef.current = null;
        setCalibrating(true);
        try {
            await sendVehicleCommand({type: "startCompassCalibration"});
        } catch (err) {
            setCalibrating(false);
            setError(message(err));
        }
    }, []);

    /** Drops the field arrow and hands RAW_IMU back to its default rate —
     * every way a calibration ends goes through here. */
    const stopFieldStream = useCallback(() => {
        setField(null);
        sendVehicleCommand({type: "stopCompassFieldStream"}).catch(() => {});
    }, []);

    const cancel = useCallback(() => {
        setCalibrating(false);
        stopFieldStream();
        sendVehicleCommand({type: "cancelCompassCalibration"}).catch((err) => setError(message(err)));
    }, [stopFieldStream]);

    /** Cancel and surface a specific "stalled" message — called by the panel
     * when progress stops advancing while the vehicle is still rotating. */
    const stallCancel = useCallback(() => {
        setCalibrating(false);
        stopFieldStream();
        setError("Progress stalled — rotate to cover the remaining sections and try again.");
        sendVehicleCommand({type: "cancelCompassCalibration"}).catch(() => {});
    }, [stopFieldStream]);

    useTauriEvent<MagCalProgressEvent>("mag-cal-progress", (payload) => {
        if (!calibrating) {
            return;
        }
        calMaskRef.current = payload.calMask;
        const coveredMask = Array.from({length: COMPASS_CAL_SECTION_COUNT}, (_, i) =>
            sectionCovered(payload.completionMask, i),
        );
        setProgress((current) => {
            const next = new Map(current);
            next.set(payload.compassId, {completionPct: payload.completionPct, coveredMask});
            return next;
        });
    });

    useTauriEvent<MagCalReportEvent>("mag-cal-report", (payload) => {
        if (!calibrating) {
            return;
        }
        const next = new Map(reportsRef.current);
        next.set(payload.compassId, {success: payload.calStatus === MAG_CAL_SUCCESS, fitness: payload.fitness, calStatus: payload.calStatus});
        reportsRef.current = next;
        setReports(next);

        const expected = idsInMask(calMaskRef.current ?? payload.calMask);
        if (expected.length > 0 && expected.every((id) => next.has(id))) {
            setCalibrating(false);
            stopFieldStream();
        }
    });

    useTauriEvent<MagField>("mag-field", (payload) => {
        if (calibrating) {
            setField(payload);
        }
    });

    // A reboot (the panel's "Reboot Vehicle" after a successful run) or a
    // lost link ends this calibration on the vehicle's side, and a reboot is
    // what applies it — so go back to the start screen rather than keep
    // showing "Reboot the vehicle" after it already happened.
    useTauriEvent<ConnectionStatus>("link-status", (status) => {
        if (status !== "rebooting" && status !== "lost" && status !== "disconnected" && status !== "error") return;
        setCalibrating(false);
        setProgress(new Map());
        setReports(new Map());
        setField(null);
        setError(null);
    });

    return {calibrating, progress, reports, field, error, start, cancel, stallCancel};
}
