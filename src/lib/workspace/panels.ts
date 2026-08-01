export type DockArea = "left" | "right" | "bottom";

export const DOCK_AREAS: DockArea[] = ["left", "right", "bottom"];

export interface PanelDefinition {
    id: string;
    title: string;
    /** Key into the panel component registry in `panelComponents.tsx`. */
    component: string;
    dockLeft: boolean;
    dockRight: boolean;
    dockBottom: boolean;
    floatable: boolean;
    /** Where this panel sits on a fresh install, if it starts open at all. */
    defaultDock: DockArea;
    /**
     * Only a minimal set starts docked. Everything else stays closed until the
     * operator opens it, and then opens floating so placement is their choice.
     */
    openByDefault: boolean;
}

export const PANEL_DEFINITIONS: PanelDefinition[] = [
    {
        id: "telemetry",
        title: "Telemetry",
        component: "telemetry",
        dockLeft: true,
        dockRight: true,
        dockBottom: true,
        floatable: true,
        defaultDock: "bottom",
        openByDefault: true,
    },
    {
        id: "mission",
        title: "Mission",
        component: "placeholder",
        dockLeft: true,
        dockRight: true,
        dockBottom: false,
        floatable: true,
        defaultDock: "right",
        openByDefault: false,
    },
    {
        id: "console",
        title: "Console",
        component: "console",
        // Sizes off its own container rather than the viewport, so a narrow
        // side dock is as workable as a wide bottom one.
        dockLeft: true,
        dockRight: true,
        dockBottom: true,
        floatable: true,
        defaultDock: "left",
        openByDefault: true,
    },
    {
        id: "prearm",
        title: "Prearm",
        component: "prearm",
        dockLeft: true,
        dockRight: true,
        dockBottom: true,
        floatable: true,
        defaultDock: "right",
        openByDefault: false,
    },
];

export function panelById(id: string): PanelDefinition | undefined {
    return PANEL_DEFINITIONS.find((panel) => panel.id === id);
}

export function canDock(panel: PanelDefinition, area: DockArea): boolean {
    switch (area) {
        case "left":
            return panel.dockLeft;
        case "right":
            return panel.dockRight;
        case "bottom":
            return panel.dockBottom;
    }
}
