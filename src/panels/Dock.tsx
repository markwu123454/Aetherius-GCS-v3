import {PointerEvent as ReactPointerEvent} from "react";
import {Close} from "@carbon/icons-react";
import {DockArea, panelById} from "@/lib/workspace/panels.ts";
import {FlashSignal} from "@/lib/workspace/useWorkspace.ts";
import {PanelBody} from "./panelComponents.tsx";

interface DockProps {
    area: DockArea;
    panelIds: string[];
    activeId: string | null;
    onTabPointerDown: (panelId: string, event: ReactPointerEvent) => void;
    onClose: (panelId: string) => void;
    flashSignal: FlashSignal | null;
}

export default function Dock({area, panelIds, activeId, onTabPointerDown, onClose, flashSignal}: DockProps) {
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
                            "flex cursor-grab items-center h-control-sm gap-2 border-r border-border-subtle px-3",
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
                            className="p-1 text-text-helper hover:bg-layer-hover-02 hover:text-text-primary"
                        >
                            <Close size={14} />
                        </button>
                    </div>
                );
            })}
        </div>
    );

    const flashing = active && flashSignal?.panelId === active.id;

    return (
        <div className="flex h-full w-full min-w-0 flex-col bg-background">
            {!tabsOnBottom && strip}
            <div className="relative min-h-0 flex-1 overflow-hidden">
                <div className="absolute inset-0 overflow-auto">{active && <PanelBody panel={active}/>}</div>
                {/* Keyed by token, not just presence, so re-flashing the same
                    panel before the previous flash finished still restarts the
                    animation instead of no-op'ing on an unchanged className. */}
                {flashing && <div key={flashSignal.token} className="panel-flash pointer-events-none absolute inset-0"/>}
            </div>
            {tabsOnBottom && strip}
        </div>
    );
}
