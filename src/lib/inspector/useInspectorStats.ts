import {useMemo, useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {useTauriEvent} from "@/lib/tauriEvent.ts";
import {useNow} from "@/lib/vehicle/useMockVehicle.ts";
import type {InspectorRow} from "./inspector.ts";

/** How often the displayed age ticks up between backend snapshots — well
 * under the backend's own 200ms emit interval, so the number never visibly
 * jumps backward when a fresh snapshot lands. */
const TICK_MS = 100;

export interface InspectorStatsApi {
    rows: InspectorRow[];
    clear: () => void;
}

/**
 * Mirrors the backend's whole stats table on every `inspector-stats` event
 * (throttled to 5 Hz there — see `inspector.rs`), so this replaces the
 * array outright each time rather than merging: the backend snapshot is
 * always complete and always authoritative, same reasoning as `vehicle`'s
 * per-field snapshot elsewhere in this app.
 *
 * `ageMs` on each row is only accurate as of the instant that snapshot was
 * taken — between snapshots it would otherwise sit frozen for up to 200ms
 * at a time. Since the frontend's clock runs at the same rate as the
 * backend's, the gap is just `now - receivedAt`: added on top of the
 * snapshot's own `ageMs` and re-computed on every `useNow` tick, so the age
 * counts up smoothly instead of stepping.
 */
export function useInspectorStats(): InspectorStatsApi {
    const [snapshot, setSnapshot] = useState<{rows: InspectorRow[]; receivedAt: number}>(
        () => ({rows: [], receivedAt: Date.now()}),
    );
    const now = useNow(TICK_MS);

    useTauriEvent<InspectorRow[]>("inspector-stats", (rows) => {
        setSnapshot({rows, receivedAt: Date.now()});
    });

    const clear = () => {
        setSnapshot({rows: [], receivedAt: Date.now()});
        void invoke("reset_inspector_stats").catch(() => {});
    };

    // Clamped to 0: right after a snapshot lands, `now` can still reflect
    // the previous tick (up to `TICK_MS` old) and read earlier than
    // `receivedAt` — a visible jump backward for one tick otherwise.
    const elapsed = Math.max(0, now - snapshot.receivedAt);
    const rows = useMemo(
        () => snapshot.rows.map((row) => ({...row, ageMs: row.ageMs + elapsed})),
        [snapshot, elapsed],
    );

    return {rows, clear};
}
