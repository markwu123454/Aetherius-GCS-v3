import {PointerEvent as ReactPointerEvent, useRef, useState, WheelEvent as ReactWheelEvent} from "react";
import {closestCenter, DndContext, DragEndEvent, PointerSensor, useSensor, useSensors} from "@dnd-kit/core";
import {SortableContext, verticalListSortingStrategy} from "@dnd-kit/sortable";
import {Add} from "@carbon/icons-react";
import {useLogAnalysis} from "@/lib/logs/useLogAnalysis.ts";
import TimelineRow from "./analysis/TimelineRow.tsx";
import ConsoleRow from "./analysis/ConsoleRow.tsx";
import OverviewBar from "./analysis/OverviewBar.tsx";
import AddRowDrawer from "./analysis/AddRowDrawer.tsx";
import {ROW_BUTTON_COL_WIDTH_PX, ROW_LABEL_WIDTH_PX} from "./analysis/draw.ts";

interface LogAnalysisPageProps {
    /** Local path of the log to analyze — set by the Logs page's Analyze
     * button (see `App.tsx`, which owns this as a sibling of the page the
     * same way it owns the Mission draft). `null` shouldn't come up in
     * practice, since Analyze only opens this page with a path already in
     * hand, but is handled rather than assumed away. */
    path: string | null;
}

/** How much one wheel "click" zooms by. Repeated scrolling compounds this,
 * same as any zoom-on-scroll surface (a map, DevTools' Performance tab). */
const ZOOM_STEP = 1.15;
/** Below this many pixels of pointer movement, a press-release is treated
 * as a click-to-seek rather than a pan — distinguishes "I clicked a point
 * in time" from "I dragged and happened to end up somewhere." */
const DRAG_THRESHOLD_PX = 3;

/**
 * The multi-row synced timeline: Arm state and Mode pinned at the top,
 * whatever rows have been added below, the console (`MSG`) track pinned at
 * the bottom, and a whole-flight overview bar for coarse navigation. Every
 * row shares one time axis, controlled by wheel + modifiers — matching
 * Chrome DevTools' Performance panel rather than inventing a scheme:
 * plain wheel scrolls the row list vertically, Ctrl/Cmd+wheel zooms the
 * time axis (this is also how browsers report trackpad pinch-to-zoom, so
 * pinch works for free), Shift+wheel (or a trackpad's own horizontal
 * swipe) pans it, and Alt+wheel scales every row's height at once,
 * proportionally — the DAW/video-editor "vertical zoom" convention. A
 * click on a row seeks the playhead; a drag pans instead. Driven by
 * `useLogAnalysis`, which talks to `logs/analysis.rs`'s
 * `open_log`/`get_log_series`/`get_log_text_events`.
 *
 * Deliberately out of scope for this pass: the cockpit strip (attitude
 * indicator / map / RC sticks reused from the Manual panel's widgets),
 * derived stick-axis rows (raw `RCIN` channels are addable, the
 * param-aware resolved axis isn't yet), and the auto-diagnosis pass.
 */
