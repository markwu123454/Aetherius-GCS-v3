import {PointerEvent as ReactPointerEvent} from "react";
import {DockArea, panelById} from "../lib/workspace/panels.ts";
import {PanelBody} from "./panelComponents.tsx";

interface DockProps {
    area: DockArea;
    panelIds: string[];
    activeId: string | null;
    onTabPointerDown: (panelId: string, event: ReactPointerEvent) => void;
    onClose: (panelId: string) => void;
}

export default function Dock({area, panelIds, activeId, onTabPointerDown, onClose}: DockProps) {
    const active = activeId ? panelById(activeId) : undefined;
    // The bottom dock reads better with its tabs against the outer edge.
    const tabsOnBottom = area === "bottom";

    const strip = (
        <div
            role="tablist"
            className={[
                "flex shrink-0 items-stretch overflow-x-auto bg-layer-01",
                tabsOnBottom ? "border-t border-border-subtle" : "border-b border-border-subtle",
            ].join(" ")}
        >
            {panelIds.map((id) => {
                const panel = panelById(id);
                if (!panel) {
                    return null;
                }
                const isActive = id === activeId;

                return (
                    <div
                        key={id}
                        role="tab"
                        aria-selected={isActive}
                        tabIndex={0}
                        onPointerDown={(event) => onTabPointerDown(id, event)}
                        className={[
                            "group flex cursor-grab items-center h-control-sm gap-2 border-r border-border-subtle px-3",
                            "text-label whitespace-nowrap select-none active:cursor-grabbing",
                            isActive
                                ? "bg-background text-text-primary"
                                : "text-text-secondary hover:bg-layer-hover-01 hover:text-text-primary",
                        ].join(" ")}
                    >
                        {panel.title}
                        <button
                            type="button"
                            aria-label={`Close ${panel.title}`}
                            // Keep the close click out of the drag gesture.
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={() => onClose(id)}
                            className="px-1 text-text-helper opacity-0 group-hover:opacity-100 hover:bg-layer-hover-02 hover:text-text-primary focus:opacity-100"
                        >
                            ×
                        </button>
                    </div>
                );
            })}
        </div>
    );

    return (
        <div className="flex h-full w-full min-w-0 flex-col bg-background">
            {!tabsOnBottom && strip}
            <div className="min-h-0 flex-1 overflow-auto">{active && <PanelBody panel={active}/>}</div>
            {tabsOnBottom && strip}
        </div>
    );
}
