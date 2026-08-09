import {useCallback, useEffect, useState} from "react";
import {arrayMove} from "@dnd-kit/sortable";
import {
    AnalysisFileState,
    getLogSeries,
    getLogTextEvents,
    loadAnalysisState,
    LogSummary,
    openLog,
    saveAnalysisState,
    SeriesResponse,
    TextEvent,
} from "./analysis.ts";

export interface AnalysisRow {
    id: string;
    messageType: string;
    field: string;
    label: string;
    /** `"boolean"` draws solid held-value segments colored red (false) /
     * green (true) — a real 0-or-nonzero field, unlike `"state"`'s
     * many-valued held segments (Mode), which a red/green split wouldn't
     * mean anything for. `"line"` draws a continuous autoscaled line —
     * everything a row is added for beyond the pinned defaults. */
    kind: "line" | "state" | "boolean";
    visible: boolean;
    /** Pixels — adjustable via the row's own resize handle. */
    height: number;
}

const DEFAULT_ROW_HEIGHT = 48;
const MIN_ROW_HEIGHT = 28;
const MAX_ROW_HEIGHT = 320;
/** How long to wait after the last rows/zoom change before writing the
 * sidecar `.json` — settling on a value rather than writing on every single
 * drag/resize/pan tick, which would otherwise mean a disk write per
 * animation frame while resizing or scrubbing the overview bar. */
const SAVE_DEBOUNCE_MS = 800;

function rowId(messageType: string, field: string): string {
    return `${messageType}.${field}`;
}

/** The rows with a custom (non-`Type.Field`) label and non-`"line"`
 * rendering — everything else is a generic line row labeled by its own
 * message type and field. */
const CUSTOM_ROWS: Record<string, {label: string; kind: "state" | "boolean"}> = {
    [rowId("ARM", "ArmState")]: {label: "Arm state", kind: "boolean"},
    [rowId("MODE", "Mode")]: {label: "Mode", kind: "state"},
};

function labelFor(messageType: string, field: string): string {
    return CUSTOM_ROWS[rowId(messageType, field)]?.label ?? `${messageType}.${field}`;
}

function kindFor(messageType: string, field: string): "line" | "state" | "boolean" {
    return CUSTOM_ROWS[rowId(messageType, field)]?.kind ?? "line";
}

/** Rows present the moment a log opens and nothing was saved for it yet —
 * Arm state and Mode give context for everything else on the timeline, so
 * they're pinned at the top by default rather than something the user has
 * to know to add. Still ordinary rows after that: hideable/removable/
 * resizable/reorderable like any other. Silently skipped if the log
 * doesn't have that message type at all (a very old firmware, or a log
 * trimmed to exclude it). */
function defaultRows(summary: LogSummary): AnalysisRow[] {
    const rows: AnalysisRow[] = [];
    for (const id of ["ARM.ArmState", "MODE.Mode"]) {
        const [messageType, field] = id.split(".");
        if (summary.messageTypes.some((m) => m.name === messageType)) {
            rows.push({
                id: rowId(messageType, field),
                messageType,
                field,
                label: labelFor(messageType, field),
                kind: kindFor(messageType, field),
                visible: true,
                height: DEFAULT_ROW_HEIGHT,
            });
        }
    }
    return rows;
}

function rowsFromSaved(state: AnalysisFileState): AnalysisRow[] {
    return state.rows.map((r) => ({
        id: rowId(r.messageType, r.field),
        messageType: r.messageType,
        field: r.field,
        label: labelFor(r.messageType, r.field),
        kind: kindFor(r.messageType, r.field),
        visible: r.visible,
        height: r.height ?? DEFAULT_ROW_HEIGHT,
    }));
}

/** Roughly a wide row's pixel width — asking the backend to decimate to
 * more points than a row can actually render would just move the same
 * rendering cost from "draw every sample" to "draw every decimated
 * sample," without changing what's visible. */
const MAX_POINTS_PER_ROW = 1200;

export interface VisibleRange {
    startUs: number;
    endUs: number;
}

/**
 * Drives the Log Analysis page: opens a log (restoring saved row layout
 * and zoom from its `.json` sidecar if there is one — see
 * `logs/analysis.rs`), tracks which rows are on the timeline and the
 * current zoom/pan window, and fetches each visible row's data from the
 * backend whenever what's needed changes. Series requests are grouped by
 * message type so e.g. two `RCIN` channel rows share one backend call
 * instead of one each. Row layout changes are saved back to the sidecar,
 * debounced, so reopening the same log later picks up where you left off.
 */
