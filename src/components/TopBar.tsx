import {useEffect, useMemo, useRef, useState} from "react";
import AppMenu, {Menu} from "./AppMenu";
import StatusChip, {Tone} from "./StatusChip";
import {useMockVehicle, useNow} from "../vehicle/useMockVehicle";
import {alertLevel, fixLabel, isStale} from "../vehicle/vehicle";
import {PANEL_DEFINITIONS} from "../workspace/panels";
import {WorkspaceActions} from "../workspace/useWorkspace";

interface TopBarProps {
    openIds: Set<string>;
    actions: WorkspaceActions;
}

export default function TopBar({openIds, actions}: TopBarProps) {
    const vehicle = useMockVehicle();
    const now = useNow();
    const [menuExpanded, setMenuExpanded] = useState(false);

    const level = alertLevel(vehicle, now);
    const stale = isStale(vehicle, now);
    const staleFor = Math.round((now - vehicle.updatedAt) / 1000);

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

    const menus = useMemo<Menu[]>(
        () => [
            {
                label: "Vehicle",
                items: [
                    {label: "Connect…"},
                    {label: "Parameters"},
                    {label: "Firmware"},
                    {label: "Calibration"},
                ],
            },
            {
                label: "Mission",
                items: [
                    {label: "Load…"},
                    {label: "Save As…"},
                    {label: "Upload to Vehicle"},
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
                            openIds.has(panel.id) ? actions.close(panel.id) : actions.open(panel.id),
                    })),
                    {label: "Reset Workspace", separatorBefore: true},
                ],
            },
            {label: "Help", items: [{label: "Documentation"}, {label: "About"}]},
        ],
        [openIds, actions],
    );

    const compact = menuExpanded;
    const battery = vehicle.battery;

    const batteryTone: Tone = battery.percent <= 15 ? "danger" : battery.percent <= 25 ? "warn" : "ok";
    const gpsTone: Tone =
        vehicle.gps.fix === "none" ? "danger" : vehicle.gps.fix === "2d" ? "warn" : "ok";
    const linkTone: Tone = vehicle.link.lossPercent > 5 ? "warn" : "ok";

    return (
        <header className="flex h-control-sm shrink-0 items-stretch border-b border-border-subtle bg-layer-01 text-text-primary">
            <AppMenu menus={menus} expanded={menuExpanded} onExpandedChange={setMenuExpanded}/>

            {/* Anchored right so expanding the menu never pushes the readings. */}
            <div className="ml-auto flex items-stretch">
                <StatusChip label="Mode" value={vehicle.mode} tone="info" stale={stale} staleFor={staleFor}/>
                <StatusChip
                    label="State"
                    value={vehicle.armed ? "ARMED" : "DISARMED"}
                    tone={vehicle.armed ? "danger" : "neutral"}
                    stale={stale}
                    staleFor={staleFor}
                />
                <StatusChip
                    label="Prearm"
                    value={vehicle.prearmPass ? "PASS" : "FAIL"}
                    tone={vehicle.prearmPass ? "ok" : "warn"}
                    stale={stale}
                    staleFor={staleFor}
                    onClick={() => actions.open("console")}
                />
                <StatusChip
                    label="Batt"
                    value={`${battery.voltage.toFixed(1)}V ${battery.current.toFixed(1)}A ${Math.round(battery.consumed)}mAh ${Math.round(battery.percent)}%`}
                    compactValue={`${Math.round(battery.percent)}%`}
                    compact={compact}
                    tone={batteryTone}
                    stale={stale}
                    staleFor={staleFor}
                    onClick={() => actions.open("telemetry")}
                />
                <StatusChip
                    label="GPS"
                    value={`${fixLabel(vehicle.gps.fix)} ${vehicle.gps.satellites} sats ${vehicle.gps.hdop.toFixed(1)}`}
                    compactValue={`${fixLabel(vehicle.gps.fix)} ${vehicle.gps.satellites}`}
                    compact={compact}
                    tone={gpsTone}
                    stale={stale}
                    staleFor={staleFor}
                    onClick={() => actions.open("telemetry")}
                />
                <StatusChip
                    label="Link"
                    value={`${vehicle.link.rssi} · ${vehicle.link.lossPercent.toFixed(1)}%`}
                    compactValue={`${vehicle.link.rssi}`}
                    compact={compact}
                    tone={linkTone}
                    stale={stale}
                    staleFor={staleFor}
                />
                <StatusChip
                    label="Vibe"
                    value={`${Math.round(vehicle.ekf.vibe)} ${vehicle.ekf.ok ? "EKF OK" : "EKF BAD"}`}
                    compactValue={`${Math.round(vehicle.ekf.vibe)}`}
                    compact={compact}
                    tone={vehicle.ekf.ok ? "ok" : "danger"}
                    stale={stale}
                    staleFor={staleFor}
                />
            </div>
        </header>
    );
}
