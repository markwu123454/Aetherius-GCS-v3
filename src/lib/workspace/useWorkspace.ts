import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {DockArea, DOCK_AREAS, panelById} from "./panels.ts";
import {
    defaultState,
    FLOATING_CASCADE,
    FLOATING_ORIGIN,
    FLOATING_SIZE,
    FloatingSize,
    FloatingWindow,
    MAX_SIZES,
    MIN_BOTTOM_WIDTH,
    MIN_SIZES,
    Placement,
    WorkspaceState,
    loadState,
    saveState,
} from "./layout.ts";

/** How long a re-triggered-open flash stays visible; matches the CSS
 * animation duration in App.css's `.panel-flash` rule. */
const FLASH_DURATION_MS = 600;

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
    };
}

/** A panel's remembered floating size, or the shared default for one that has
 * never been floated before. */
function floatingSizeFor(state: WorkspaceState, panelId: string): FloatingSize {
    return state.floatingSizes[panelId] ?? FLOATING_SIZE;
}

export interface WorkspaceActions {
    dock: (panelId: string, area: DockArea, index?: number) => void;
    float: (panelId: string, box: Omit<FloatingWindow, "panelId">) => void;
    close: (panelId: string) => void;
    open: (panelId: string) => void;
    activate: (area: DockArea, panelId: string) => void;
    resizeDock: (area: DockArea, size: number, shellWidth?: number) => void;
    /** Discards docking, sizing, and placement history and returns to the
     * registry's own defaults — the only way back for a layout dragged into
     * an unrecoverable state. Floating windows already don't survive a
     * restart (see `defaultState`), so there's nothing extra to clear there. */
    resetToDefault: () => void;
}

export interface FlashSignal {
    panelId: string;
    token: number;
}

export function useWorkspace() {
    const [state, setState] = useState<WorkspaceState>(loadState);

    useEffect(() => {
        saveState(state);
    }, [state]);

    // Purely transient "where is it" cue for reopening an already-open
    // panel — never persisted, never affects layout. A token rather than a
    // boolean so flashing the same panel twice in a row still restarts the
    // animation instead of no-op'ing because the className didn't change.
    const [flashSignal, setFlashSignal] = useState<FlashSignal | null>(null);
    const flashTokenRef = useRef(0);
    const flash = useCallback((panelId: string) => {
        flashTokenRef.current += 1;
        setFlashSignal({panelId, token: flashTokenRef.current});
    }, []);

    useEffect(() => {
        if (!flashSignal) {
            return;
        }
        const timer = setTimeout(() => {
            setFlashSignal((current) => (current?.token === flashSignal.token ? null : current));
        }, FLASH_DURATION_MS);
        return () => clearTimeout(timer);
    }, [flashSignal]);

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
            return remember(
                {
                    ...next,
                    floating: [...next.floating, {panelId, ...box}],
                    floatingSizes: {...next.floatingSizes, [panelId]: {width: box.width, height: box.height}},
                },
                panelId,
            );
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

        // Already on screen: opening it again is a "where is it" gesture, not
        // a re-open — bring its dock tab forward if needed, leave
        // position/size alone entirely, and just flash it so it's easy to
        // spot rather than moving or duplicating anything.
        const dockedArea = DOCK_AREAS.find((area) => state.docks[area].includes(panelId));
        const isFloating = state.floating.some((win) => win.panelId === panelId);
        if (dockedArea || isFloating) {
            flash(panelId);
            if (dockedArea && state.active[dockedArea] !== panelId) {
                setState((current) => ({...current, active: {...current.active, [dockedArea]: panelId}}));
            }
            return;
        }

        setState((current) => {
            const placement = current.placements[panelId];
            const size = floatingSizeFor(current, panelId);

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
            // operator's decision. Position comes from where it last closed
            // (or a cascade slot for a panel that's never been placed at
            // all); size always comes from `floatingSizes`, which tracks the
            // panel regardless of whether *this* instance was ever closed.
            const origin = placement?.kind === "floating" ? {x: placement.x, y: placement.y} : cascadeSlot(current);
            const next = detach(current, panelId);

            return remember({...next, floating: [...next.floating, {panelId, ...origin, ...size}]}, panelId);
        });
    }, [state, flash]);

    const activate = useCallback((area: DockArea, panelId: string) => {
        setState((current) => ({...current, active: {...current.active, [area]: panelId}}));
    }, []);

    const resizeDock = useCallback((area: DockArea, size: number, shellWidth?: number) => {
        setState((current) => {
            const floor = MIN_SIZES[area];
            let ceiling = MAX_SIZES[area];

            // Bottom's width is never dragged directly — it's whatever's left
            // of the shell between left and right — so left/right's own cap
            // only holds up to the point it would eat into bottom's floor.
            // Whichever bound the drag reaches first wins; if both docks are
            // already maxed and the window is too narrow to honor both plus
            // `MIN_BOTTOM_WIDTH`, the `Math.max(floor, ceiling)` below lets
            // this dock's own floor win instead of collapsing below it.
            if (area !== "bottom" && shellWidth !== undefined && current.docks.bottom.length > 0) {
                const other: DockArea = area === "left" ? "right" : "left";
                const otherWidth = current.docks[other].length > 0 ? current.sizes[other] : 0;
                ceiling = Math.min(ceiling, shellWidth - otherWidth - MIN_BOTTOM_WIDTH);
            }

            const clamped = Math.round(Math.min(Math.max(floor, ceiling), Math.max(floor, size)));
            return {...current, sizes: {...current.sizes, [area]: clamped}};
        });
    }, []);

    const resetToDefault = useCallback(() => {
        setState(defaultState());
    }, []);

    const actions = useMemo<WorkspaceActions>(
        () => ({dock, float, close, open, activate, resizeDock, resetToDefault}),
        [dock, float, close, open, activate, resizeDock, resetToDefault],
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

    return {state, actions, visible, openIds, flashSignal};
}
