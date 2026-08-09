import {MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState} from "react";
import {ChevronDown, ChevronUp} from "@carbon/icons-react";
import {TextEvent} from "@/lib/logs/analysis.ts";
import {cssVar, drawPlayhead, prepareCanvas, toX} from "./draw.ts";

const ROW_HEIGHT = 40;
const LIST_HEIGHT = 220;
/** Left padding between a message's tick and where its text starts. */
const TEXT_PAD_PX = 4;

function formatRelative(timeUs: number): string {
    const totalSeconds = timeUs / 1_000_000;
    const m = Math.floor(totalSeconds / 60);
    const s = (totalSeconds % 60).toFixed(2).padStart(5, "0");
    return `${m}:${s}`;
}

/** One message's slice of the row: its tick (if actually within the
 * visible window) and the horizontal span its text is allowed to draw
 * into, running from its own position up to wherever the *next* message
 * starts — so a message gets cut off by whichever one follows it, exactly
 * as far apart as they actually are at the current zoom level, not a
 * fixed character count. Consecutive segments always abut with no gap,
 * so every x position in the row belongs to exactly one message (or
 * none, before the first message the log ever has). */
interface Segment {
    event: TextEvent;
    /** Where this message's own tick actually is — may be negative (off
     * the left edge) for the one message whose tick precedes the visible
     * window but whose text still has room to show, sticky-pinned at the
     * row's left edge; see `buildSegments`. */
    tickX: number;
    tickVisible: boolean;
    textX0: number;
    textX1: number;
    /** Full natural width of this message's text via `measureText` — how
     * much room it needs to show completely, independent of how much
     * `[textX0, textX1)` actually gives it. Filled in by the draw effect,
     * which is the one place with a canvas context (and `ctx.font`
     * already set) to measure with; `0` is a harmless placeholder before
     * that runs once. */
    textWidth: number;
}

/** How much of a segment's text actually renders, and where that run of
 * pixels ends — clamped to whichever is smaller, the text's own natural
 * width or the room `[textX0, textX1)` leaves after the left padding. */
function renderedTextEnd(seg: Segment): number {
    const room = Math.max(0, seg.textX1 - seg.textX0 - TEXT_PAD_PX);
    return seg.textX0 + TEXT_PAD_PX + Math.min(seg.textWidth, room);
}

/** True if the segment's full text didn't fit — any amount of clipping,
 * not just total invisibility. That's "covered": something real is
 * missing, whether it's the last three words or all of it. */
function isCovered(seg: Segment): boolean {
    return seg.textX1 - seg.textX0 - TEXT_PAD_PX < seg.textWidth;
}

/** Builds one segment per message that could have text visible in
 * `[startUs, endUs]` — every message inside that window, plus (if there
 * is one) the single message immediately before it. That last one is why
 * "the most recent past message" shows pinned at the left edge: its own
 * tick is off-screen, but its text segment still starts at `x = 0` and
 * runs until whatever comes next, the same rule every other segment
 * follows — not a special case, just this one segment's tick happening to
 * land left of the window. */
function buildSegments(sorted: TextEvent[], startUs: number, endUs: number, scale: {startUs: number; endUs: number; width: number}): Segment[] {
    let priorIdx = -1;
    let lo = 0;
    let hi = sorted.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid].timeUs < startUs) {
            priorIdx = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }

    const seq: TextEvent[] = [];
    if (priorIdx >= 0) seq.push(sorted[priorIdx]);
    for (let i = priorIdx + 1; i < sorted.length && sorted[i].timeUs <= endUs; i++) {
        seq.push(sorted[i]);
    }

    return seq.map((event, i) => {
        const next = seq[i + 1];
        const tickX = toX(scale, event.timeUs);
        return {
            event,
            tickX,
            tickVisible: event.timeUs >= startUs && event.timeUs <= endUs,
            textX0: Math.max(0, tickX),
            textX1: next ? toX(scale, next.timeUs) : scale.width,
            textWidth: 0, // filled in by the draw effect, which has a context to measure with
        };
    });
}

