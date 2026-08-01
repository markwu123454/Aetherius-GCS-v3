import {useSyncExternalStore} from "react";
import {createStore} from "@/lib/store.ts";
import {getVehicleSnapshot} from "./useVehicle.ts";

export interface TelemetryHistoryPoint {
    voltage: number;
    vibe: number;
    lossPercent: number;
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

/**
 * Sampled on its own module-level timers rather than in a component effect, so
 * the ten-minute window keeps accumulating whether or not `TelemetryPanel` is
 * currently mounted — a hidden tab or a closed panel should reopen onto a
 * trace that already covers what happened while it was away, not an empty one.
 *
 * Capture and record run at different rates on purpose. Recording one point a
 * second, each averaged from five captures, smooths out packet-to-packet
 * jitter (radio RSSI bounce, instantaneous vibration readings) that would
 * otherwise show up as noise in a 100px-wide line — capturing faster than
 * that would just add more jitter to average away, not more information a
 * sparkline could actually show.
 *
 * Keeps sampling even while the link is stale, so a flatlined trace is
 * visible truth ("this stopped changing") rather than a gap.
 */
window.setInterval(() => {
    const current = getVehicleSnapshot();
    captureBuffer.push({
        voltage: current.battery.voltage,
        vibe: current.ekf.vibe,
        lossPercent: current.link.lossPercent,
    });
}, CAPTURE_INTERVAL_MS);

window.setInterval(() => {
    if (captureBuffer.length === 0) {
        return;
    }
    const point: TelemetryHistoryPoint = {
        voltage: average(captureBuffer, "voltage"),
        vibe: average(captureBuffer, "vibe"),
        lossPercent: average(captureBuffer, "lossPercent"),
    };
    captureBuffer = [];
    historyStore.update((prev) => [...prev, point].slice(-WINDOW_LENGTH));
}, RECORD_INTERVAL_MS);

export function useTelemetryHistory(): TelemetryHistoryPoint[] {
    return useSyncExternalStore(historyStore.subscribe, historyStore.getSnapshot);
}