export function useLogAnalysis(path: string | null) {
    const [summary, setSummary] = useState<LogSummary | null>(null);
    const [opening, setOpening] = useState(false);
    const [openError, setOpenError] = useState<string | null>(null);
    // Guards the auto-save effect below from firing on the initial
    // `defaultRows()` placeholder that's set before a saved sidecar (if
    // any) has finished loading — without this, a slow disk read could
    // race a save that clobbers the very state it was about to restore.
    const [hydrated, setHydrated] = useState(false);

    const [rows, setRows] = useState<AnalysisRow[]>([]);
    const [seriesByType, setSeriesByType] = useState<Map<string, SeriesResponse>>(new Map());
    const [consoleEvents, setConsoleEvents] = useState<TextEvent[]>([]);

    const [visibleRange, setVisibleRange] = useState<VisibleRange | null>(null);
    const [playheadUs, setPlayheadUs] = useState(0);

    // (Re-)opens the log whenever `path` changes, resetting every derived
    // piece of state — a different file means a different timeline, not a
    // continuation of the last one's rows/zoom/playhead.
    useEffect(() => {
        setSummary(null);
        setRows([]);
        setSeriesByType(new Map());
        setConsoleEvents([]);
        setVisibleRange(null);
        setPlayheadUs(0);
        setOpenError(null);
        setHydrated(false);
        if (!path) {
            return;
        }
        let cancelled = false;
        setOpening(true);

        (async () => {
            const result = await openLog(path);
            if (cancelled) return;
            setSummary(result);

            const saved = await loadAnalysisState(path).catch(() => null);
            if (cancelled) return;

            setRows(saved && saved.rows.length > 0 ? rowsFromSaved(saved) : defaultRows(result));
            const startUs = saved?.startUs ?? result.startUs;
            const endUs = saved?.endUs ?? result.endUs;
            setVisibleRange({startUs, endUs});
            setPlayheadUs(startUs);
        })()
            .catch((err) => {
                if (!cancelled) setOpenError(err instanceof Error ? err.message : String(err));
            })
            .finally(() => {
                if (!cancelled) {
                    setOpening(false);
                    setHydrated(true);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [path]);

    // Refetches every visible row's series whenever the row set or the
    // visible window changes. Hidden rows are skipped entirely — no point
    // fetching data nobody's looking at.
    useEffect(() => {
        if (!path || !visibleRange) {
            return;
        }
        const byType = new Map<string, string[]>();
        for (const row of rows) {
            if (!row.visible) continue;
            const fields = byType.get(row.messageType) ?? [];
            if (!fields.includes(row.field)) fields.push(row.field);
            byType.set(row.messageType, fields);
        }
        if (byType.size === 0) {
            setSeriesByType(new Map());
            return;
        }
        let cancelled = false;
        Promise.all(
            Array.from(byType.entries()).map(([messageType, fields]) =>
                getLogSeries(path, messageType, fields, {
                    startUs: visibleRange.startUs,
                    endUs: visibleRange.endUs,
                    maxPoints: MAX_POINTS_PER_ROW,
                }).then((response) => [messageType, response] as const),
            ),
        )
            .then((results) => {
                if (!cancelled) setSeriesByType(new Map(results));
            })
            .catch(() => {
                // A failed fetch leaves rows with stale/empty data rather
                // than taking the whole page down — nothing draws for them
                // until the next successful fetch.
            });
        return () => {
            cancelled = true;
        };
        // `rows` includes label/kind/height churn that doesn't affect what's
        // fetched — the effect body only reacts to messageType/field/
        // visible, but re-deriving `byType` is cheap enough that filtering
        // the dependency array itself isn't worth the complexity.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [path, rows, visibleRange]);

    // Console row: fetched once per log rather than on every window change
    // — event lists aren't decimated (see `getLogTextEvents`), so there's
    // no extra resolution to gain by re-fetching as the window moves.
    // Filtering to the visible range happens client-side at render time.
    useEffect(() => {
        if (!path || !summary || !summary.messageTypes.some((m) => m.name === "MSG")) {
            return;
        }
        let cancelled = false;
        getLogTextEvents(path, "MSG", "Message")
            .then((events) => {
                if (!cancelled) setConsoleEvents(events);
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [path, summary]);

    // Saves row layout + zoom back to the sidecar, debounced so a drag
    // (resize, reorder, or the overview bar's pan/zoom) writes once after
    // it settles rather than on every intermediate tick.
    useEffect(() => {
        if (!path || !hydrated || !visibleRange) {
            return;
        }
        const handle = setTimeout(() => {
            const state: AnalysisFileState = {
                rows: rows.map((r) => ({messageType: r.messageType, field: r.field, visible: r.visible, height: r.height})),
                startUs: visibleRange.startUs,
                endUs: visibleRange.endUs,
            };
            void saveAnalysisState(path, state).catch(() => {});
        }, SAVE_DEBOUNCE_MS);
        return () => clearTimeout(handle);
    }, [path, hydrated, rows, visibleRange]);

    const addRow = useCallback((messageType: string, field: string) => {
        setRows((prev) => {
            const id = rowId(messageType, field);
            if (prev.some((r) => r.id === id)) {
                return prev;
            }
            return [
                ...prev,
                {id, messageType, field, label: labelFor(messageType, field), kind: kindFor(messageType, field), visible: true, height: DEFAULT_ROW_HEIGHT},
            ];
        });
    }, []);

    const removeRow = useCallback((id: string) => {
        setRows((prev) => prev.filter((r) => r.id !== id));
    }, []);

    const toggleRow = useCallback((id: string) => {
        setRows((prev) => prev.map((r) => (r.id === id ? {...r, visible: !r.visible} : r)));
    }, []);

    const resizeRow = useCallback((id: string, deltaPx: number) => {
        setRows((prev) =>
            prev.map((r) => (r.id === id ? {...r, height: Math.min(MAX_ROW_HEIGHT, Math.max(MIN_ROW_HEIGHT, r.height + deltaPx))} : r)),
        );
    }, []);

    /** Scales every row's height by `factor` at once, each clamped
     * independently — the DAW/video-editor "vertical zoom" gesture (all
     * tracks grow or shrink together, proportionally to their current
     * size, rather than resetting to one uniform height). A row already
     * pinned at the min/max clamp stops scaling before the others do,
     * same as time-zoom clamping at the log's own bounds. */
    const resizeAllRows = useCallback((factor: number) => {
        setRows((prev) =>
            prev.map((r) => ({...r, height: Math.min(MAX_ROW_HEIGHT, Math.max(MIN_ROW_HEIGHT, Math.round(r.height * factor)))})),
        );
    }, []);

    /** Moves the row with id `activeId` to the position currently held by
     * `overId` — the shape dnd-kit's `onDragEnd` hands back directly. */
    const reorderRows = useCallback((activeId: string, overId: string) => {
        setRows((prev) => {
            const fromIndex = prev.findIndex((r) => r.id === activeId);
            const toIndex = prev.findIndex((r) => r.id === overId);
            if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) {
                return prev;
            }
            return arrayMove(prev, fromIndex, toIndex);
        });
    }, []);

    // Zooms around `centerUs` by `factor` (<1 zooms in, >1 zooms out),
    // clamped to the log's own full range — panning/zooming out into empty
    // space beyond what was actually recorded isn't useful.
    const zoom = useCallback(
        (factor: number, centerUs: number) => {
            setVisibleRange((prev) => {
                if (!prev || !summary) return prev;
                const fullWidth = summary.endUs - summary.startUs || 1;
                const width = prev.endUs - prev.startUs;
                const newWidth = Math.max(1000, Math.min(fullWidth, width * factor));
                const ratio = (centerUs - prev.startUs) / (width || 1);
                let start = centerUs - newWidth * ratio;
                let end = start + newWidth;
                if (start < summary.startUs) {
                    end += summary.startUs - start;
                    start = summary.startUs;
                }
                if (end > summary.endUs) {
                    start -= end - summary.endUs;
                    end = summary.endUs;
                }
                return {startUs: Math.max(summary.startUs, start), endUs: Math.min(summary.endUs, end)};
            });
        },
        [summary],
    );

    const pan = useCallback(
        (deltaUs: number) => {
            setVisibleRange((prev) => {
                if (!prev || !summary) return prev;
                const width = prev.endUs - prev.startUs;
                let start = prev.startUs + deltaUs;
                let end = prev.endUs + deltaUs;
                if (start < summary.startUs) {
                    start = summary.startUs;
                    end = start + width;
                }
                if (end > summary.endUs) {
                    end = summary.endUs;
                    start = end - width;
                }
                return {startUs: start, endUs: end};
            });
        },
        [summary],
    );

    return {
        summary,
        opening,
        openError,
        rows,
        addRow,
        removeRow,
        toggleRow,
        resizeRow,
        resizeAllRows,
        reorderRows,
        seriesByType,
        consoleEvents,
        visibleRange,
        playheadUs,
        setPlayheadUs,
        zoom,
        pan,
    };
}

export type UseLogAnalysis = ReturnType<typeof useLogAnalysis>;