/** The segment whose *visible footprint* — its tick plus however much of
 * its text actually rendered — contains `x`. Deliberately narrower than
 * "anywhere inside `[textX0, textX1)`": a segment's owned region can run
 * on well past where its text (or a too-short one's tick) actually ends,
 * and hovering that dead space between messages shouldn't surface a
 * tooltip for whichever segment technically owns the pixel. */
function segmentIndexAt(segments: Segment[], x: number): number {
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const end = Math.max(seg.textX0, renderedTextEnd(seg));
        if (x >= seg.textX0 - 1 && x <= end + 1) return i;
    }
    return -1;
}

/** The message at `x`, plus every message immediately before it whose text
 * got clipped in any way — walked back with no limit, since a burst can
 * be arbitrarily long (ArduPilot's own boot banner alone is a dozen-plus
 * messages within ~10ms of each other) and every one of them is still
 * real content worth surfacing, not just the ones that happened to have
 * enough space to be fully legible. Stops at the first preceding message
 * that *did* get its complete text rendered — that one's already fully
 * readable on its own, not something hidden behind the hovered one. */
function coveredChainAt(segments: Segment[], x: number): Segment[] {
    const idx = segmentIndexAt(segments, x);
    if (idx === -1) {
        return [];
    }
    const chain = [segments[idx]];
    let i = idx - 1;
    while (i >= 0 && isCovered(segments[i])) {
        chain.unshift(segments[i]);
        i--;
    }
    return chain;
}

interface ConsoleRowProps {
    events: TextEvent[];
    startUs: number;
    endUs: number;
    playheadUs: number;
    onSeek: (timeUs: number) => void;
}

/**
 * The STATUSTEXT/`MSG` track, pinned at the bottom of the row stack like a
 * caption track. Every message gets its own tick and its own inline text,
 * growing or shrinking with zoom just like every other row — a message's
 * text runs from its tick to wherever the next one starts and is clipped
 * there, so closely-spaced messages (ArduPilot's own boot banner is a
 * dozen-plus within ~10ms of each other) naturally show less text the
 * closer together they are, and more once you zoom in far enough to give
 * them room — rather than a fixed-width label that either always fits or
 * never does. The message most recently seen before the visible window
 * starts stays pinned at the left edge on the same rule (see
 * `buildSegments`), so scrubbing forward never loses context of what was
 * last said. Hovering any point still shows that point's message in full,
 * for whenever the clipped text isn't enough on its own.
 */
