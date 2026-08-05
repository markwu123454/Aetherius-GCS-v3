import {useSyncExternalStore} from "react";
import {createStore} from "@/lib/store.ts";
import {getVehicleSnapshot} from "./useVehicle.ts";

const sparklinesStore = createStore<boolean>(true);
export function setSparklinesEnabled(val: boolean): void { sparklinesStore.set(val); }
export function useTelemetrySparklines(): boolean {
    return useSyncExternalStore(sparklinesStore.subscribe, sparklinesStore.getSnapshot);
}

export interface TelemetryHistoryPoint {
    voltage: number;
    /** Alongside `voltage` rather than derived from it — `batteryTone`'s
     * thresholds are percent-based, and percent isn't a fixed function of
     * voltage alone (it also depends on cell count/chemistry), so per-point
     * tone needs the percent that was actually live at that sample. */
    percent: number;
    vibe: number;
    lossPercent: number;
    rssi: number;
}

const CAPTURE_INTERVAL_MS = 200;
const RECORD_INTERVAL_MS = 1_000;
/** 600 samples at 1s apart is 10 minutes of history — long enough to see a
 * slow battery sag or a GPS fix degrading, short enough to stay readable at
 * sparkline width. */
const WINDOW_LENGTH = 600;

const historyStore = createStore<TelemetryHistoryPoint[]>([]);

let captureBuffer: TelemetryHistoryPoint[] = [];

function average(points: TelemetryHistoryPoint[], key: keyof TelemetryHistoryPoint): number {
    return points.reduce((sum, point) => sum + point[key], 0) / points.length;
}

function peak(points: TelemetryHistoryPoint[], key: keyof TelemetryHistoryPoint): number {
    return points.reduce((max, point) => Math.max(max, point[key]), 0);
}

/**
 * Sampled on its own module-level timers rather than in a component effect, so
 * the ten-minute window keeps accumulating whether or not `TelemetryPanel` is
 * currently mounted — a hidden tab or a closed panel should reopen onto a
 * trace that already covers what happened while it was away, not an empty one.
 *
 * Capture and record run at different rates on purpose. Recording one point a
 * second, averaged from five captures, smooths out packet-to-packet jitter
 * (radio RSSI bounce) that would otherwise show up as noise in a 100px-wide
 * line — capturing faster than that would just add more jitter to average
 * away, not more information a sparkline could actually show.
 *
 * Vibration is recorded as that same second's *peak* instead, not its
 * average — it's a spike metric, not a trend, and a brief bad reading
 * (throttling up, a gust) matters even if it only lasted one 200ms capture.
 * Averaging it the same way as voltage would smooth a real spike down to
 * looking like nothing happened.
 *
 * Keeps sampling even while the link is stale, so a flatlined trace is
 * visible truth ("this stopped changing") rather than a gap.
 */
window.setInterval(() => {
    const current = getVehicleSnapshot();
    captureBuffer.push({
        voltage: current.battery.voltage,
        percent: current.battery.percent,
        vibe: current.ekf.vibe,
        lossPercent: current.link.lossPercent,
        rssi: current.link.rssi,
    });
}, CAPTURE_INTERVAL_MS);

window.setInterval(() => {
    if (captureBuffer.length === 0) {
        return;
    }
    const point: TelemetryHistoryPoint = {
        voltage: average(captureBuffer, "voltage"),
        percent: average(captureBuffer, "percent"),
        vibe: peak(captureBuffer, "vibe"),
        lossPercent: average(captureBuffer, "lossPercent"),
        rssi: average(captureBuffer, "rssi"),
    };
    captureBuffer = [];
    historyStore.update((prev) => [...prev, point].slice(-WINDOW_LENGTH));
}, RECORD_INTERVAL_MS);

export function useTelemetryHistory(): TelemetryHistoryPoint[] {
    return useSyncExternalStore(historyStore.subscribe, historyStore.getSnapshot);
}
