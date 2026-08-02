import {useMemo, useState} from "react";
import TopBar from "@/components/topmenu/TopBar.tsx";
import Workspace from "@/components/workspace/Workspace.tsx";
import FullScreenPage from "@/pages/FullScreenPage.tsx";
import SettingsPage from "@/pages/settings/SettingsPage.tsx";
import ParametersPage from "@/pages/parameters/ParametersPage.tsx";
import MissionPage from "@/pages/mission/MissionPage.tsx";
import ScriptingPage from "@/pages/scripting/ScriptingPage.tsx";
import CalibrationPage from "@/pages/calibration/CalibrationPage.tsx";
import {useWorkspace} from "@/lib/workspace/useWorkspace.ts";
import {useAirspace} from "@/lib/airspace/useAirspace.ts";
import {useConsoleEvents} from "@/lib/console/useConsoleEvents.ts";
import {useVehicle} from "@/lib/vehicle/useVehicle.ts";
import {useMission} from "@/lib/mission/useMission.ts";
import {useSettings} from "@/lib/settings/useSettings.ts";
import {useApplyDisplayMode} from "@/lib/settings/useApplyDisplayMode.ts";
import {useApplyConsoleSettings} from "@/lib/settings/useApplyConsoleSettings.ts";
import {NavigationApi, NavigationProvider} from "@/lib/navigation/useNavigation.tsx";
import {PageId} from "@/lib/navigation/navigation.ts";
import "./App.css";

function App() {
    // Owned here so the top bar's panel launcher and the workspace itself act
    // on the same state.
    const workspace = useWorkspace();
    // Read once and passed down, rather than each consumer subscribing to the
    // same `vehicle` event independently.
    const vehicle = useVehicle();
    // Owned here rather than inside `MissionPage`, even though the page is the
    // only thing that mounts it visually — `TopBar`'s "Upload to Vehicle" menu
    // item is a sibling of the page, not a descendant, and needs to reach the
    // same draft whether or not the page is currently open.
    const mission = useMission();
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
    // Same reasoning: the console store lives outside React and needs the
    // preference pushed to it, not just read once at mount.
    useApplyConsoleSettings(settings.consoleCollapseThreshold);
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
                    mission={mission}
                    onResetWorkspace={workspace.actions.resetToDefault}
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
                            {page === "mission" && <MissionPage mission={mission}/>}
                            {page === "scripting" && <ScriptingPage/>}
                            {page === "calibration" && <CalibrationPage/>}
                        </FullScreenPage>
                    )}
                </div>
            </main>
        </NavigationProvider>
    );
}

export default App;
