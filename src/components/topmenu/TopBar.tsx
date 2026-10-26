import {openFeedback} from "@/lib/feedback/feedbackDialog.ts";
import {useEffect, useMemo, useRef, useState} from "react";
import {ArrowLeft} from "@carbon/icons-react";
import AppMenu, {Menu} from "./AppMenu.tsx";
import StatusChip, {Tone} from "./StatusChip.tsx";
import ConnectControl from "./ConnectControl.tsx";
import ArmControl from "./ArmControl.tsx";
import ModeControl from "./ModeControl.tsx";
import TopBarStatus from "./TopBarStatus.tsx";
import {useNow} from "@/lib/vehicle/useMockVehicle.ts";
import {alertLevel, fixLabel, VehicleState, worst} from "@/lib/vehicle/vehicle.ts";
import {isLinkFailing, isLinkIdle, linkSeverity} from "@/lib/vehicle/connection.ts";
import {PANEL_DEFINITIONS} from "@/lib/workspace/panels.ts";
import {useConnection} from "@/lib/vehicle/useConnection.ts";
import {useSdCard} from "@/lib/sdcard/useSdCard.ts";
import {SettingsApi} from "@/lib/settings/useSettings.ts";
import {useNavigation} from "@/lib/navigation/useNavigation.tsx";
import {PAGE_TITLES, PageId} from "@/lib/navigation/navigation.ts";
import type {MissionApi} from "@/lib/mission/useMission.ts";

interface TopBarProps {
    vehicle: VehicleState;
    settings: SettingsApi;
    openIds: Set<string>;
    /** `null` for the workspace; otherwise the full-screen page currently
     * open, so its back control and title can live in this one strip
     * instead of a second bar underneath it. */
    page: PageId | null;
    mission: MissionApi;
    onResetWorkspace: () => void;
}