export default function ConsoleRow({events, startUs, endUs, playheadUs, onSeek}: ConsoleRowProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [expanded, setExpanded] = useState(false);
    const currentRef = useRef<HTMLButtonElement>(null);
    const [hover, setHover] = useState<{chain: Segment[]; cursorX: number; containerWidth: number} | null>(null);
    // Rebuilt every draw, read by the hover/click handlers — hit-testing
    // reuses the exact same segments the text was clipped against.
    const segmentsRef = useRef<Segment[]>([]);

    const sorted = useMemo(() => [...events].sort((a, b) => a.timeUs - b.timeUs), [events]);
    const current = useMemo(() => {
        let best: TextEvent | undefined;
        let bestDist = Infinity;
        for (const event of sorted) {
            const dist = Math.abs(event.timeUs - playheadUs);
            if (dist < bestDist) {
                best = event;
                bestDist = dist;
            }
        }
        return best;
    }, [sorted, playheadUs]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) {
            return;
        }
        const ctx = prepareCanvas(canvas);
        if (!ctx) {
            return;
        }
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        const scale = {startUs, endUs, width};

        const tickColor = cssVar(canvas, "--color-state-info", "#4589ff");
        const textColor = cssVar(canvas, "--color-text-secondary", "#c6c6c6");
        ctx.font = `10px ${cssVar(canvas, "--font-sans", "sans-serif")}`;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";

        // `textWidth` needs `ctx.font` already set to measure correctly,
        // so it's filled in here rather than inside `buildSegments`, which
        // has no canvas context of its own.
        const segments = buildSegments(sorted, startUs, endUs, scale).map((seg) => ({
            ...seg,
            textWidth: ctx.measureText(seg.event.text).width,
        }));
        segmentsRef.current = segments;

        for (const seg of segments) {
            if (seg.tickVisible) {
                ctx.strokeStyle = tickColor;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(seg.tickX + 0.5, 4);
                ctx.lineTo(seg.tickX + 0.5, height - 4);
                ctx.stroke();
            }
            if (seg.textX1 - seg.textX0 > TEXT_PAD_PX) {
                ctx.save();
                ctx.beginPath();
                ctx.rect(seg.textX0, 0, seg.textX1 - seg.textX0, height);
                ctx.clip();
                ctx.fillStyle = textColor;
                ctx.fillText(seg.event.text, seg.textX0 + TEXT_PAD_PX, height / 2);
                ctx.restore();
            }
        }

        drawPlayhead(ctx, scale, height, playheadUs, cssVar(canvas, "--color-border-strong", "#6f6f6f"));
    }, [sorted, startUs, endUs, playheadUs]);

    useEffect(() => {
        if (expanded) {
            currentRef.current?.scrollIntoView({block: "nearest"});
        }
    }, [expanded, current]);

    function handleMouseMove(e: ReactMouseEvent<HTMLCanvasElement>) {
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const chain = coveredChainAt(segmentsRef.current, x);
        setHover(chain.length > 0 ? {chain, cursorX: x, containerWidth: rect.width} : null);
    }

    function handleClick(e: ReactMouseEvent<HTMLCanvasElement>) {
        const rect = e.currentTarget.getBoundingClientRect();
        const fraction = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        onSeek(startUs + fraction * (endUs - startUs));
    }

    return (
        <div className="flex shrink-0 flex-col border-t border-border-subtle bg-layer-01">
            {expanded && (
                <div className="overflow-y-auto border-b border-border-subtle" style={{height: LIST_HEIGHT}}>
                    {sorted.length === 0 ? (
                        <div className="p-3 text-center text-micro text-text-helper">No messages in this log.</div>
                    ) : (
                        sorted.map((event, index) => (
                            <button
                                key={`${event.timeUs}-${index}`}
                                ref={event === current ? currentRef : undefined}
                                type="button"
                                onClick={() => onSeek(event.timeUs)}
                                className={`flex w-full items-start gap-3 px-3 py-1 text-left text-micro hover:bg-layer-hover-01 ${
                                    event === current ? "bg-layer-hover-01" : ""
                                }`}
                            >
                                <span className="w-14 shrink-0 font-mono text-text-helper">{formatRelative(event.timeUs)}</span>
                                <span className="min-w-0 flex-1 break-words text-text-primary">{event.text}</span>
                            </button>
                        ))
                    )}
                </div>
            )}
            <div className="flex" style={{height: ROW_HEIGHT}}>
                <button
                    type="button"
                    onClick={() => setExpanded((prev) => !prev)}
                    className="flex w-40 shrink-0 items-center gap-1 border-r border-border-subtle px-2 text-label text-text-primary hover:bg-layer-hover-01"
                    title={expanded ? "Collapse message list" : "Expand message list"}
                >
                    {expanded ? <ChevronDown size={14}/> : <ChevronUp size={14}/>}
                    Console
                </button>
                <div className="relative min-w-0 flex-1">
                    <canvas
                        ref={canvasRef}
                        className="absolute inset-0 h-full w-full cursor-pointer"
                        onMouseMove={handleMouseMove}
                        onMouseLeave={() => setHover(null)}
                        onClick={handleClick}
                    />
                    {hover && (
                        <div
                            className="pointer-events-none absolute bottom-full z-30 mb-1 w-80 border border-border-subtle bg-layer-02 px-2 py-1 text-micro shadow-lg"
                            style={{left: Math.min(Math.max(hover.cursorX, 0), Math.max(0, hover.containerWidth - 320))}}
                        >
                            {hover.chain.length > 1 && (
                                <div className="mb-1 text-text-helper">{hover.chain.length} messages, oldest first:</div>
                            )}
                            {hover.chain.map((seg, i) => (
                                <div key={i} className="flex gap-2">
                                    <span className="shrink-0 font-mono text-text-helper">{formatRelative(seg.event.timeUs)}</span>
                                    <span className="min-w-0 break-words text-text-primary">{seg.event.text}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
                <div className="w-8 shrink-0 border-l border-border-subtle"/>
            </div>
        </div>
    );
}
