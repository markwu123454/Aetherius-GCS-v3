import {useMemo, useState} from "react";
import TopBar from "./components/TopBar";
import Workspace from "./components/Workspace";
import FullScreenPage from "./components/FullScreenPage";
import SettingsPage from "./components/SettingsPage";
import {useWorkspace} from "./workspace/useWorkspace";
import {useVehicle} from "./vehicle/useVehicle";
import {useSettings} from "./settings/useSettings";
import {useApplyDisplayMode} from "./settings/useApplyDisplayMode";
import {NavigationApi, NavigationProvider} from "./navigation/useNavigation";
import {PAGE_TITLES, PageId} from "./navigation/navigation";
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
    // Applies whenever the setting changes, not just from the Settings page —
    // this is the one preference with a real-world side effect outside React.
    useApplyDisplayMode(settings.displayMode);
    // `null` renders the workspace; anything else swaps it for that page.
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
            <main className="flex h-screen w-screen flex-col overflow-hidden">
                <TopBar vehicle={vehicle} settings={settings} openIds={workspace.openIds}/>
                <div className="min-h-0 flex-1">
                    {page === null ? (
                        <Workspace
                            workspace={workspace}
                            vehiclePosition={vehicle.position}
                            vehicleKind={vehicle.vehicleKind}
                        />
                    ) : (
                        <FullScreenPage title={PAGE_TITLES[page]}>
                            {page === "settings" && <SettingsPage settings={settings}/>}
                        </FullScreenPage>
                    )}
                </div>
            </main>
        </NavigationProvider>
    );
}

export default App;
