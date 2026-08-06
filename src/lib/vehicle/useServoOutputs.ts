import {useSyncExternalStore} from "react";
import {listen} from "@tauri-apps/api/event";
import {createStore} from "@/lib/store.ts";
import {ConnectionStatus} from "./connection.ts";

interface ServoOutputEvent {
    port: number;
    channels: number[];
}

const servoOutputsStore = createStore<Map<number, number>>(new Map());

listen<ServoOutputEvent>("servo-outputs", (event) => {
    const {port, channels} = event.payload;
    const base = port * 8 + 1;
    servoOutputsStore.update((prev) => {
        const next = new Map(prev);
        channels.forEach((pwm, i) => {
            next.set(base + i, pwm);
        });
        return next;
    });
}).catch(() => {});

listen<ConnectionStatus>("link-status", (event) => {
    const status = event.payload;
    if (status !== "connected" && status !== "connecting" && status !== "losing") {
        servoOutputsStore.set(new Map());
    }
}).catch(() => {});

/** Live PWM output per channel (1-indexed). Empty map until the first
 * SERVO_OUTPUT_RAW arrives; clears when the link goes idle. */
export function useServoOutputs(): Map<number, number> {
    return useSyncExternalStore(servoOutputsStore.subscribe, servoOutputsStore.getSnapshot);
}
