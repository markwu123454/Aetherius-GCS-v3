import {useEffect, useRef} from "react";
import {useSortable} from "@dnd-kit/sortable";
import {CSS} from "@dnd-kit/utilities";
import {Draggable, TrashCan, View, ViewOff} from "@carbon/icons-react";
import {AnalysisRow} from "@/lib/logs/useLogAnalysis.ts";
import {SeriesResponse} from "@/lib/logs/analysis.ts";
import Splitter from "@/components/Splitter.tsx";
import {cssVar, drawLine, drawPlayhead, drawState, prepareCanvas, rowColorToken} from "./draw.ts";

/** Nearest-*prior*-sample lookup rather than interpolation — a log is a
 * sequence of discrete records, and showing the exact logged value held at
 * the playhead is more honest than interpolating one that was never
 * actually recorded. Returns `undefined` outside `[times[0], times[last]]`
 * — before the first record or after the last, there's no data to report,
 * matching the gray "unknown" fill `drawLine`/`drawState` draw for the
 * same stretch rather than confidently printing a boundary value the
 * chart itself is showing as unconfirmed. */
function valueAt(times: number[], values: number[], timeUs: number): number | undefined {
    if (times.length === 0 || timeUs < times[0] || timeUs > times[times.length - 1]) {
        return undefined;
    }
    let lo = 0;
    let hi = times.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (times[mid] <= timeUs) lo = mid;
        else hi = mid - 1;
    }
    return values[lo];
}

interface TimelineRowProps {
    row: AnalysisRow;
    /** Response for this row's whole message type — several rows can share
     * one (e.g. two `RCIN` channels), so this isn't scoped to `row.field`
     * until render time. */
    series: SeriesResponse | undefined;
    colorIndex: number;
    startUs: number;
    endUs: number;
    playheadUs: number;
    onToggle: () => void;
    onRemove: () => void;
    onResize: (deltaPx: number) => void;
}

/**
 * One timeline row. Draggable (via `@dnd-kit/sortable` — see
 * `LogAnalysisPage`'s `DndContext`) by its handle only, so grabbing
 * anywhere else in the row — the eye/trash buttons, the canvas itself —
 * doesn't start a reorder. Resizable via `Splitter`, the same handle
 * component the dock workspace uses for panel resizing.
 */
export default function TimelineRow({row, series, colorIndex, startUs, endUs, playheadUs, onToggle, onRemove, onResize}: TimelineRowProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const times = series?.timeUs ?? [];
    const values = series?.series[row.field];

    const {attributes, listeners, setNodeRef, transform, transition, isDragging} = useSortable({id: row.id});
    const sortableStyle = {
        transform: CSS.Translate.toString(transform),
        transition,
        // `zIndex` only takes effect inside a positioning context — without
        // `relative` here it would silently do nothing while dragging.
        position: isDragging ? ("relative" as const) : undefined,
        zIndex: isDragging ? 1 : undefined,
    };

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !row.visible) {
            return;
        }
        const ctx = prepareCanvas(canvas);
        if (!ctx) {
            return;
        }
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        const scale = {startUs, endUs, width};

        if (values && times.length > 0) {
            const neutral = cssVar(canvas, "--color-gray-60", "#6f6f6f");
            if (row.kind === "boolean") {
                const trueColor = cssVar(canvas, "--color-state-ok", "#42be65");
                const falseColor = cssVar(canvas, "--color-state-danger", "#fa4d56");
                drawState(ctx, scale, height, times, values, (v) => (v !== 0 ? trueColor : falseColor), neutral);
            } else if (row.kind === "state") {
                const okColor = cssVar(canvas, "--color-state-ok", "#42be65");
                drawState(ctx, scale, height, times, values, () => okColor, neutral);
            } else {
                const color = cssVar(canvas, rowColorToken(colorIndex), "#4589ff");
                drawLine(ctx, scale, height, times, values, color, neutral);
            }
        }

        drawPlayhead(ctx, scale, height, playheadUs, cssVar(canvas, "--color-border-strong", "#6f6f6f"));
        // `row.height` isn't read directly here, but the canvas's own
        // clientHeight depends on it — redrawing when it changes keeps the
        // chart filling the resized row instead of the stale pre-resize
        // height until something else happens to trigger a redraw.
    }, [row.kind, row.visible, row.height, times, values, colorIndex, startUs, endUs, playheadUs]);

    if (!row.visible) {
        return (
            <div ref={setNodeRef} style={sortableStyle} className="flex items-center gap-2 border-b border-border-subtle bg-background px-2 py-1">
                <button
                    type="button"
                    {...attributes}
                    {...listeners}
                    className="cursor-grab text-text-secondary hover:text-text-primary active:cursor-grabbing"
                    aria-label="Drag to reorder"
                    title="Drag to reorder"
                >
                    <Draggable size={14}/>
                </button>
                <button type="button" onClick={onToggle} className="text-text-secondary hover:text-text-primary" aria-label="Show row" title="Show row">
                    <ViewOff size={14}/>
                </button>
                <span className="truncate text-micro text-text-helper">{row.label}</span>
                <button
                    type="button"
                    onClick={onRemove}
                    className="ml-auto text-text-secondary hover:text-state-danger"
                    aria-label="Remove row"
                    title="Remove row"
                >
                    <TrashCan size={14}/>
                </button>
            </div>
        );
    }

    const readout = values ? valueAt(times, values, playheadUs) : undefined;
    const readoutText =
        readout === undefined ? "—" : row.kind === "boolean" ? (readout !== 0 ? "True" : "False") : readout.toFixed(2);
    const readoutClass =
        row.kind === "boolean" && readout !== undefined ? (readout !== 0 ? "text-state-ok" : "text-state-danger") : "text-text-helper";

    return (
        <div ref={setNodeRef} style={sortableStyle} className="flex flex-col bg-background">
            <div className="flex border-b border-border-subtle" style={{height: row.height}}>
                <div className="flex w-40 shrink-0 items-stretch gap-1 border-r border-border-subtle px-1 py-1">
                    <button
                        type="button"
                        {...attributes}
                        {...listeners}
                        className="flex shrink-0 cursor-grab items-center text-text-secondary hover:text-text-primary active:cursor-grabbing"
                        aria-label="Drag to reorder"
                        title="Drag to reorder"
                    >
                        <Draggable size={14}/>
                    </button>
                    <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
                        <span className="truncate text-label text-text-primary" title={row.label}>
                            {row.label}
                        </span>
                        <span className={`text-micro ${readoutClass}`}>{readoutText}</span>
                    </div>
                </div>
                <canvas ref={canvasRef} className="min-w-0 flex-1"/>
                <div className="flex w-8 shrink-0 flex-col items-center justify-center gap-1 border-l border-border-subtle">
                    <button type="button" onClick={onToggle} className="text-text-secondary hover:text-text-primary" aria-label="Hide row" title="Hide row">
                        <View size={14}/>
                    </button>
                    <button
                        type="button"
                        onClick={onRemove}
                        className="text-text-secondary hover:text-state-danger"
                        aria-label="Remove row"
                        title="Remove row"
                    >
                        <TrashCan size={14}/>
                    </button>
                </div>
            </div>
            <Splitter orientation="horizontal" onResize={onResize}/>
        </div>
    );
}
