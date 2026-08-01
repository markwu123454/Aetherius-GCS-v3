import {ReactElement} from "react";
import {PanelDefinition} from "../lib/workspace/panels.ts";
import ConsolePanel from "./console/ConsolePanel.tsx";
import TelemetryPanel from "./telemetry/TelemetryPanel.tsx";

export type PanelComponent = (props: {panel: PanelDefinition}) => ReactElement;

function PlaceholderPanel({panel}: {panel: PanelDefinition}) {
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
};

export function PanelBody({panel}: {panel: PanelDefinition}) {
    const Component = PANEL_COMPONENTS[panel.component] ?? PlaceholderPanel;
    return <Component panel={panel}/>;
}
