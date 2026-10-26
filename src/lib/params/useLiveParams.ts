import {useSyncExternalStore} from "react";
import {listen} from "@tauri-apps/api/event";
import {createStore} from "@/lib/store.ts";
import {clearStatus, setStatus} from "@/lib/topBarStatus.ts";
import {ConnectionStatus} from "@/lib/vehicle/connection.ts";
import {LiveParamEntry, ParamBatch, refreshParams, setParam as setParamCommand} from "./liveParams.ts";

export interface LiveParams {
    values: Map<string, LiveParamEntry>;
    /** `null` until the first value of a dump has arrived. */
    total: number | null;
    refresh: () => void;
    setParam: (name: string, value: number) => Promise<number>;
}

interface ParamsState {
    values: Map<string, LiveParamEntry>;
    total: number | null;
}

const paramsStore = createStore<ParamsState>({values: new Map(), total: null});

function refresh(): void {
    paramsStore.set({values: new Map(), total: null});
    // `refreshParams()` throws synchronously (not a rejected promise) when
    // there's no Tauri backend at all — wrapped in an `async` IIFE so that's
    // caught the same way a real rejection would be, same reasoning the old
    // per-page hook used.
    void (async () => {
        try {
            await refreshParams();
        } catch {
            // Nothing to show for it beyond `values` staying empty.
        }
    })();
}

listen<ParamBatch>("param-values", (message) => {
    paramsStore.update((prev) => {
        const next = new Map(prev.values);
        for (const entry of message.payload.values) {
            next.set(entry.name, entry);
        }
        return {values: next, total: message.payload.total ?? prev.total};
    });
}).catch(() => {
    // No Tauri backend — the store just never updates.
});

/**
 * Live parameter values, kept in step with the connection rather than any
 * one page's lifecycle — a persistent module-scope store (see `store.ts`),
 * the same pattern `vehicleStore` uses, rather than a `useState` any page
 * that reads params owned independently. Before this, `Parameters`,
 * `Calibration`, `Setup`, and `Scripting` each held their own copy and each
 * re-ran the full parameter dump on their own first mount after a connect —
 * visiting a second page after the first meant waiting through the whole
 * dump again for no reason. Now the dump runs once per connect, and every
 * page just reads the same cache.
 *
 * A link that stops being `connected` invalidates every value on hand — a
 * stale *parameter* being trusted is a configuration mistake, not just a
 * display one, so this clears outright on disconnect rather than
 * freezing-and-graying the way telemetry does.
 */
// True once refresh() has been called for the current connection. Reset when
// the link leaves the "connected/losing" cluster so the next connection
// triggers a fresh dump. Prevents losing→connected oscillations (which happen
// whenever heartbeats are delayed during a slow param dump) from firing
// repeated PARAM_REQUEST_LIST resets that keep the dump from completing.
let haveParams = false;

listen<ConnectionStatus>("link-status", (event) => {
    const status = event.payload;
    if (status === "connected") {
        if (!haveParams) {
            haveParams = true;
            refresh();
        }
        // losing → connected while a dump is in progress: socket is still open,
        // accumulated values are still valid — do nothing.
    } else if (status !== "connecting" && status !== "losing") {
        // disconnecting, rebooting, disconnected, lost, error — the current
        // connection (and its in-progress dump) is done; clear so the next
        // connect starts fresh.
        haveParams = false;
        paramsStore.set({values: new Map(), total: null});
    }
}).catch(() => {
    // No Tauri backend — the store just never updates.
});

// Read progress in the top bar while a dump is under way — from the first
// request until every value is in, or the link drops.
paramsStore.subscribe(() => {
    const {values, total} = paramsStore.getSnapshot();
    if (!haveParams || (total !== null && values.size >= total)) {
        clearStatus("params");
    } else if (total === null) {
        setStatus("params", "Reading parameters…");
    } else {
        setStatus("params", [{text: "Reading parameters "}, {text: `${values.size}/${total}`, tone: "info"}]);
    }
});

export function useLiveParams(): LiveParams {
    const state = useSyncExternalStore(paramsStore.subscribe, paramsStore.getSnapshot);
    return {...state, refresh, setParam: setParamCommand};
}
