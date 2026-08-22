import {useEffect, useMemo, useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import TopBar from "@/components/topmenu/TopBar.tsx";
import Workspace from "@/components/workspace/Workspace.tsx";
import UpdatePromptModal from "@/components/UpdatePromptModal.tsx";
import FullScreenPage from "@/pages/FullScreenPage.tsx";
import SettingsPage from "@/pages/settings/SettingsPage.tsx";
import ParametersPage from "@/pages/parameters/ParametersPage.tsx";
import MissionPage from "@/pages/mission/MissionPage.tsx";
import GeofencePage from "@/pages/geofence/GeofencePage.tsx";
import RallyPage from "@/pages/rally/RallyPage.tsx";
import InspectorPage from "@/pages/inspector/InspectorPage.tsx";
import ScriptingPage from "@/pages/scripting/ScriptingPage.tsx";
import CalibrationPage from "@/pages/calibration/CalibrationPage.tsx";
import SetupPage from "@/pages/setup/SetupPage.tsx";
import FirmwarePage from "@/pages/firmware/FirmwarePage.tsx";
import LogsPage from "@/pages/logs/LogsPage.tsx";
import LogAnalysisPage from "@/pages/logs/LogAnalysisPage.tsx";
import AboutPage from "@/pages/about/AboutPage.tsx";
import SdCardLogsPage from "@/pages/sdcard/SdCardLogsPage.tsx";
import SdCardScriptingPage from "@/pages/sdcard/SdCardScriptingPage.tsx";
import {useWorkspace} from "@/lib/workspace/useWorkspace.ts";
import {useAirspace} from "@/lib/airspace/useAirspace.ts";
import {useConsoleEvents} from "@/lib/console/useConsoleEvents.ts";
import {useVehicle} from "@/lib/vehicle/useVehicle.ts";
import {useMission} from "@/lib/mission/useMission.ts";
import {useSettings} from "@/lib/settings/useSettings.ts";
import {useApplyDisplayMode} from "@/lib/settings/useApplyDisplayMode.ts";
import {useApplyConsoleSettings} from "@/lib/settings/useApplyConsoleSettings.ts";
import {useApplyTelemetrySettings} from "@/lib/settings/useApplyTelemetrySettings.ts";
import {useUpdateCheck} from "@/lib/update/useUpdateCheck.ts";
import {NavigationApi, NavigationProvider} from "@/lib/navigation/useNavigation.tsx";
import {PAGE_BACK_TARGET, PageId} from "@/lib/navigation/navigation.ts";
import "./App.css";

function App() {
    useEffect(() => {
        invoke("close_splash").catch(() => {});
    }, []);

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
    useApplyTelemetrySettings(settings.telemetrySparklines);
    // Owned here rather than inside `AboutPage` so a launch-time check and a
    // manual "Check for Updates" click share one `Update` resource instead of
    // each holding its own.
    const update = useUpdateCheck();
    useEffect(() => {
        void update.checkNow();
        // Launch only — `update.checkNow` is stable but including it would
        // still be wrong here, since re-checking on every render is not what
        // "on launch" means.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    // Sticky once `status` first reaches "available", rather than reflecting
    // `status` directly — clicking "Update" in the prompt drives `status`
    // through "downloading" / "ready" / "error", and the prompt needs to stay
    // up through all of that instead of unmounting the moment it stops being
    // exactly "available".
    const [updatePromptOpen, setUpdatePromptOpen] = useState(false);
    useEffect(() => {
        if (update.status === "available") {
            setUpdatePromptOpen(true);
        }
    }, [update.status]);
    // Not persisted anywhere on purpose: "remind me next time" means exactly
    // that — the prompt reappears on the next launch's check, not on a timer
    // or a second click within this session.
    const [updatePromptDismissed, setUpdatePromptDismissed] = useState(false);
    // `null` is the bare workspace; anything else lays that page over the top
    // of it. Over, not instead of: unmounting the workspace takes `MapView`
    // with it, and its cleanup calls `map.remove()` — so a two-second trip to
    // Settings mid-flight would drop the WebGL context, throw away the tile
    // cache, and come back at the zoom-2 world view with the first-fix
    // flight-in queued up again.
    const [page, setPage] = useState<PageId | null>(null);
    // Which log Log Analysis has open. A sibling of the page rather than
    // state inside `LogAnalysisPage`, same reasoning as `mission` above —
    // the Logs page's "Analyze" button is what sets it, and needs to reach
    // it whether or not Log Analysis happens to be mounted yet.
    const [analysisLogPath, setAnalysisLogPath] = useState<string | null>(null);
    // Log Analysis opens from either the live Logs page or SD Card Logs —
    // `PAGE_BACK_TARGET`'s static table can't express "back to whichever
    // one opened it," so whoever calls `openAnalysis` records itself here
    // instead, and `closePage` prefers this over the table for that one page.
    const [analysisReturnPage, setAnalysisReturnPage] = useState<PageId>("logs");

    const navigation = useMemo<NavigationApi>(
        () => ({
            openPanel: workspace.actions.open,
            closePanel: workspace.actions.close,
            openPage: setPage,
            // Most pages close straight to the workspace; a page present in
            // `PAGE_BACK_TARGET` (just Log Analysis today) instead swaps to
            // the page it's conceptually nested under — except Log Analysis
            // itself, which uses `analysisReturnPage` since that page's
            // "nested under" target isn't fixed the way the table assumes.
            closePage: () =>
                setPage((prev) => (prev === "logAnalysis" ? analysisReturnPage : (prev && PAGE_BACK_TARGET[prev]) ?? null)),
        }),
        [workspace.actions, analysisReturnPage],
    );

    // Shared by the live Logs page and SD Card Logs — both just hand this a
    // path, local either way (SD Card's was never anywhere but local).
    const openAnalysis = (path: string, from: PageId) => {
        setAnalysisLogPath(path);
        setAnalysisReturnPage(from);
        navigation.openPage("logAnalysis");
    };

    return (
        <NavigationProvider value={navigation}>
            <main className="flex h-full w-full flex-col overflow-hidden">
                <TopBar
                    vehicle={vehicle}
                    settings={settings}
                    openIds={workspace.openIds}
                    page={page}
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
                            {page === "geofence" && <GeofencePage/>}
                            {page === "rally" && <RallyPage/>}
                            {page === "inspector" && <InspectorPage/>}
                            {page === "scripting" && <ScriptingPage/>}
                            {page === "calibration" && <CalibrationPage/>}
                            {page === "setup" && <SetupPage/>}
                            {page === "firmware" && <FirmwarePage/>}
                            {page === "logs" && <LogsPage onAnalyze={(path) => openAnalysis(path, "logs")}/>}
                            {page === "logAnalysis" && <LogAnalysisPage path={analysisLogPath}/>}
                            {page === "about" && <AboutPage update={update}/>}
                            {page === "sdcardLogs" && <SdCardLogsPage onAnalyze={(path) => openAnalysis(path, "sdcardLogs")}/>}
                            {page === "sdcardScripting" && <SdCardScriptingPage/>}
                        </FullScreenPage>
                    )}
                </div>
                {updatePromptOpen && !updatePromptDismissed && (
                    <UpdatePromptModal update={update} onDismiss={() => setUpdatePromptDismissed(true)}/>
                )}
            </main>
        </NavigationProvider>
    );
}

export default App;
