import {useEffect, useMemo, useState} from "react";
import {useConnection} from "@/lib/vehicle/useConnection.ts";
import {useVehicle} from "@/lib/vehicle/useVehicle.ts";
import {useLiveParams} from "@/lib/params/useLiveParams.ts";
import {VehicleFirmware} from "@/lib/params/paramSheet.ts";
import FrameSetupPanel from "./FrameSetupPanel.tsx";
import ServoSetupPanel from "./ServoSetupPanel.tsx";
import TrimSetupPanel from "./TrimSetupPanel.tsx";
import MotorTestPanel from "./MotorTestPanel.tsx";
import MotorsSetupPanel from "./MotorsSetupPanel.tsx";
import FailsafeSetupPanel from "./FailsafeSetupPanel.tsx";

interface SetupItem {
    id: "frame" | "servo" | "motors" | "trim" | "motorTest" | "failsafe";
    label: string;
}

/** Every tab, since with no vehicle there's no vehicle type to narrow them by. */
const OFFLINE_ITEMS: SetupItem[] = [
    {id: "frame", label: "Frame"},
    {id: "servo", label: "Servo"},
    {id: "motors", label: "Motors"},
    {id: "trim", label: "Trim"},
    {id: "motorTest", label: "Motor Test"},
    {id: "failsafe", label: "Failsafe"},
];

function SidebarRow({item, active, disabled = false, onSelect}: {item: SetupItem; active: boolean; disabled?: boolean; onSelect: () => void}) {
    return (
        <button
            type="button"
            aria-current={active}
            disabled={disabled}
            onClick={onSelect}
            className={[
                "px-3 py-2 text-left text-label whitespace-nowrap",
                active
                    ? "bg-background text-text-primary"
                    : "text-text-secondary enabled:hover:bg-layer-hover-01 enabled:hover:text-text-primary disabled:text-text-disabled",
            ].join(" ")}
        >
            {item.label}
        </button>
    );
}

/**
 * Friendly forms over one specific param family — Frame, Servo, Motors,
 * Trim, and Failsafe — distinct from `ParametersPage` (raw access to
 * everything) and `CalibrationPage` (sensor procedures with a live-value
 * wizard). Motor Test is the one tab here that isn't a plain read/set of
 * named params — it sends a live `MAV_CMD_DO_MOTOR_TEST` — but it belongs
 * next to Frame/Servo rather than in `CalibrationPage` since it's verifying
 * the wiring those two tabs configure, not calibrating a sensor.
 *
 * With no vehicle, Frame stays open as a reference (see `FrameSetupPanel`)
 * for wiring a powered-off vehicle; every other tab reads or writes the
 * vehicle itself, so they stay in the list, disabled, until it's back.
 */
export default function SetupPage() {
    const connection = useConnection();
    const vehicle = useVehicle();
    const connected = connection.status === "connected";
    const live = useLiveParams();

    const items = useMemo<SetupItem[]>(() => {
        const list: SetupItem[] = [];
        if (vehicle.vehicleKind === "multirotor") {
            list.push({id: "frame", label: "Frame"});
        }
        list.push({id: "servo", label: "Servo"});
        list.push({id: "motors", label: "Motors"});
        list.push({id: "trim", label: "Trim"});
        if (vehicle.vehicleKind === "multirotor") {
            list.push({id: "motorTest", label: "Motor Test"});
        }
        list.push({id: "failsafe", label: "Failsafe"});
        return list;
    }, [vehicle.vehicleKind]);

    const [selectedId, setSelectedId] = useState<SetupItem["id"] | null>(null);
    useEffect(() => {
        if (!items.some((item) => item.id === selectedId)) {
            setSelectedId(items[0]?.id ?? null);
        }
    }, [items, selectedId]);

    if (!connected) {
        return (
            <div className="flex h-full w-full">
                <nav className="flex w-48 shrink-0 flex-col border-r border-border-subtle bg-layer-01">
                    {OFFLINE_ITEMS.map((item) => (
                        <SidebarRow
                            key={item.id}
                            item={item}
                            active={item.id === "frame"}
                            disabled={item.id !== "frame"}
                            onSelect={() => {}}
                        />
                    ))}
                </nav>
                <div className="min-h-0 flex-1 overflow-auto p-6">
                    <FrameSetupPanel live={live.values}/>
                </div>
            </div>
        );
    }

    const firmware: VehicleFirmware = vehicle.vehicleKind === "plane" ? "ArduPlane" : "ArduCopter";

    return (
        <div className="flex h-full w-full">
            <nav className="flex w-48 shrink-0 flex-col border-r border-border-subtle bg-layer-01">
                {items.map((item) => (
                    <SidebarRow
                        key={item.id}
                        item={item}
                        active={item.id === selectedId}
                        onSelect={() => setSelectedId(item.id)}
                    />
                ))}
            </nav>
            <div className="min-h-0 flex-1 overflow-auto p-6">
                {selectedId === "frame" ? (
                    <FrameSetupPanel live={live.values} onSet={live.setParam}/>
                ) : selectedId === "servo" ? (
                    <ServoSetupPanel live={live.values} onSet={live.setParam} firmware={firmware} onOpenMotors={() => setSelectedId("motors")}/>
                ) : selectedId === "motors" ? (
                    <MotorsSetupPanel live={live.values} onSet={live.setParam} firmware={firmware}/>
                ) : selectedId === "trim" ? (
                    <TrimSetupPanel live={live.values} onSet={live.setParam} firmware={firmware}/>
                ) : selectedId === "motorTest" ? (
                    <MotorTestPanel live={live.values} firmware={firmware} armed={vehicle.armed}/>
                ) : selectedId === "failsafe" ? (
                    <FailsafeSetupPanel live={live.values} onSet={live.setParam} firmware={firmware}/>
                ) : null}
            </div>
        </div>
    );
}
