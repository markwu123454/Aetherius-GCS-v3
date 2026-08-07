import {VehicleState} from "@/lib/vehicle/vehicle.ts";
import {ConnectionStatus} from "@/lib/vehicle/connection.ts";
import {CheckCondition} from "./types.ts";

const GPS_FIX_RANK: Record<string, number> = {
    none: 0,
    "2d": 2,
    "3d": 3,
    dgps: 4,
    "rtk-float": 5,
    "rtk-fixed": 6,
};

export function evaluateCondition(
    condition: CheckCondition,
    vehicle: VehicleState,
    connectionStatus: ConnectionStatus,
): boolean {
    switch (condition.type) {
        case "connected":
            return connectionStatus === "connected";
        case "disconnected":
            return connectionStatus === "disconnected" || connectionStatus === "lost" || connectionStatus === "error";
        case "armed":
            return vehicle.armed;
        case "disarmed":
            return !vehicle.armed;
        case "mode":
            return vehicle.mode === condition.value;
        case "gps_fix_min":
            return (GPS_FIX_RANK[vehicle.gps.fix] ?? 0) >= condition.value;
        case "battery_above":
            return vehicle.battery.percent > condition.value;
        case "battery_below":
            return vehicle.battery.percent < condition.value;
        case "prearm_pass":
            return vehicle.prearmPass;
        case "vehicle_kind":
            return vehicle.vehicleKind === condition.value;
        default:
            return false;
    }
}

export function conditionLabel(condition: CheckCondition): string {
    switch (condition.type) {
        case "connected":       return "auto-check: connected";
        case "disconnected":    return "auto-uncheck: disconnected";
        case "armed":           return "auto-check: armed";
        case "disarmed":        return "auto-check: disarmed";
        case "mode":            return `auto-check: mode = ${condition.value}`;
        case "gps_fix_min":     return `auto-check: GPS fix ≥ ${condition.value}`;
        case "battery_above":   return `auto-check: battery > ${condition.value}%`;
        case "battery_below":   return `auto-check: battery < ${condition.value}%`;
        case "prearm_pass":     return "auto-check: prearm pass";
        case "vehicle_kind":    return `auto-check: vehicle = ${condition.value}`;
        default:                return "auto condition";
    }
}
