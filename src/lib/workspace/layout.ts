import {DockArea, DOCK_AREAS, PANEL_DEFINITIONS, canDock, panelById} from "./panels.ts";

export interface FloatingWindow {
    panelId: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface FloatingSize {
    width: number;
    height: number;
}

export type Placement =
    | {kind: "dock"; area: DockArea; index: number}
    | {kind: "floating"; x: number; y: number; width: number; height: number};

export interface WorkspaceState {
    /** Panel ids per dock, in tab order. */
    docks: Record<DockArea, string[]>;
    active: Record<DockArea, string | null>;
    sizes: Record<DockArea, number>;
    floating: FloatingWindow[];
    /**
     * Last known width/height per panel, independent of whether it's docked
     * or currently floating at all — updated on every `float()` call (drag
     * out of a dock, live resize, or a plain reopen). Unlike `floating`
     * itself this *is* persisted: a size preference is worth keeping even
     * though the open floating window it came from is not.
     */
    floatingSizes: Record<string, FloatingSize>;
    /**
     * Where each panel was when it was last closed, so reopening restores it.
     * Only the `dock` half is persisted: a floating window is temporary, so
     * after a restart a previously-floating panel has no memory and opens
     * floating fresh.
     */
    placements: Record<string, Placement>;
    /**
     * Every panel the layout has already accounted for. It is what separates a
     * panel the operator deliberately closed from one added to the registry
     * after this layout was saved.
     */
    known: string[];
}

export const DEFAULT_SIZES: Record<DockArea, number> = {left: 320, right: 320, bottom: 260};
export const MIN_SIZES: Record<DockArea, number> = {left: 180, right: 180, bottom: 120};
export const FLOATING_SIZE = {width: 380, height: 300};
export const MIN_FLOATING_SIZE = {width: 220, height: 140};

/** Where a panel with no placement history appears, near the panel launcher. */
export const FLOATING_ORIGIN = {x: 16, y: 48};
export const FLOATING_CASCADE = 24;

const STORAGE_KEY = "aetherius.workspace.v1";

function emptyDocks(): Record<DockArea, string[]> {
    return {left: [], right: [], bottom: []};
}

export function defaultState(): WorkspaceState {
    const docks = emptyDocks();
    for (const panel of PANEL_DEFINITIONS) {
        if (panel.openByDefault) {
            docks[panel.defaultDock].push(panel.id);
        }
    }

    return {
        docks,
        active: {
            left: docks.left[0] ?? null,
            right: docks.right[0] ?? null,
            bottom: docks.bottom[0] ?? null,
        },
        sizes: {...DEFAULT_SIZES},
        floating: [],
        floatingSizes: {},
        placements: {},
        known: PANEL_DEFINITIONS.map((panel) => panel.id),
    };
}

/**
 * Rebuild a trustworthy state from whatever was in storage. Anything that does
 * not survive validation is dropped rather than repaired, so a corrupt or
 * outdated entry degrades to the default layout instead of throwing.
 */
function reconcile(raw: unknown): WorkspaceState {
    if (!raw || typeof raw !== "object") {
        return defaultState();
    }

    const saved = raw as Partial<WorkspaceState>;
    const docks = emptyDocks();
    const placed = new Set<string>();

    for (const area of DOCK_AREAS) {
        for (const id of saved.docks?.[area] ?? []) {
            const panel = panelById(id);
            // A panel's allowed docks can change in the registry after a layout
            // was saved, so re-check rather than trusting the stored position.
            if (panel && !placed.has(id) && canDock(panel, area)) {
                docks[area].push(id);
                placed.add(id);
            }
        }
    }

    // Panels added to the registry since this layout was saved stay closed —
    // they are discoverable through the panel launcher, and opening them is the
    // operator's decision, not the layout's.
    const known = (saved.known ?? []).filter((id) => panelById(id));
    for (const panel of PANEL_DEFINITIONS) {
        if (!known.includes(panel.id)) {
            known.push(panel.id);
        }
    }

    const placements: Record<string, Placement> = {};
    for (const [id, placement] of Object.entries(saved.placements ?? {})) {
        const panel = panelById(id);
        if (panel && placement?.kind === "dock" && canDock(panel, placement.area)) {
            placements[id] = placement;
        }
    }

    const floatingSizes: Record<string, FloatingSize> = {};
    for (const [id, size] of Object.entries(saved.floatingSizes ?? {})) {
        if (
            panelById(id) &&
            size &&
            typeof size.width === "number" &&
            typeof size.height === "number" &&
            Number.isFinite(size.width) &&
            Number.isFinite(size.height)
        ) {
            floatingSizes[id] = {
                width: Math.max(MIN_FLOATING_SIZE.width, size.width),
                height: Math.max(MIN_FLOATING_SIZE.height, size.height),
            };
        }
    }

    const active = {} as Record<DockArea, string | null>;
    const sizes = {} as Record<DockArea, number>;
    for (const area of DOCK_AREAS) {
        const savedActive = saved.active?.[area];
        active[area] = savedActive && docks[area].includes(savedActive) ? savedActive : (docks[area][0] ?? null);

        const savedSize = saved.sizes?.[area];
        sizes[area] =
            typeof savedSize === "number" && Number.isFinite(savedSize)
                ? Math.max(MIN_SIZES[area], savedSize)
                : DEFAULT_SIZES[area];
    }

    // Floating windows are deliberately not restored — they are temporary.
    return {docks, active, sizes, floating: [], floatingSizes, placements, known};
}

export function loadState(): WorkspaceState {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        return raw ? reconcile(JSON.parse(raw)) : defaultState();
    } catch {
        return defaultState();
    }
}

export function saveState(state: WorkspaceState): void {
    try {
        const {docks, active, sizes, floatingSizes, known} = state;
        // Only dock placements survive a restart; floating ones are temporary.
        const placements = Object.fromEntries(
            Object.entries(state.placements).filter(([, placement]) => placement.kind === "dock"),
        );
        window.localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({docks, active, sizes, floatingSizes, placements, known}),
        );
    } catch {
        // A full or unavailable storage quota must not take the workspace down.
    }
}
