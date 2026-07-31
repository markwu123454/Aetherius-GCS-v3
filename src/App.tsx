import {useMemo, useState} from "react";
import TopBar from "./components/TopBar";
import Workspace from "./components/Workspace";
import FullScreenPage from "./components/FullScreenPage";
import SettingsPage from "./components/SettingsPage";
import ParametersPage from "./components/ParametersPage";
import {useWorkspace} from "./workspace/useWorkspace";
import {useAirspace} from "./airspace/useAirspace";
import {useConsoleEvents} from "./console/useConsoleEvents";
import {useVehicle} from "./vehicle/useVehicle";
import {useSettings} from "./settings/useSettings";
import {useApplyDisplayMode} from "./settings/useApplyDisplayMode";
import {NavigationApi, NavigationProvider} from "./navigation/useNavigation";
import {PageId} from "./navigation/navigation";
import "./App.css";

function App() {
    // Owned here so the top bar's panel launcher and the workspace itself act
    // on the same state.
    const workspace = useWorkspace();
    // Read once and passed down, rather than each consumer subscribing to the
    // same `vehicle` event independently.
    const vehicle = useVehicle();
    // Same reasoning: one loaded copy, so a future preferences panel and
    // everything else that reads a setting stay in sync with each other.
    const settings = useSettings();
    // Reads its presentation out of `settings`, so the Settings page and the
    // View menu drive one switch rather than two that can disagree.
    const airspace = useAirspace(settings);
    // Subscribed once here rather than inside the panel: the console is closed
    // by default, and a log that only starts recording when you open it is
    // useless for explaining something that already happened.
    useConsoleEvents();
    // Applies whenever the setting changes, not just from the Settings page —
    // this is the one preference with a real-world side effect outside React.
    useApplyDisplayMode(settings.displayMode);
    // `null` is the bare workspace; anything else lays that page over the top
    // of it. Over, not instead of: unmounting the workspace takes `MapView`
    // with it, and its cleanup calls `map.remove()` — so a two-second trip to
    // Settings mid-flight would drop the WebGL context, throw away the tile
    // cache, and come back at the zoom-2 world view with the first-fix
    // flight-in queued up again.
    const [page, setPage] = useState<PageId | null>(null);

    const navigation = useMemo<NavigationApi>(
        () => ({
            openPanel: workspace.actions.open,
            closePanel: workspace.actions.close,
            openPage: setPage,
            closePage: () => setPage(null),
        }),
        [workspace.actions],
    );

    return (
        <NavigationProvider value={navigation}>
            <main className="flex h-full w-full flex-col overflow-hidden">
                <TopBar
                    vehicle={vehicle}
                    settings={settings}
                    openIds={workspace.openIds}
                    page={page}
                    airspace={airspace}
                />
                <div className="relative min-h-0 flex-1">
                    {/* `inert` because the workspace is still in the tree behind
                        an opaque page — without it, tabbing off the page walks
                        into dock tabs and floating panels nobody can see. */}
                    <div className="h-full w-full" inert={page !== null}>
                        <Workspace
                            workspace={workspace}
                            vehiclePosition={vehicle.position}
                            vehicleKind={vehicle.vehicleKind}
                            airspace={airspace}
                        />
                    </div>
                    {page !== null && (
                        <FullScreenPage>
                            {page === "settings" && <SettingsPage settings={settings}/>}
                            {page === "parameters" && <ParametersPage/>}
                        </FullScreenPage>
                    )}
                </div>
            </main>
        </NavigationProvider>
    );
}

export default App;
