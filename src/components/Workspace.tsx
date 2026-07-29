import {CSSProperties, PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef} from "react";
import MapView from "./MapView";
import Dock from "./Dock";
import FloatingPanel from "./FloatingPanel";
import Splitter from "./Splitter";
import {DockArea, panelById} from "../workspace/panels";
import {FLOATING_SIZE, FloatingWindow} from "../workspace/layout";
import {useWorkspace} from "../workspace/useWorkspace";
import {Box, usePanelDrag} from "../workspace/usePanelDrag";
import {VehicleKind, VehiclePosition} from "../vehicle/vehicle";

/** Pointer travel before a press on a tab becomes a drag rather than a click. */
const DRAG_THRESHOLD = 4;

/** Where a torn-off window sits under the pointer when the drag begins. */
const GRAB_OFFSET = {x: 56, y: 14};

interface Armed {
    panelId: string;
    startX: number;
    startY: number;
    offsetX: number;
    offsetY: number;
    width: number;
    height: number;
}

interface WorkspaceProps {
    workspace: ReturnType<typeof useWorkspace>;
    vehiclePosition: VehiclePosition | null;
    vehicleKind: VehicleKind | null;
}

export default function Workspace({workspace, vehiclePosition, vehicleKind}: WorkspaceProps) {
    const {state, actions, visible} = workspace;
    const shellRef = useRef<HTMLDivElement>(null);
    const armedRef = useRef<Armed | null>(null);

    const onDrop = useCallback(
        (panelId: string, target: DockArea | null, box: Box) => {
            if (target) {
                actions.dock(panelId, target);
            } else {
                actions.float(panelId, box);
            }
        },
        [actions],
    );

    const {drag, startDrag} = usePanelDrag(shellRef, {sizes: state.sizes, visible, onDrop});

    // A press only becomes a drag once the pointer has actually travelled, so
    // that tapping a tab still just selects it.
    useEffect(() => {
        const move = (event: PointerEvent) => {
            const armed = armedRef.current;
            if (!armed) {
                return;
            }
            if (Math.hypot(event.clientX - armed.startX, event.clientY - armed.startY) < DRAG_THRESHOLD) {
                return;
            }
            armedRef.current = null;

            const shell = shellRef.current?.getBoundingClientRect();
            // Float it up front: leaving the dock the instant the drag starts
            // is the whole point of the gesture, and it means a drop only ever
            // has to move an already-floating panel.
            actions.float(armed.panelId, {
                x: shell ? event.clientX - shell.left - armed.offsetX : 0,
                y: shell ? event.clientY - shell.top - armed.offsetY : 0,
                width: armed.width,
                height: armed.height,
            });
            startDrag({
                panelId: armed.panelId,
                clientX: event.clientX,
                clientY: event.clientY,
                offsetX: armed.offsetX,
                offsetY: armed.offsetY,
                width: armed.width,
                height: armed.height,
            });
        };

        const cancel = () => {
            armedRef.current = null;
        };

        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", cancel);
        window.addEventListener("pointercancel", cancel);

        return () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", cancel);
            window.removeEventListener("pointercancel", cancel);
        };
    }, [actions, startDrag]);

    const armTab = (area: DockArea, panelId: string, event: ReactPointerEvent) => {
        actions.activate(area, panelId);
        if (!panelById(panelId)?.floatable) {
            return;
        }

        armedRef.current = {
            panelId,
            startX: event.clientX,
            startY: event.clientY,
            offsetX: GRAB_OFFSET.x,
            offsetY: GRAB_OFFSET.y,
            width: FLOATING_SIZE.width,
            height: FLOATING_SIZE.height,
        };
    };

    const armFloating = (win: FloatingWindow, event: ReactPointerEvent) => {
        const bounds = event.currentTarget.parentElement?.getBoundingClientRect();

        armedRef.current = {
            panelId: win.panelId,
            startX: event.clientX,
            startY: event.clientY,
            offsetX: bounds ? event.clientX - bounds.left : GRAB_OFFSET.x,
            offsetY: bounds ? event.clientY - bounds.top : GRAB_OFFSET.y,
            width: win.width,
            height: win.height,
        };
    };

    const indicatorStyle = (area: DockArea): CSSProperties => {
        switch (area) {
            case "left":
                return {left: 0, top: 0, bottom: 0, width: state.sizes.left};
            case "right":
                return {right: 0, top: 0, bottom: 0, width: state.sizes.right};
            case "bottom":
                return {
                    left: visible.left ? state.sizes.left : 0,
                    right: visible.right ? state.sizes.right : 0,
                    bottom: 0,
                    height: state.sizes.bottom,
                };
        }
    };

    const dockProps = (area: DockArea) => ({
        area,
        panelIds: state.docks[area],
        activeId: state.active[area],
        onTabPointerDown: (panelId: string, event: ReactPointerEvent) => armTab(area, panelId, event),
        onClose: actions.close,
    });

    return (
        <div ref={shellRef} className="relative flex h-full w-full overflow-hidden bg-background">
            {visible.left && (
                <>
                    <div style={{width: state.sizes.left}} className="shrink-0">
                        <Dock {...dockProps("left")}/>
                    </div>
                    <Splitter
                        orientation="vertical"
                        onResize={(delta) => actions.resizeDock("left", state.sizes.left + delta)}
                    />
                </>
            )}

            <div className="flex min-w-0 flex-1 flex-col">
                <div className="relative min-h-0 flex-1">
                    <MapView position={vehiclePosition} vehicleKind={vehicleKind}/>
                </div>

                {visible.bottom && (
                    <>
                        <Splitter
                            orientation="horizontal"
                            onResize={(delta) => actions.resizeDock("bottom", state.sizes.bottom - delta)}
                        />
                        <div style={{height: state.sizes.bottom}} className="shrink-0">
                            <Dock {...dockProps("bottom")}/>
                        </div>
                    </>
                )}
            </div>

            {visible.right && (
                <>
                    <Splitter
                        orientation="vertical"
                        onResize={(delta) => actions.resizeDock("right", state.sizes.right - delta)}
                    />
                    <div style={{width: state.sizes.right}} className="shrink-0">
                        <Dock {...dockProps("right")}/>
                    </div>
                </>
            )}

            <div className="pointer-events-none absolute inset-0">
                {state.floating
                    .filter((win) => win.panelId !== drag?.panelId)
                    .map((win) => (
                        <FloatingPanel
                            key={win.panelId}
                            win={win}
                            onTitlePointerDown={(event) => armFloating(win, event)}
                            onClose={() => actions.close(win.panelId)}
                            onResize={(box) => actions.float(win.panelId, box)}
                        />
                    ))}

                {drag && (
                    <>
                        {drag.target && (
                            <div
                                style={indicatorStyle(drag.target)}
                                className="absolute border-2 border-state-info bg-state-info/20"
                            />
                        )}
                        <div
                            style={{left: drag.x, top: drag.y, width: drag.width, height: drag.height}}
                            className="absolute flex flex-col overflow-hidden border border-state-info bg-layer-01 shadow-window"
                        >
                            <div className="flex h-control-sm items-center border-b border-border-strong px-3 text-label text-text-primary">
                                {drag.title}
                            </div>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
