import {PointerEvent as ReactPointerEvent, useRef} from "react";
import {FloatingWindow} from "../workspace/layout";
import {panelById} from "../workspace/panels";
import {PanelBody} from "./panelComponents";

const MIN_WIDTH = 220;
const MIN_HEIGHT = 140;

type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const HANDLES: {edge: Edge; className: string}[] = [
    {edge: "n", className: "top-0 right-2 left-2 h-1.5 cursor-ns-resize"},
    {edge: "s", className: "right-2 bottom-0 left-2 h-1.5 cursor-ns-resize"},
    {edge: "w", className: "top-2 bottom-2 left-0 w-1.5 cursor-ew-resize"},
    {edge: "e", className: "top-2 right-0 bottom-2 w-1.5 cursor-ew-resize"},
    {edge: "nw", className: "top-0 left-0 size-2.5 cursor-nwse-resize"},
    {edge: "ne", className: "top-0 right-0 size-2.5 cursor-nesw-resize"},
    {edge: "sw", className: "bottom-0 left-0 size-2.5 cursor-nesw-resize"},
    {edge: "se", className: "right-0 bottom-0 size-2.5 cursor-nwse-resize"},
];

interface FloatingPanelProps {
    win: FloatingWindow;
    onTitlePointerDown: (event: ReactPointerEvent) => void;
    onClose: () => void;
    onResize: (box: Omit<FloatingWindow, "panelId">) => void;
}

export default function FloatingPanel({win, onTitlePointerDown, onClose, onResize}: FloatingPanelProps) {
    const panel = panelById(win.panelId);
    const startRef = useRef<{edge: Edge; x: number; y: number; box: FloatingWindow} | null>(null);

    if (!panel) {
        return null;
    }

    const resizeTo = (event: ReactPointerEvent) => {
        const start = startRef.current;
        if (!start) {
            return;
        }

        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        const {box, edge} = start;
        let {x, y, width, height} = box;

        if (edge.includes("e")) {
            width = Math.max(MIN_WIDTH, box.width + dx);
        }
        if (edge.includes("w")) {
            // Clamping width has to hold the right edge still, so derive x from
            // the clamped width rather than from the raw pointer delta.
            width = Math.max(MIN_WIDTH, box.width - dx);
            x = box.x + (box.width - width);
        }
        if (edge.includes("s")) {
            height = Math.max(MIN_HEIGHT, box.height + dy);
        }
        if (edge.includes("n")) {
            height = Math.max(MIN_HEIGHT, box.height - dy);
            y = box.y + (box.height - height);
        }

        onResize({x, y, width, height});
    };

    return (
        <div
            data-floating={win.panelId}
            style={{left: win.x, top: win.y, width: win.width, height: win.height}}
            className="pointer-events-auto absolute flex flex-col overflow-hidden border border-border-strong bg-background shadow-window"
        >
            <div
                onPointerDown={onTitlePointerDown}
                className="flex shrink-0 cursor-grab items-center justify-between h-control-sm gap-2 border-b border-border-subtle bg-layer-01 px-3 select-none active:cursor-grabbing"
            >
                <span className="truncate text-label text-text-secondary">{panel.title}</span>
                <button
                    type="button"
                    aria-label={`Close ${panel.title}`}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={onClose}
                    className="px-1 text-text-helper hover:bg-layer-hover-02 hover:text-text-primary"
                >
                    ×
                </button>
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
                <PanelBody panel={panel}/>
            </div>

            {HANDLES.map(({edge, className}) => (
                <div
                    key={edge}
                    className={`absolute ${className}`}
                    onPointerDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        event.currentTarget.setPointerCapture(event.pointerId);
                        startRef.current = {edge, x: event.clientX, y: event.clientY, box: win};
                    }}
                    onPointerMove={resizeTo}
                    onPointerUp={(event) => {
                        event.currentTarget.releasePointerCapture(event.pointerId);
                        startRef.current = null;
                    }}
                    onPointerCancel={() => {
                        startRef.current = null;
                    }}
                />
            ))}
        </div>
    );
}
