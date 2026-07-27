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
            className={[
                "shrink-0 bg-layer-02 transition-colors",
                vertical ? "w-1 cursor-col-resize hover:bg-state-info" : "h-1 cursor-row-resize hover:bg-state-info",
                dragging ? "bg-state-info" : "",
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
        />
    );
}
