import {ReactElement} from "react";
import {DockArea, PanelDefinition} from "@/lib/workspace/panels.ts";
import ConsolePanel from "./console/ConsolePanel.tsx";
import TelemetryPanel from "./telemetry/TelemetryPanel.tsx";
import PrearmPanel from "./prearm/PrearmPanel.tsx";
import ManualPanel from "./manual/ManualPanel.tsx";
import RcOverridePanel from "./manual/RcOverridePanel.tsx";
import MissionPanel from "./mission/MissionPanel.tsx";

/** Where a panel is currently rendered — the three dock slots or a floating
 * window. Panels that care about layout (TelemetryPanel, ManualPanel) use
 * this to pick a layout directly rather than inferring it from container size
 * at render time. */
export type PanelArea = DockArea | "floating";

export type PanelComponent = (props: {panel: PanelDefinition; area: PanelArea}) => ReactElement;

function PlaceholderPanel({panel}: {panel: PanelDefinition; area: PanelArea}) {
    return (
        <div className="flex h-full items-center justify-center text-label text-text-helper">
            {panel.title}
        </div>
    );
}

const PANEL_COMPONENTS: Record<string, PanelComponent> = {
    placeholder: PlaceholderPanel,
    console: ConsolePanel,
    telemetry: TelemetryPanel,
    prearm: PrearmPanel,
    manual: ManualPanel,
    "rc-override": RcOverridePanel,
    mission: MissionPanel,
};

export function PanelBody({panel, area}: {panel: PanelDefinition; area: PanelArea}) {
    const Component = PANEL_COMPONENTS[panel.component] ?? PlaceholderPanel;
    return <Component panel={panel} area={area}/>;
}
