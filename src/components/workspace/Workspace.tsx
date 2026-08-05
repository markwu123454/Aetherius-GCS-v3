import {CSSProperties, PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef} from "react";
import MapView from "./MapView.tsx";
import Dock from "@/panels/Dock.tsx";
import FloatingPanel from "@/panels/FloatingPanel.tsx";
import Splitter from "@/components/Splitter.tsx";
import {DockArea, panelById} from "@/lib/workspace/panels.ts";
import {FLOATING_SIZE, FloatingWindow} from "@/lib/workspace/layout.ts";
import {useWorkspace} from "@/lib/workspace/useWorkspace.ts";
import {Box, usePanelDrag} from "@/lib/workspace/usePanelDrag.ts";
import {VehicleKind, VehiclePosition} from "@/lib/vehicle/vehicle.ts";
import type {AirspaceState} from "@/lib/airspace/useAirspace.ts";

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
    /** Whether this panel can be left floating after a drag. Non-floatable
     * panels are still draggable between docks but snap back to `sourceArea`
     * if released over empty space. */
    floatable: boolean;
    /** The dock this panel came from — used to restore a non-floatable panel
     * that is dropped outside any dock target. */
    sourceArea: DockArea;
}

interface WorkspaceProps {
    workspace: ReturnType<typeof useWorkspace>;
    vehiclePosition: VehiclePosition | null;
    vehicleKind: VehicleKind | null;
    airspace: AirspaceState;
}

export default function Workspace({workspace, vehiclePosition, vehicleKind, airspace}: WorkspaceProps) {
    const {state, actions, visible, flashSignal} = workspace;
    const shellRef = useRef<HTMLDivElement>(null);
    const armedRef = useRef<Armed | null>(null);
    // Kept separately from `armedRef` so `onDrop` can read the source area
    // after `armedRef` has already been cleared when the drag threshold fires.
    const dragSourceRef = useRef<{area: DockArea; floatable: boolean} | null>(null);

    const onDrop = useCallback(
        (panelId: string, target: DockArea | null, box: Box) => {
            const source = dragSourceRef.current;
            dragSourceRef.current = null;
            if (target) {
                actions.dock(panelId, target);
            } else if (source?.floatable) {
                actions.float(panelId, box);
            } else {
                // Non-floatable panel released over empty space — put it back
                // where it came from rather than leaving it in a floating state
                // it's never supposed to occupy.
                actions.dock(panelId, source?.area ?? "bottom");
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
            dragSourceRef.current = {area: armed.sourceArea, floatable: armed.floatable};

            const shell = shellRef.current?.getBoundingClientRect();
            // Float immediately so there is always a floating window for the
            // drag system to track. For non-floatable panels this state is
            // temporary — `onDrop` re-docks them if no target is hit. The
            // floating window is hidden during the drag itself (see the
            // `drag?.panelId` filter below), so no ghost flickers into view.
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
        const panel = panelById(panelId);
        if (!panel) {
            return;
        }

        // Floatable panels use their last known floating size for the drag
        // ghost — consistent with the window that appears if they're dropped
        // in empty space. Non-floatable panels fall back to a reasonable
        // preview size derived from their current dock dimension; the ghost
        // only ever shows a title bar, so the exact size doesn't matter much.
        const size = panel.floatable
            ? (state.floatingSizes[panelId] ?? FLOATING_SIZE)
            : area === "bottom"
                ? {width: FLOATING_SIZE.width, height: state.sizes.bottom}
                : {width: state.sizes[area], height: FLOATING_SIZE.height};

        armedRef.current = {
            panelId,
            startX: event.clientX,
            startY: event.clientY,
            offsetX: GRAB_OFFSET.x,
            offsetY: GRAB_OFFSET.y,
            width: size.width,
            height: size.height,
            floatable: panel.floatable,
            sourceArea: area,
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
            floatable: true,
            sourceArea: "bottom", // floating panels have no dock source; field is unused
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
        flashSignal,
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
                        onResize={(delta) =>
                            actions.resizeDock("left", state.sizes.left + delta, shellRef.current?.getBoundingClientRect().width)
                        }
                    />
                </>
            )}

            <div className="flex min-w-0 flex-1 flex-col">
                <div className="relative min-h-0 flex-1">
                    <MapView position={vehiclePosition} vehicleKind={vehicleKind} airspace={airspace}/>
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
                        onResize={(delta) =>
                            actions.resizeDock("right", state.sizes.right - delta, shellRef.current?.getBoundingClientRect().width)
                        }
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
                            flashToken={flashSignal?.panelId === win.panelId ? flashSignal.token : null}
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
