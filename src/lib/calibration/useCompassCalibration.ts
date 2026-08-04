import {useCallback, useRef, useState} from "react";
import {sendVehicleCommand} from "@/lib/vehicle/commands.ts";
import {useTauriEvent} from "@/lib/tauriEvent.ts";
import {MAG_CAL_SECTION_COUNT, sectionCovered} from "./magCalGrid.ts";

/** ArduPilot's `MagCalStatus::MAG_CAL_SUCCESS`. */
const MAG_CAL_SUCCESS = 4;

export interface CompassCalProgress {
    completionPct: number;
    /** Length `MAG_CAL_SECTION_COUNT`, index-aligned with `magCalGrid.ts`. */
    coveredMask: boolean[];
}

export interface CompassCalReport {
    success: boolean;
    /** RMS milligauss residual from ArduPilot's ellipsoid fit — lower is
     * better. The one calibration in this app with a real quality number. */
    fitness: number;
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
 * coverage-sphere sections it's sampled — see `magCalGrid.ts`) and finishes
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
        reportsRef.current = new Map();
        calMaskRef.current = null;
        try {
            await sendVehicleCommand({type: "startCompassCalibration"});
            setCalibrating(true);
        } catch (err) {
            setError(message(err));
        }
    }, []);

    const cancel = useCallback(() => {
        setCalibrating(false);
        sendVehicleCommand({type: "cancelCompassCalibration"}).catch((err) => setError(message(err)));
    }, []);

    useTauriEvent<MagCalProgressEvent>("mag-cal-progress", (payload) => {
        if (!calibrating) {
            return; // stale event from a calibration this session no longer owns
        }
        calMaskRef.current = payload.calMask;
        const coveredMask = Array.from({length: MAG_CAL_SECTION_COUNT}, (_, i) =>
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
        next.set(payload.compassId, {success: payload.calStatus === MAG_CAL_SUCCESS, fitness: payload.fitness});
        reportsRef.current = next;
        setReports(next);

        const expected = idsInMask(calMaskRef.current ?? payload.calMask);
        if (expected.length > 0 && expected.every((id) => next.has(id))) {
            setCalibrating(false);
        }
    });

    return {calibrating, progress, reports, error, start, cancel};
}
