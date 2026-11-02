import {useSyncExternalStore} from "react";
import {listen} from "@tauri-apps/api/event";
import {createStore} from "@/lib/store.ts";
import {ConnectionStatus} from "@/lib/vehicle/connection.ts";

interface RcChannelsEvent {
    /** Raw microsecond PWM per channel, index 0 = channel 1. Only the
     * channels the vehicle actually reported (`link.rs`'s `on_rc_channels`
     * clamps to `chancount`), not a fixed 18-wide array. */
    channels: number[];
}

/** How long the last RC_CHANNELS is trusted once they stop arriving. Past
 * this the sticks read as unknown rather than frozen where they last were,
 * which looked live (the ball stays highlighted) while showing nothing. */
const STALE_AFTER_MS = 3_000;

const rcChannelsStore = createStore<number[] | null>(null);
let staleTimer: number | undefined;

listen<RcChannelsEvent>("rc-channels", (event) => {
    const channels = event.payload.channels;
    rcChannelsStore.set(channels.length > 0 ? channels : null);
    window.clearTimeout(staleTimer);
    staleTimer = window.setTimeout(() => rcChannelsStore.set(null), STALE_AFTER_MS);
}).catch(() => {
    // No Tauri backend — the store just never updates.
});

// Same reset `useServoOutputs` does: one vehicle's stick positions must not
// carry over into the next connection as if they were current.
listen<ConnectionStatus>("link-status", (event) => {
    const status = event.payload;
    if (status !== "connected" && status !== "connecting" && status !== "losing") {
        window.clearTimeout(staleTimer);
        rcChannelsStore.set(null);
    }
}).catch(() => {});

/**
 * Latest raw RC channel values, or `null` before the first packet arrives,
 * once they stop arriving, or after the link drops — or if RC_CHANNELS keeps
 * reporting a `chancount` of zero, which is what ArduPilot sends when no
 * receiver is bound at all, so an empty packet reads the same as no packet
 * rather than as "zero channels of live data". Requested at 20Hz alongside
 * attitude/position (see `request_data_streams` in `link.rs`) so this feels
 * live while a calibration panel is open.
 */
export function useRcChannels(): number[] | null {
    return useSyncExternalStore(rcChannelsStore.subscribe, rcChannelsStore.getSnapshot);
}
