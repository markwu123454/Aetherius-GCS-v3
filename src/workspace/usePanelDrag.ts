import {RefObject, useCallback, useEffect, useRef, useState} from "react";
import {DockArea, canDock, panelById} from "./panels";

/**
 * How close to an edge the pointer must get to target a dock that is currently
 * empty and therefore taking up no space. A visible dock uses its own width
 * instead, so anywhere over it counts.
 */
const EDGE_BAND = 56;

export interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface DragState extends Box {
    panelId: string;
    title: string;
    /** The dock the panel would land in if released now. */
    target: DockArea | null;
}

export interface DragStart {
    panelId: string;
    clientX: number;
    clientY: number;
    /** Where inside the window the pointer grabbed it. */
    offsetX: number;
    offsetY: number;
    width: number;
    height: number;
}

interface DragContext {
    sizes: Record<DockArea, number>;
    visible: Record<DockArea, boolean>;
    onDrop: (panelId: string, target: DockArea | null, box: Box) => void;
}

function hitTest(
    shell: DOMRect,
    {sizes, visible}: DragContext,
    panelId: string,
    clientX: number,
    clientY: number,
): DockArea | null {
    const panel = panelById(panelId);
    if (!panel) {
        return null;
    }
    if (clientX < shell.left || clientX > shell.right || clientY < shell.top || clientY > shell.bottom) {
        return null;
    }

    const band = (area: DockArea) => (visible[area] ? Math.max(sizes[area], EDGE_BAND) : EDGE_BAND);

    // Left and right run the full height and so are tested before bottom,
    // matching how the shell actually stacks them.
    if (canDock(panel, "left") && clientX <= shell.left + band("left")) {
        return "left";
    }
    if (canDock(panel, "right") && clientX >= shell.right - band("right")) {
        return "right";
    }
    if (canDock(panel, "bottom") && clientY >= shell.bottom - band("bottom")) {
        return "bottom";
    }
    return null;
}

/**
 * The single drag gesture behind both moving a floating window and docking a
 * panel. A drag always carries a floating window under the pointer; releasing
 * it over a dock band hands the panel to that dock, and releasing it anywhere
 * else just leaves the window where it was dropped.
 */
export function usePanelDrag(shellRef: RefObject<HTMLElement | null>, context: DragContext) {
    const [drag, setDrag] = useState<DragState | null>(null);

    // The gesture is driven from refs so it never depends on a render having
    // happened. Binding the listeners in an effect would leave a window where
    // a pointerup arrives before they exist and the drag never completes.
    const dragRef = useRef<DragState | null>(null);
    const offsetRef = useRef({x: 0, y: 0});
    const contextRef = useRef(context);
    const stopRef = useRef<(() => void) | null>(null);

    contextRef.current = context;

    const startDrag = useCallback(
        (options: DragStart) => {
            const shell = shellRef.current?.getBoundingClientRect();
            if (!shell) {
                return;
            }

            stopRef.current?.();
            offsetRef.current = {x: options.offsetX, y: options.offsetY};

            const initial: DragState = {
                panelId: options.panelId,
                title: panelById(options.panelId)?.title ?? options.panelId,
                x: options.clientX - shell.left - options.offsetX,
                y: options.clientY - shell.top - options.offsetY,
                width: options.width,
                height: options.height,
                target: null,
            };
            dragRef.current = initial;
            setDrag(initial);

            const move = (event: PointerEvent) => {
                const bounds = shellRef.current?.getBoundingClientRect();
                const current = dragRef.current;
                if (!bounds || !current) {
                    return;
                }

                const next: DragState = {
                    ...current,
                    x: event.clientX - bounds.left - offsetRef.current.x,
                    y: event.clientY - bounds.top - offsetRef.current.y,
                    target: hitTest(bounds, contextRef.current, current.panelId, event.clientX, event.clientY),
                };
                dragRef.current = next;
                setDrag(next);
            };

            const stop = () => {
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", finish);
                window.removeEventListener("pointercancel", finish);
                stopRef.current = null;
            };

            function finish() {
                stop();

                const current = dragRef.current;
                dragRef.current = null;
                setDrag(null);
                if (!current) {
                    return;
                }

                const bounds = shellRef.current?.getBoundingClientRect();
                const box: Box = {
                    // Keep a dropped window reachable rather than half off-screen.
                    x: bounds
                        ? Math.min(Math.max(current.x, 0), Math.max(0, bounds.width - current.width))
                        : current.x,
                    y: bounds
                        ? Math.min(Math.max(current.y, 0), Math.max(0, bounds.height - current.height))
                        : current.y,
                    width: current.width,
                    height: current.height,
                };

                contextRef.current.onDrop(current.panelId, current.target, box);
            }

            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", finish);
            window.addEventListener("pointercancel", finish);
            stopRef.current = stop;
        },
        [shellRef],
    );

    useEffect(() => () => stopRef.current?.(), []);

    return {drag, startDrag};
}
