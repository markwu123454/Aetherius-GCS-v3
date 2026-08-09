import {PointerEvent as ReactPointerEvent, useRef} from "react";
import {ROW_BUTTON_COL_WIDTH_PX, ROW_LABEL_WIDTH_PX} from "./draw.ts";

const BAR_HEIGHT = 36;

function formatUs(us: number): string {
    const totalSeconds = us / 1_000_000;
    const m = Math.floor(totalSeconds / 60);
    const s = Math.floor(totalSeconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
}

interface OverviewBarProps {
    fullStartUs: number;
    fullEndUs: number;
    visibleStartUs: number;
    visibleEndUs: number;
    playheadUs: number;
    /** Fired on click, and continuously while dragging — the parent both
     * seeks the playhead there and recenters the visible window on it, so
     * this stays a single "go here" gesture rather than two separate
     * controls. */
    onNavigate: (timeUs: number) => void;
}

/**
 * The whole-flight minimap at the bottom of the page — "the timeline for
 * choosing scales." Shows the visible row-stack window as a highlighted
 * region against the full log duration, plus the playhead. Click or drag
 * anywhere on the bar to jump/scrub there; the row stack's own
 * scroll-to-zoom/drag-to-pan (see `LogAnalysisPage`) is the faster path
 * for fine adjustment, this is for "I know roughly where in the flight I
 * want to be."
 *
 * The bar column is inset by `ROW_LABEL_WIDTH_PX`/`ROW_BUTTON_COL_WIDTH_PX`
 * on either side — the same margins `TimelineRow`/`ConsoleRow` reserve for
 * their label/button columns — so its horizontal extent lines up exactly
 * with every row's canvas above it, rather than spanning the full page
 * width while the rows it's supposed to control start further right.
 */
export default function OverviewBar({fullStartUs, fullEndUs, visibleStartUs, visibleEndUs, playheadUs, onNavigate}: OverviewBarProps) {
    const barRef = useRef<HTMLDivElement>(null);
    const draggingRef = useRef(false);
    const span = Math.max(1, fullEndUs - fullStartUs);
    const toPercent = (t: number) => ((t - fullStartUs) / span) * 100;

    function timeAt(clientX: number, rect: DOMRect): number {
        const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
        return fullStartUs + fraction * span;
    }

    function handlePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
        draggingRef.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        onNavigate(timeAt(e.clientX, e.currentTarget.getBoundingClientRect()));
    }

    function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
        if (!draggingRef.current) return;
        onNavigate(timeAt(e.clientX, e.currentTarget.getBoundingClientRect()));
    }

    function handlePointerUp() {
        draggingRef.current = false;
    }

    return (
        <div className="flex shrink-0 border-t border-border-subtle bg-layer-01" style={{height: BAR_HEIGHT}}>
            <div style={{width: ROW_LABEL_WIDTH_PX}} className="shrink-0 border-r border-border-subtle"/>
            <div className="flex min-w-0 flex-1 flex-col justify-center gap-1 px-2">
                <div className="flex justify-between text-micro text-text-helper">
                    <span>{formatUs(fullStartUs)}</span>
                    <span>{formatUs(fullEndUs)}</span>
                </div>
                <div
                    ref={barRef}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    className="relative h-3 cursor-pointer touch-none bg-layer-02"
                >
                    <div
                        className="absolute inset-y-0 bg-layer-hover-02"
                        style={{
                            left: `${toPercent(visibleStartUs)}%`,
                            width: `${Math.max(0.5, toPercent(visibleEndUs) - toPercent(visibleStartUs))}%`,
                        }}
                    />
                    <div className="absolute inset-y-0 w-px bg-state-info" style={{left: `${toPercent(playheadUs)}%`}}/>
                </div>
            </div>
            <div style={{width: ROW_BUTTON_COL_WIDTH_PX}} className="shrink-0 border-l border-border-subtle"/>
        </div>
    );
}