export default function TopBar({vehicle, settings, openIds, page, mission, onResetWorkspace}: TopBarProps) {
    const now = useNow();

    // The backend owns the link state machine; this only reflects it.
    const connection = useConnection();
    // Reachable the same way from a panel's own content or a page's own
    // content — this is just the top bar's turn to use it.
    const navigation = useNavigation();
    // Only needed here for "Choose Folder…"; the pages themselves read the
    // same store directly.
    const sdCard = useSdCard();

    // Null until a packet has actually arrived. Deriving an age from a zero
    // timestamp would measure against the epoch, not against a packet.
    const packetAge = vehicle.updatedAt === 0 ? null : now - vehicle.updatedAt;
    const [menuExpanded, setMenuExpanded] = useState(false);

    // Vehicle health and link health are judged separately and then combined,
    // so neither can quietly mask the other.
    const level = worst(alertLevel(vehicle), linkSeverity(connection.status, packetAge));

    // Readings are struck through only once a link that was working stops. An
    // idle link has nothing to be stale about.
    const stale = isLinkFailing(connection.status);
    const unknown = isLinkIdle(connection.status);
    const staleFor = stale && packetAge !== null ? Math.round(packetAge / 1000) : null;
    // A couple of seconds of silence is ordinary on a radio link; sustained
    // silence is not, and is shown at the same weight as a dead transport.
    const severe = linkSeverity(connection.status, packetAge) === "danger";

    // An operator must never be left browsing the menu, in a degraded strip, at
    // the moment something goes wrong. Escalation into danger closes it for
    // them rather than waiting for them to notice.
    const previousLevel = useRef(level);
    useEffect(() => {
        if (level === "danger" && previousLevel.current !== "danger") {
            setMenuExpanded(false);
        }
        previousLevel.current = level;
    }, [level]);

    // The whole strip's background carries link health, rather than any one
    // reading, so it stays visible regardless of how the surrounding panels
    // are arranged. Losing only starts pulsing after a second of silence — a
    // radio hiccup that clears in a beat is not worth animating for.
    const [pulseWarn, setPulseWarn] = useState(false);
    useEffect(() => {
        if (connection.status !== "losing") {
            setPulseWarn(false);
            return;
        }
        const timer = window.setTimeout(() => setPulseWarn(true), 1000);
        return () => window.clearTimeout(timer);
    }, [connection.status]);

    // Lost flashes red to catch a glance, then holds a steady red tint for as
    // long as the link stays down, rather than fading back to normal, which
    // would read as "resolved" while it is not.
    const [lostStage, setLostStage] = useState<"flash" | "steady" | null>(null);
    useEffect(() => {
        if (connection.status !== "lost") {
            setLostStage(null);
            return;
        }
        setLostStage("flash");
        const timer = window.setTimeout(() => setLostStage("steady"), 2400);
        return () => window.clearTimeout(timer);
    }, [connection.status]);

    const headerAnimClass =
        lostStage === "flash"
            ? "topbar-flash-danger"
            : lostStage === "steady"
              ? "topbar-steady-danger"
              : pulseWarn
                ? "topbar-pulse-warn"
                : "bg-layer-01";

    const menus = useMemo<Menu[]>(
        () => [
            {
                label: "Vehicle",
                items: [
                    {label: "Firmware", action: () => navigation.openPage("firmware")},
                    {label: "Calibration", action: () => navigation.openPage("calibration")},
                    {label: "Setup", action: () => navigation.openPage("setup")},
                    {label: "Parameters", action: () => navigation.openPage("parameters")},
                    {label: "Scripting", action: () => navigation.openPage("scripting")},
                    {label: "Logs", action: () => navigation.openPage("logs")},
                ],
            },
            {
                label: "SD Card",
                items: [
                    {label: "Logs", action: () => navigation.openPage("sdcardLogs")},
                    {label: "Scripts", action: () => navigation.openPage("sdcardScripting")},
                    // Parameters was dropped: ArduPilot doesn't write a
                    // `.param` file to the card, only an opaque binary
                    // EEPROM backup (`APM/STRG_BAK`) with no names in it —
                    // there was never anything real for this to show.
                    //
                    // Separated from the pages above: this isn't a
                    // destination, it's the setting that decides what they
                    // all show.
                    {label: "Choose Folder…", action: sdCard.chooseFolder, separatorBefore: true},
                ],
            },
            {
                label: "Mission",
                items: [
                    {label: "Edit Mission…", action: () => navigation.openPage("mission")},
                    {
                        label: "Upload to Vehicle",
                        action: () => void mission.upload().catch(() => {}),
                        disabled: mission.waypoints.length === 0 || mission.uploading,
                    },
                    {
                        label: "Start Mission",
                        action: () => void mission.start().catch(() => {}),
                        disabled: mission.starting,
                        title: mission.starting ? "Already starting" : undefined,
                    },
                    {label: "Edit Geofence…", action: () => navigation.openPage("geofence"), separatorBefore: true},
                    {label: "Edit Rally Points…", action: () => navigation.openPage("rally")},
                ],
            },
            {
                label: "View",
                items: [
                    // Panels live here rather than in their own control: opening
                    // one is a low-frequency action and does not earn permanent
                    // space on a strip this dense.
                    ...PANEL_DEFINITIONS.map((panel) => ({
                        label: panel.title,
                        checked: openIds.has(panel.id),
                        action: () =>
                            openIds.has(panel.id)
                                ? navigation.closePanel(panel.id)
                                : navigation.openPanel(panel.id),
                    })),
                    {label: "Reset Workspace", separatorBefore: true, action: onResetWorkspace},
                ],
            },
            {
                // Not "Settings": Preferences is the only actual setting here —
                // About and the Inspector are look-up/diagnostic tools, not
                // configuration, and don't belong under that name. "Help" is
                // the conventional home for exactly this mix.
                label: "Help",
                items: [
                    {label: "Preferences…", action: () => navigation.openPage("settings")},
                    {label: "MAVLink Inspector…", action: () => navigation.openPage("inspector")},
                    {label: "Report a Bug…", action: () => openFeedback("bug"), separatorBefore: true},
                    {label: "Request a Feature…", action: () => openFeedback("feature")},
                    {label: "About", action: () => navigation.openPage("about"), separatorBefore: true},
                ],
            },
        ],
        [openIds, navigation, mission, onResetWorkspace, sdCard.chooseFolder],
    );

    const compact = menuExpanded;
    const battery = vehicle.battery;

    const batteryTone: Tone = battery.percent <= 15 ? "danger" : battery.percent <= 25 ? "warn" : "ok";
    const gpsTone: Tone =
        vehicle.gps.fix === "none" ? "danger" : vehicle.gps.fix === "2d" ? "warn" : "ok";
    const linkTone: Tone = vehicle.link.lossPercent > 5 ? "warn" : "ok";

    return (
        <header
            className={`flex h-control-sm shrink-0 items-stretch border-b border-border-subtle text-text-primary ${headerAnimClass}`}
        >
            <AppMenu menus={menus} expanded={menuExpanded} onExpandedChange={setMenuExpanded}/>

            {/* A sibling of the menu, not a fixed corner — expanding the menu
                grows it, which pushes this along for free without needing to
                know the menu's width itself. */}
            {page !== null && (
                <div className="flex items-stretch border-l border-border-subtle">
                    <button
                        type="button"
                        onClick={navigation.closePage}
                        aria-label="Back"
                        className="flex w-8 items-center justify-center text-text-secondary hover:bg-layer-hover-01 hover:text-text-primary"
                    >
                        <ArrowLeft size={16}/>
                    </button>
                    <span className="flex items-center px-2 text-label whitespace-nowrap text-text-primary">
                        {PAGE_TITLES[page]}
                    </span>
                </div>
            )}

            {/* Takes the free space between the menu and the readings, so it
                gives way first when the menu expands. */}
            <TopBarStatus/>

            {/* Anchored right so expanding the menu never pushes the readings. */}
            <div className="ml-auto flex items-stretch">
                <ModeControl
                    vehicleKind={vehicle.vehicleKind}
                    customMode={vehicle.customMode}
                    label={vehicle.mode}
                    stale={stale}
                    staleFor={staleFor}
                    unknown={unknown}
                    severe={severe}
                />
                <ArmControl
                    armed={vehicle.armed}
                    stale={stale}
                    staleFor={staleFor}
                    unknown={unknown}
                    severe={severe}
                />
                <StatusChip
                    label="Prearm"
                    value={vehicle.prearmPass ? "PASS" : "FAIL"}
                    tone={vehicle.prearmPass ? "ok" : "warn"}
                    stale={stale}
                    staleFor={staleFor}
                    unknown={unknown}
                    severe={severe}
                    onClick={() => navigation.openPanel("prearm")}
                />
                <StatusChip
                    label="Batt"
                    value={`${battery.voltage.toFixed(1)}V ${battery.current.toFixed(1)}A ${Math.round(battery.consumed)}mAh ${Math.round(battery.percent)}%`}
                    compactValue={`${Math.round(battery.percent)}%`}
                    compact={compact}
                    tone={batteryTone}
                    stale={stale}
                    staleFor={staleFor}
                    unknown={unknown}
                    severe={severe}
                    onClick={() => navigation.openPanel("telemetry")}
                />
                <StatusChip
                    label="GPS"
                    value={`${fixLabel(vehicle.gps.fix)} ${vehicle.gps.satellites} sats ${vehicle.gps.hdop.toFixed(1)}`}
                    compactValue={`${fixLabel(vehicle.gps.fix)} ${vehicle.gps.satellites}`}
                    compact={compact}
                    tone={gpsTone}
                    stale={stale}
                    staleFor={staleFor}
                    unknown={unknown}
                    severe={severe}
                    onClick={() => navigation.openPanel("telemetry")}
                />
                <StatusChip
                    label="Link"
                    value={`${vehicle.link.rssi} · ${vehicle.link.lossPercent.toFixed(1)}%`}
                    compactValue={`${vehicle.link.rssi}`}
                    compact={compact}
                    tone={linkTone}
                    stale={stale}
                    staleFor={staleFor}
                    unknown={unknown}
                    severe={severe}
                />
                <StatusChip
                    label="Vibe"
                    value={`${Math.round(vehicle.ekf.vibe)} ${vehicle.ekf.ok ? "EKF OK" : "EKF BAD"}`}
                    compactValue={`${Math.round(vehicle.ekf.vibe)}`}
                    compact={compact}
                    tone={vehicle.ekf.ok ? "ok" : "danger"}
                    stale={stale}
                    staleFor={staleFor}
                    unknown={unknown}
                    severe={severe}
                />
                {/* Last on the strip: when the link drops every reading to its
                    left goes stale at once, so the remedy sits beside the
                    symptom rather than across the window. */}
                <ConnectControl
                    connection={connection}
                    armed={vehicle.armed}
                    confirmDisconnectWhenArmed={settings.confirmDisconnectWhenArmed}
                />
            </div>
        </header>
    );
}
