import {useEffect, useMemo, useRef, useState} from "react";
import {ArrowLeft} from "@carbon/icons-react";
import AppMenu, {Menu} from "./AppMenu";
import StatusChip, {Tone} from "./StatusChip";
import ConnectControl from "./ConnectControl";
import {useNow} from "../vehicle/useMockVehicle";
import {alertLevel, fixLabel, VehicleState, worst} from "../vehicle/vehicle";
import {isLinkFailing, isLinkIdle, linkSeverity} from "../vehicle/connection";
import {PANEL_DEFINITIONS} from "../workspace/panels";
import {useConnection} from "../vehicle/useConnection";
import {SettingsApi} from "../settings/useSettings";
import {useNavigation} from "../navigation/useNavigation";
import {PAGE_TITLES, PageId} from "../navigation/navigation";
import {AIRSPACE_CLASSES} from "../airspace/airspace";
import type {AirspaceState} from "../airspace/useAirspace";
import type {MissionApi} from "../mission/useMission";

interface TopBarProps {
    vehicle: VehicleState;
    settings: SettingsApi;
    openIds: Set<string>;
    /** `null` for the workspace; otherwise the full-screen page currently
     * open, so its back control and title can live in this one strip
     * instead of a second bar underneath it. */
    page: PageId | null;
    airspace: AirspaceState;
    mission: MissionApi;
}

export default function TopBar({vehicle, settings, openIds, page, airspace, mission}: TopBarProps) {
    const now = useNow();

    // The backend owns the link state machine; this only reflects it.
    const connection = useConnection();
    // Reachable the same way from a panel's own content or a page's own
    // content — this is just the top bar's turn to use it.
    const navigation = useNavigation();

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
                    {label: "Connect…"},
                    {label: "Parameters", action: () => navigation.openPage("parameters")},
                    {label: "Firmware"},
                    {label: "Calibration"},
                ],
            },
            {
                label: "Mission",
                items: [
                    {label: "Edit Mission…", action: () => navigation.openPage("mission")},
                    {label: "Load…"},
                    {label: "Save As…"},
                    {
                        label: "Upload to Vehicle",
                        action: () => void mission.upload().catch(() => {}),
                        disabled: mission.waypoints.length === 0 || mission.uploading,
                    },
                    {label: "Download"},
                ],
            },
            {label: "Logs", items: [{label: "Download Logs"}, {label: "Analyse…"}]},
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
                    ...AIRSPACE_CLASSES.map((definition, index) => ({
                        label: airspace.unavailable.has(definition.id)
                            // Class E is generated locally rather than
                            // committed, so on a fresh clone the file is simply
                            // absent. Say so, instead of offering a toggle that
                            // silently does nothing.
                            ? `${definition.label} — not built`
                            : airspace.pending.has(definition.id)
                                ? `${definition.label} — loading…`
                                : definition.label,
                        checked: airspace.classes[definition.id].visible,
                        disabled: airspace.unavailable.has(definition.id),
                        separatorBefore: index === 0,
                        action: () => airspace.toggle(definition.id),
                    })),
                    {label: "Reset Workspace", separatorBefore: true},
                ],
            },
            {
                label: "Help",
                items: [
                    {label: "Documentation"},
                    {label: "About"},
                    {label: "Preferences…", separatorBefore: true, action: () => navigation.openPage("settings")},
                ],
            },
        ],
        [openIds, navigation, airspace, mission],
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

            {/* Anchored right so expanding the menu never pushes the readings. */}
            <div className="ml-auto flex items-stretch">
                <StatusChip
                    label="Mode"
                    value={vehicle.mode}
                    tone="info"
                    stale={stale}
                    staleFor={staleFor}
                    unknown={unknown}
                    severe={severe}
                />
                <StatusChip
                    label="State"
                    value={vehicle.armed ? "ARMED" : "DISARMED"}
                    tone={vehicle.armed ? "danger" : "neutral"}
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
                    onClick={() => navigation.openPanel("console")}
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