export default function LogAnalysisPage({path}: LogAnalysisPageProps) {
    const analysis = useLogAnalysis(path);
    const [drawerOpen, setDrawerOpen] = useState(false);
    const dragRef = useRef<{lastX: number; moved: boolean} | null>(null);
    // A small activation distance so grabbing a row's drag handle to
    // reorder it doesn't fire on every plain click — has to actually move
    // a few pixels first, same threshold philosophy as `DRAG_THRESHOLD_PX`
    // below for the pan-vs-seek gesture.
    const sensors = useSensors(useSensor(PointerSensor, {activationConstraint: {distance: 4}}));

    if (!path) {
        return (
            <div className="flex h-full w-full items-center justify-center text-label text-text-helper">
                No log selected — open one from the Logs page.
            </div>
        );
    }

    if (analysis.opening) {
        return <div className="flex h-full w-full items-center justify-center text-label text-text-helper">Parsing log…</div>;
    }

    if (analysis.openError) {
        return <div className="flex h-full w-full items-center justify-center text-label text-state-danger">{analysis.openError}</div>;
    }

    if (!analysis.summary || !analysis.visibleRange) {
        return null;
    }

    const {summary, visibleRange, rows, seriesByType, playheadUs} = analysis;
    const span = visibleRange.endUs - visibleRange.startUs;

    /** Fraction (0–1) across just the canvas region of a row — excludes
     * the fixed label column and button column on either side, which
     * `ROW_LABEL_WIDTH_PX`/`ROW_BUTTON_COL_WIDTH_PX` describe (see
     * `draw.ts` for why those live there rather than being guessed twice). */
    function canvasFraction(clientX: number, rect: DOMRect): number {
        const usable = Math.max(1, rect.width - ROW_LABEL_WIDTH_PX - ROW_BUTTON_COL_WIDTH_PX);
        return Math.min(1, Math.max(0, (clientX - rect.left - ROW_LABEL_WIDTH_PX) / usable));
    }

    function handleWheel(e: ReactWheelEvent<HTMLDivElement>) {
        if (!analysis.visibleRange) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const usable = Math.max(1, rect.width - ROW_LABEL_WIDTH_PX - ROW_BUTTON_COL_WIDTH_PX);

        // Alt+wheel scales every row's height at once, proportionally —
        // the DAW/video-editor "vertical zoom all tracks" gesture.
        if (e.altKey) {
            e.preventDefault();
            analysis.resizeAllRows(e.deltaY > 0 ? 1 / ZOOM_STEP : ZOOM_STEP);
            return;
        }

        // Ctrl/Cmd+wheel zooms — also how browsers report trackpad
        // pinch-to-zoom (as a wheel event with ctrlKey set), so pinch
        // zooms this for free without any extra handling.
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            const fraction = canvasFraction(e.clientX, rect);
            const centerUs = analysis.visibleRange.startUs + fraction * (analysis.visibleRange.endUs - analysis.visibleRange.startUs);
            analysis.zoom(e.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP, centerUs);
            return;
        }

        // Shift+wheel, or a trackpad's own horizontal swipe (deltaX
        // dominant with no modifier held), pans along the time axis.
        // Some platforms convert Shift+vertical into deltaX before this
        // handler even runs; falling back to deltaY covers the ones that
        // don't.
        if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
            e.preventDefault();
            const delta = e.deltaX !== 0 ? e.deltaX : e.deltaY;
            const currentSpan = analysis.visibleRange.endUs - analysis.visibleRange.startUs;
            analysis.pan((delta / usable) * currentSpan);
            return;
        }

        // Plain vertical wheel: leave it alone entirely so the browser
        // scrolls the row list normally, same as any other scrollable list.
    }

    function handlePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
        // A row's own eye/trash/drag-handle buttons and its resize
        // `Splitter` (role="separator") all live inside this same
        // container — capturing the pointer here unconditionally would
        // steal it away from theirs (setPointerCapture transfers, it
        // doesn't share), which is exactly what left the splitter stuck
        // "dragging" forever and only trackable while the cursor stayed
        // over its own 1px strip. Let those own their gesture instead of
        // starting a pan here too.
        if ((e.target as HTMLElement).closest('button, [role="separator"]')) {
            return;
        }
        dragRef.current = {lastX: e.clientX, moved: false};
        e.currentTarget.setPointerCapture(e.pointerId);
    }

    function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
        const drag = dragRef.current;
        if (!drag || !analysis.visibleRange) return;
        const dx = e.clientX - drag.lastX;
        if (dx === 0) return;
        if (Math.abs(dx) > DRAG_THRESHOLD_PX) drag.moved = true;
        const rect = e.currentTarget.getBoundingClientRect();
        const usable = Math.max(1, rect.width - ROW_LABEL_WIDTH_PX - ROW_BUTTON_COL_WIDTH_PX);
        const currentSpan = analysis.visibleRange.endUs - analysis.visibleRange.startUs;
        analysis.pan((-dx / usable) * currentSpan);
        drag.lastX = e.clientX;
    }

    function handlePointerUp(e: ReactPointerEvent<HTMLDivElement>) {
        const drag = dragRef.current;
        dragRef.current = null;
        if (!drag || drag.moved || !analysis.visibleRange) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const fraction = canvasFraction(e.clientX, rect);
        analysis.setPlayheadUs(analysis.visibleRange.startUs + fraction * (analysis.visibleRange.endUs - analysis.visibleRange.startUs));
    }

    const addedIds = new Set(rows.map((r) => r.id));

    function handleDragEnd(event: DragEndEvent) {
        const overId = event.over?.id;
        if (overId && overId !== event.active.id) {
            analysis.reorderRows(String(event.active.id), String(overId));
        }
    }

    return (
        <div className="relative flex h-full w-full flex-col">
            <div className="flex items-center justify-between border-b border-border-subtle px-6 py-3">
                <div className="min-w-0">
                    <h2 className="text-heading text-text-primary">Log Analysis</h2>
                    <p className="truncate text-body text-text-secondary" title={path}>
                        {path}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => setDrawerOpen(true)}
                    className="flex h-control-sm w-fit shrink-0 items-center gap-1 border border-border-subtle px-3 text-label text-text-primary hover:bg-layer-hover-01"
                >
                    <Add size={16}/>
                    Add row
                </button>
            </div>

            <div
                className="min-h-0 flex-1 touch-none overflow-x-hidden overflow-y-auto select-none"
                onWheel={handleWheel}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerLeave={handlePointerUp}
            >
                {rows.length === 0 ? (
                    <div className="p-6 text-center text-label text-text-helper">No rows yet — click "Add row" to chart a field.</div>
                ) : (
                    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                        <SortableContext items={rows.map((r) => r.id)} strategy={verticalListSortingStrategy}>
                            {rows.map((row, index) => (
                                <TimelineRow
                                    key={row.id}
                                    row={row}
                                    series={seriesByType.get(row.messageType)}
                                    colorIndex={index}
                                    startUs={visibleRange.startUs}
                                    endUs={visibleRange.endUs}
                                    playheadUs={playheadUs}
                                    onToggle={() => analysis.toggleRow(row.id)}
                                    onRemove={() => analysis.removeRow(row.id)}
                                    onResize={(delta) => analysis.resizeRow(row.id, delta)}
                                />
                            ))}
                        </SortableContext>
                    </DndContext>
                )}
            </div>

            <ConsoleRow
                events={analysis.consoleEvents}
                startUs={visibleRange.startUs}
                endUs={visibleRange.endUs}
                playheadUs={playheadUs}
                onSeek={analysis.setPlayheadUs}
            />

            <OverviewBar
                fullStartUs={summary.startUs}
                fullEndUs={summary.endUs}
                visibleStartUs={visibleRange.startUs}
                visibleEndUs={visibleRange.endUs}
                playheadUs={playheadUs}
                onNavigate={(t) => {
                    analysis.setPlayheadUs(t);
                    analysis.pan(t - (visibleRange.startUs + span / 2));
                }}
            />

            {drawerOpen && (
                <AddRowDrawer
                    messageTypes={summary.messageTypes}
                    addedIds={addedIds}
                    onAdd={(messageType, field) => analysis.addRow(messageType, field)}
                    onClose={() => setDrawerOpen(false)}
                />
            )}
        </div>
    );
}
