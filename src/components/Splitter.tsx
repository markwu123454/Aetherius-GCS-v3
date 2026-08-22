import {PointerEvent as ReactPointerEvent, useRef, useState} from "react";

interface SplitterProps {
    /** `vertical` splits left from right and so is dragged horizontally. */
    orientation: "vertical" | "horizontal";
    /** Pointer movement since the last event, along the splitter's axis. */
    onResize: (delta: number) => void;
}

export default function Splitter({orientation, onResize}: SplitterProps) {
    const lastRef = useRef(0);
    const [dragging, setDragging] = useState(false);
    const vertical = orientation === "vertical";

    const positionOf = (event: ReactPointerEvent) => (vertical ? event.clientX : event.clientY);

    return (
        <div
            role="separator"
            aria-orientation={vertical ? "vertical" : "horizontal"}
            // The hit area is a full 8px strip — noticeably easier to grab
            // than the 1px line down its center is to look at — so at rest
            // this reads as a normal border rather than a thick solid bar,
            // while still being comfortable to land a drag on.
            className={[
                "group flex shrink-0 items-center justify-center",
                vertical ? "w-2 cursor-col-resize" : "h-2 cursor-row-resize",
            ].join(" ")}
            onPointerDown={(event) => {
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                lastRef.current = positionOf(event);
                setDragging(true);
            }}
            onPointerMove={(event) => {
                if (!dragging) {
                    return;
                }
                const position = positionOf(event);
                onResize(position - lastRef.current);
                lastRef.current = position;
            }}
            onPointerUp={(event) => {
                event.currentTarget.releasePointerCapture(event.pointerId);
                setDragging(false);
            }}
            onPointerCancel={() => setDragging(false)}
        >
            <div
                className={[
                    "transition-colors",
                    vertical ? "h-full w-px" : "h-px w-full",
                    dragging ? "bg-state-info" : "bg-border-subtle group-hover:bg-state-info",
                ].join(" ")}
            />
        </div>
    );
}
