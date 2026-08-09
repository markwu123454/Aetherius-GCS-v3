import {invoke} from "@tauri-apps/api/core";
import {requireBackend} from "@/lib/vehicle/connection.ts";

/** One message type present in a parsed log, as reported by `open_log` —
 * every field name it declares (via its own `FMT` record) and how many
 * records of it the log contains. */
export interface MessageTypeSummary {
    name: string;
    fields: string[];
    count: number;
}

export interface LogSummary {
    messageTypes: MessageTypeSummary[];
    /** Microseconds since boot, from the log's own `TimeUS` fields — not
     * wall-clock time. `startUs`/`endUs` bound the timeline's overview. */
    startUs: number;
    endUs: number;
}

/**
 * Parses the whole log at `path` once (backed by `logs/parser.rs`'s
 * `FMT`-driven decoder) and returns what's in it. The backend caches the
 * parsed offset index by path for the rest of the session, so calling this
 * again for the same path is cheap — later `getLogSeries`/
 * `getLogTextEvents` calls reuse that index rather than re-parsing.
 */
export function openLog(path: string): Promise<LogSummary> {
    requireBackend();
    return invoke<LogSummary>("open_log", {path});
}

export interface SeriesResponse {
    timeUs: number[];
    /** Keyed by the field names passed to `getLogSeries`, each the same
     * length as `timeUs`. A value is `NaN` if that record didn't decode
     * the field (shouldn't happen for a field `openLog` reported, but
     * isn't assumed away). */
    series: Record<string, number[]>;
}

/**
 * Extracts one or more numeric fields of `messageType` for a timeline row.
 * `startUs`/`endUs` scope the query to the currently visible time window;
 * `maxPoints` (typically the row's pixel width) asks the backend to
 * decimate rather than ship every raw sample — re-call with a narrower
 * range as the timeline zooms in for finer resolution.
 */
export function getLogSeries(
    path: string,
    messageType: string,
    fields: string[],
    options?: {startUs?: number; endUs?: number; maxPoints?: number},
): Promise<SeriesResponse> {
    requireBackend();
    return invoke<SeriesResponse>("get_log_series", {
        path,
        messageType,
        fields,
        startUs: options?.startUs,
        endUs: options?.endUs,
        maxPoints: options?.maxPoints,
    });
}

export interface TextEvent {
    timeUs: number;
    text: string;
}

/**
 * Extracts one text (or number-stringified) field of `messageType` as a
 * time-ordered list of events — every occurrence, never decimated. Used
 * for the console row (`MSG`/`Message`) and other sparse discrete-event
 * rows, as opposed to `getLogSeries`'s dense numeric lines.
 */
export function getLogTextEvents(path: string, messageType: string, field: string): Promise<TextEvent[]> {
    requireBackend();
    return invoke<TextEvent[]>("get_log_text_events", {path, messageType, field});
}

export interface AnalysisRowState {
    messageType: string;
    field: string;
    visible: boolean;
    /** Row height in pixels. `undefined` for a row that's never been
     * resized — the frontend's own default applies. */
    height?: number;
}

export interface AnalysisFileState {
    /** Order in the array is display order. */
    rows: AnalysisRowState[];
    startUs?: number;
    endUs?: number;
}

/**
 * Reads the saved analysis state for the log at `path` — a `<id>.json`
 * sidecar next to the `.bin` (see `logs/analysis.rs`), holding which rows
 * were on the timeline, their order/visibility/height, and the
 * last-viewed time window. `null` if this log has never been analyzed
 * before, not an error.
 */
export async function loadAnalysisState(path: string): Promise<AnalysisFileState | null> {
    requireBackend();
    return invoke<AnalysisFileState | null>("load_analysis_state", {path});
}

/** Writes the sidecar `.json` for the log at `path`. Overwrites whatever
 * was there — always the full current state, not a diff. */
export function saveAnalysisState(path: string, state: AnalysisFileState): Promise<void> {
    requireBackend();
    return invoke("save_analysis_state", {path, state});
}
