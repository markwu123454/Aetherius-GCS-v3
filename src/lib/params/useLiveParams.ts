import {useCallback, useEffect, useRef, useState} from "react";
import {useTauriEvent} from "@/lib/tauriEvent.ts";
import {ConnectionStatus} from "@/lib/vehicle/connection.ts";
import {LiveParamEntry, ParamBatch, refreshParams, setParam as setParamCommand} from "./liveParams.ts";

export interface LiveParams {
    values: Map<string, LiveParamEntry>;
    /** `null` until the first value of a dump has arrived. */
    total: number | null;
    refresh: () => void;
    setParam: (name: string, value: number) => Promise<number>;
}

/**
 * Live parameter values, kept in step with the connection rather than the
 * page's own lifecycle. A link that stops being `connected` invalidates
 * every value on hand — a stale *parameter* being trusted is a configuration
 * mistake, not just a display one, so this clears outright on disconnect
 * rather than freezing-and-graying the way telemetry does.
 */
export function useLiveParams(connectionStatus: ConnectionStatus): LiveParams {
    const [values, setValues] = useState<Map<string, LiveParamEntry>>(new Map());
    const [total, setTotal] = useState<number | null>(null);

    const refresh = useCallback(async () => {
        setValues(new Map());
        setTotal(null);
        try {
            // `requireBackend()` inside this throws synchronously outside
            // Tauri, not as a rejection — the try/await here is what turns
            // that into something this function can actually catch.
            await refreshParams();
        } catch {
            // Nothing to show for it beyond `values` staying empty — this
            // runs from an effect as often as from a button press, so there
            // is no single place to surface an error message.
        }
    }, []);

    useTauriEvent<ParamBatch>("param-values", (batch) => {
        setValues((prev) => {
            const next = new Map(prev);
            for (const entry of batch.values) {
                next.set(entry.name, entry);
            }
            return next;
        });
        if (batch.total !== null) {
            setTotal(batch.total);
        }
    });

    // Runs the refresh once per connect, and forgets everything on the way
    // back down. `wasConnected` starting false means a page that mounts
    // while already connected still gets its first read.
    const wasConnected = useRef(false);
    useEffect(() => {
        const isConnected = connectionStatus === "connected";
        if (isConnected && !wasConnected.current) {
            refresh();
        } else if (!isConnected && wasConnected.current) {
            setValues(new Map());
            setTotal(null);
        }
        wasConnected.current = isConnected;
    }, [connectionStatus, refresh]);

    return {values, total, refresh, setParam: setParamCommand};
}
