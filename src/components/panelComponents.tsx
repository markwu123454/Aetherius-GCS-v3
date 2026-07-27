import {ReactElement} from "react";
import {PanelDefinition} from "../workspace/panels";

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
};

export function PanelBody({panel}: {panel: PanelDefinition}) {
    const Component = PANEL_COMPONENTS[panel.component] ?? PlaceholderPanel;
    return <Component panel={panel}/>;
}
