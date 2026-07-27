import {useCallback, useEffect, useMemo, useState} from "react";
import {DockArea, DOCK_AREAS, panelById} from "./panels";
import {
    FLOATING_CASCADE,
    FLOATING_ORIGIN,
    FLOATING_SIZE,
    FloatingWindow,
    MIN_SIZES,
    Placement,
    WorkspaceState,
    loadState,
    saveState,
} from "./layout";

/** Where a panel currently lives, recorded so reopening can restore it. */
function placementOf(state: WorkspaceState, panelId: string): Placement | null {
    for (const area of DOCK_AREAS) {
        const index = state.docks[area].indexOf(panelId);
        if (index !== -1) {
            return {kind: "dock", area, index};
        }
    }

    const win = state.floating.find((entry) => entry.panelId === panelId);
    return win ? {kind: "floating", x: win.x, y: win.y, width: win.width, height: win.height} : null;
}

/** Remove a panel from every dock and from the floating set. */
function detach(state: WorkspaceState, panelId: string): WorkspaceState {
    const docks = {...state.docks};
    const active = {...state.active};

    for (const area of DOCK_AREAS) {
        if (!docks[area].includes(panelId)) {
            continue;
        }
        docks[area] = docks[area].filter((id) => id !== panelId);
        if (active[area] === panelId) {
            active[area] = docks[area][0] ?? null;
        }
    }

    return {
        ...state,
        docks,
        active,
        floating: state.floating.filter((window) => window.panelId !== panelId),
    };
}

function remember(state: WorkspaceState, panelId: string): WorkspaceState {
    return state.known.includes(panelId) ? state : {...state, known: [...state.known, panelId]};
}

/** Offset each new window so opening several does not stack them exactly. */
function cascadeSlot(state: WorkspaceState) {
    const step = state.floating.length % 6;
    return {
        x: FLOATING_ORIGIN.x + step * FLOATING_CASCADE,
        y: FLOATING_ORIGIN.y + step * FLOATING_CASCADE,
        ...FLOATING_SIZE,
    };
}

export interface WorkspaceActions {
    dock: (panelId: string, area: DockArea, index?: number) => void;
    float: (panelId: string, box: Omit<FloatingWindow, "panelId">) => void;
    close: (panelId: string) => void;
    open: (panelId: string) => void;
    activate: (area: DockArea, panelId: string) => void;
    resizeDock: (area: DockArea, size: number) => void;
}

export function useWorkspace() {
    const [state, setState] = useState<WorkspaceState>(loadState);

    useEffect(() => {
        saveState(state);
    }, [state]);

    const dock = useCallback((panelId: string, area: DockArea, index?: number) => {
        setState((current) => {
            const next = detach(current, panelId);
            const ids = [...next.docks[area]];
            ids.splice(index ?? ids.length, 0, panelId);

            return remember(
                {
                    ...next,
                    docks: {...next.docks, [area]: ids},
                    active: {...next.active, [area]: panelId},
                },
                panelId,
            );
        });
    }, []);

    const float = useCallback((panelId: string, box: Omit<FloatingWindow, "panelId">) => {
        setState((current) => {
            const next = detach(current, panelId);
            return remember({...next, floating: [...next.floating, {panelId, ...box}]}, panelId);
        });
    }, []);

    const close = useCallback((panelId: string) => {
        setState((current) => {
            // Record where it was on the way out so reopening can restore it.
            const placement = placementOf(current, panelId);
            const next = remember(detach(current, panelId), panelId);

            return placement ? {...next, placements: {...next.placements, [panelId]: placement}} : next;
        });
    }, []);

    const open = useCallback((panelId: string) => {
        const panel = panelById(panelId);
        if (!panel) {
            return;
        }

        setState((current) => {
            const placement = current.placements[panelId];

            if (placement?.kind === "dock") {
                const next = detach(current, panelId);
                const ids = [...next.docks[placement.area]];
                ids.splice(Math.min(placement.index, ids.length), 0, panelId);

                return remember(
                    {
                        ...next,
                        docks: {...next.docks, [placement.area]: ids},
                        active: {...next.active, [placement.area]: panelId},
                    },
                    panelId,
                );
            }

            // No remembered dock: open floating so placement stays the
            // operator's decision.
            const box =
                placement?.kind === "floating"
                    ? {x: placement.x, y: placement.y, width: placement.width, height: placement.height}
                    : cascadeSlot(current);
            const next = detach(current, panelId);

            return remember({...next, floating: [...next.floating, {panelId, ...box}]}, panelId);
        });
    }, []);

    const activate = useCallback((area: DockArea, panelId: string) => {
        setState((current) => ({...current, active: {...current.active, [area]: panelId}}));
    }, []);

    const resizeDock = useCallback((area: DockArea, size: number) => {
        setState((current) => ({
            ...current,
            sizes: {...current.sizes, [area]: Math.max(MIN_SIZES[area], Math.round(size))},
        }));
    }, []);

    const actions = useMemo<WorkspaceActions>(
        () => ({dock, float, close, open, activate, resizeDock}),
        [dock, float, close, open, activate, resizeDock],
    );

    /** A dock only occupies space when it holds at least one panel. */
    const visible = useMemo(
        () =>
            DOCK_AREAS.reduce(
                (acc, area) => ({...acc, [area]: state.docks[area].length > 0}),
                {} as Record<DockArea, boolean>,
            ),
        [state.docks],
    );

    const openIds = useMemo(
        () =>
            new Set([
                ...DOCK_AREAS.flatMap((area) => state.docks[area]),
                ...state.floating.map((window) => window.panelId),
            ]),
        [state.docks, state.floating],
    );

    return {state, actions, visible, openIds};
}
