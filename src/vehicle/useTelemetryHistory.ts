import {useEffect, useRef, useState} from "react";
import {VehicleState} from "./vehicle";

export interface TelemetryHistoryPoint {
    voltage: number;
    hdop: number;
    vibe: number;
    lossPercent: number;
}

const SAMPLE_INTERVAL_MS = 2_000;
/** 60 samples at 2s apart is 2 minutes of history — long enough to see a slow
 * battery sag or a GPS fix degrading, short enough to stay readable at
 * sparkline width. */
const WINDOW_LENGTH = 60;

/**
 * Sparklines want a steady, slow cadence, not the backend's ~10Hz packet
 * rate — sampling every packet would pack two minutes into thousands of
 * points no 100px-wide line can show. A fixed interval decouples the
 * sparkline's resolution from however fast telemetry happens to be arriving.
 *
 * Keeps sampling even while the link is stale, so a flatlined trace is
 * visible truth ("this stopped changing") rather than a gap.
 */
export function useTelemetryHistory(vehicle: VehicleState): TelemetryHistoryPoint[] {
    const [history, setHistory] = useState<TelemetryHistoryPoint[]>([]);
    const latest = useRef(vehicle);
    latest.current = vehicle;

    useEffect(() => {
        const timer = window.setInterval(() => {
            const current = latest.current;
            const point: TelemetryHistoryPoint = {
                voltage: current.battery.voltage,
                hdop: current.gps.hdop,
                vibe: current.ekf.vibe,
                lossPercent: current.link.lossPercent,
            };
            setHistory((prev) => [...prev, point].slice(-WINDOW_LENGTH));
        }, SAMPLE_INTERVAL_MS);

        return () => window.clearInterval(timer);
    }, []);

    return history;
}
