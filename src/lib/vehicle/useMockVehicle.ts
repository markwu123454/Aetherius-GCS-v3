import {useEffect, useState} from "react";
import {PREARM_CADENCE, PrearmReason, VehicleState} from "./vehicle.ts";

const TICK = 500;

const INITIAL_REASONS = ["PreArm: Compass not calibrated", "PreArm: GPS horizontal speed error"];

function initial(): VehicleState {
    const now = Date.now();
    return {
        connected: true,
        armed: false,
        mode: "LOITER",
        position: null,
        attitude: {roll: 0, pitch: 0},
        groundspeed: 5.2,
        vehicleKind: "multirotor",
        prearmPass: false,
        prearmReasons: INITIAL_REASONS.map((text) => ({text, lastSeen: now})),
        disabledChecks: ["Board voltage"],
        battery: {voltage: 16.4, current: 2.1, consumed: 320, percent: 82},
        gps: {fix: "3d", satellites: 17, hdop: 0.8},
        link: {rssi: 148, lossPercent: 0.4},
        ekf: {ok: true, vibe: 12},
        updatedAt: now,
    };
}

function drift(value: number, amount: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value + (Math.random() - 0.5) * amount));
}

/**
 * Stand-in for the MAVLink link so the status strip can be built and reviewed
 * before any of the transport exists. Values drift the way real telemetry does
 * rather than sitting still, which is what makes the tabular-numeral and
 * staleness treatments worth checking.
 */
export function useMockVehicle(): VehicleState {
    const [state, setState] = useState<VehicleState>(initial);

    useEffect(() => {
        const timer = window.setInterval(() => {
            setState((current) => {
                const now = Date.now();

                // Reasons are re-emitted wholesale on the vehicle's cadence,
                // exactly as ArduPilot does — never incrementally.
                const dueForResend = now - (current.prearmReasons[0]?.lastSeen ?? 0) >= PREARM_CADENCE;
                const prearmReasons: PrearmReason[] =
                    !current.prearmPass && dueForResend
                        ? current.prearmReasons.map((reason) => ({...reason, lastSeen: now}))
                        : current.prearmReasons;

                const consumed = current.battery.consumed + current.battery.current * (TICK / 3_600_000) * 1000;

                return {
                    ...current,
                    prearmReasons,
                    battery: {
                        voltage: drift(current.battery.voltage, 0.05, 14.8, 16.8),
                        current: drift(current.battery.current, 0.4, 0.8, 24),
                        consumed,
                        percent: Math.max(0, 82 - consumed / 60),
                    },
                    gps: {
                        ...current.gps,
                        satellites: Math.round(drift(current.gps.satellites, 0.6, 12, 21)),
                        hdop: drift(current.gps.hdop, 0.05, 0.5, 2.4),
                    },
                    link: {
                        rssi: Math.round(drift(current.link.rssi, 4, 90, 160)),
                        lossPercent: drift(current.link.lossPercent, 0.3, 0, 3),
                    },
                    ekf: {...current.ekf, vibe: drift(current.ekf.vibe, 1.5, 5, 34)},
                    updatedAt: now,
                };
            });
        }, TICK);

        return () => window.clearInterval(timer);
    }, []);

    return state;
}

/** Re-renders once a second so staleness is judged against a moving clock. */
export function useNow(interval = 1_000): number {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), interval);
        return () => window.clearInterval(timer);
    }, [interval]);

    return now;
}
