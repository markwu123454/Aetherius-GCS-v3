import {useMemo, useState} from "react";
import {Warning} from "@carbon/icons-react";
import {LiveParamEntry} from "@/lib/params/liveParams.ts";
import {useParamSheet} from "@/lib/params/useParamSheet.ts";
import {ParamDef, VehicleFirmware} from "@/lib/params/paramSheet.ts";
import {sendVehicleCommand, stopAllMotorTests} from "@/lib/vehicle/commands.ts";

interface MotorTestPanelProps {
    live: Map<string, LiveParamEntry>;
    firmware: VehicleFirmware;
    armed: boolean;
}

const THROTTLE_RANGE: [number, number] = [0, 100];
const TIMEOUT_RANGE: [number, number] = [0.5, 10];

interface DiscoveredMotor {
    motor: number;
    channel: number;
}

function findParam(groups: {params: ParamDef[]}[], name: string): ParamDef | null {
    for (const group of groups) {
        const found = group.params.find((p) => p.name === name);
        if (found) return found;
    }
    return null;
}

/**
 * Which `SERVOx_FUNCTION` values mean "this channel drives motor N" — read
 * off the connected firmware's own `SERVO1_FUNCTION` option list (every
 * servo function param shares the same enum) rather than a hardcoded value
 * table, since `MotorN`'s underlying int isn't contiguous across the whole
 * range ArduPilot supports. `motor` is AP_Motors' own numbering — the same
 * number a frame diagram or `MotorN` label uses, not the servo channel it
 * happens to be wired to.
 */
function motorFunctionValues(functionParam: ParamDef | null): Map<number, number> {
    const map = new Map<number, number>();
    for (const option of functionParam?.values ?? []) {
        const match = /^Motor(\d+)$/.exec(option.label);
        if (match) {
            map.set(option.value, Number(match[1]));
        }
    }
    return map;
}

/** Scans every `SERVOx_FUNCTION` the vehicle has actually reported for one
 * assigned to a `MotorN` function, and returns the motors found, sorted by
 * AP_Motors' motor number — i.e. exactly the motors Frame Setup wired up,
 * not a class-implied count that could be wrong for a scripted mixer. */
function discoverMotors(live: Map<string, LiveParamEntry>, functionValues: Map<number, number>): DiscoveredMotor[] {
    if (functionValues.size === 0) {
        return [];
    }
    const found: DiscoveredMotor[] = [];
    for (const [name, entry] of live) {
        const match = /^SERVO(\d+)_FUNCTION$/.exec(name);
        if (!match) continue;
        const motor = functionValues.get(Math.round(entry.value));
        if (motor !== undefined) {
            found.push({motor, channel: Number(match[1])});
        }
    }
    return found.sort((a, b) => a.motor - b.motor);
}

type RowStatus = {state: "idle"} | {state: "testing"} | {state: "error"; message: string};

interface MotorRowProps {
    motor: DiscoveredMotor;
    disabled: boolean;
    throttlePercent: number;
    timeoutSecs: number;
    status: RowStatus;
    onTest: () => void;
}

function MotorRow({motor, disabled, throttlePercent, timeoutSecs, status, onTest}: MotorRowProps) {
    return (
        <div className="grid grid-cols-[6rem_8rem_auto_1fr] items-center gap-3 border-b border-border-subtle-base px-2 py-1.5">
            <span className="text-label text-text-primary">Motor {motor.motor}</span>
            <span className="font-mono text-label text-text-helper">SERVO{motor.channel}</span>
            <button
                type="button"
                disabled={disabled || status.state === "testing"}
                onClick={onTest}
                className="h-control-sm w-24 border border-border-subtle text-label text-text-primary hover:enabled:bg-layer-hover-01 disabled:text-text-disabled"
            >
                {status.state === "testing" ? "Testing…" : `Test @ ${throttlePercent}%`}
            </button>
            {status.state === "error" && <span className="text-label text-state-danger">{status.message}</span>}
            {status.state === "testing" && (
                <span className="text-label text-text-helper">Running for {timeoutSecs}s…</span>
            )}
        </div>
    );
}

/**
 * Spins one motor at a time via `MAV_CMD_DO_MOTOR_TEST` — for confirming
 * each output is wired to the motor Frame Setup thinks it is (and spinning
 * the direction ArduPilot expects) before ever arming for real flight.
 * Motors are discovered from live `SERVOx_FUNCTION` assignments rather than
 * `FRAME_CLASS`'s nominal count, so the numbering here always matches
 * whatever the vehicle actually has wired, including a scripted mixer with a
 * non-standard layout.
 *
 * Gated behind two independent things, neither of which the other
 * substitutes for: disarmed (checked continuously against live telemetry —
 * arming mid-session re-locks the panel immediately), and a one-time-per-visit
 * "propellers are off" acknowledgment (deliberately not persisted past a
 * remount, the same reasoning `ParamValueInput` never remembers a prior
 * confirmation — a new visit to this page is exactly when re-confirming
 * matters most).
 */
export default function MotorTestPanel({live, firmware, armed}: MotorTestPanelProps) {
    const sheetState = useParamSheet(firmware);
    const [propsConfirmed, setPropsConfirmed] = useState(false);
    const [throttlePercent, setThrottlePercent] = useState(8);
    const [timeoutSecs, setTimeoutSecs] = useState(2);
    const [statuses, setStatuses] = useState<Map<number, RowStatus>>(new Map());
    const [stopping, setStopping] = useState(false);
    const [stopError, setStopError] = useState<string | null>(null);

    const functionParam = sheetState.status === "ready" ? findParam(sheetState.sheet.groups, "SERVO1_FUNCTION") : null;
    const functionValues = useMemo(() => motorFunctionValues(functionParam), [functionParam]);
    const motors = useMemo(() => discoverMotors(live, functionValues), [live, functionValues]);

    const unlocked = !armed && propsConfirmed;
    const hasRejection = [...statuses.values()].some(
        (status) => status.state === "error" && status.message.includes("MAV_RESULT_FAILED"),
    );

    const setStatus = (motor: number, status: RowStatus) => {
        setStatuses((prev) => {
            const next = new Map(prev);
            next.set(motor, status);
            return next;
        });
    };

    const runTest = async (motor: number, percent: number, seconds: number) => {
        setStatus(motor, {state: "testing"});
        try {
            await sendVehicleCommand({type: "motorTest", motor, throttlePercent: percent, timeoutSecs: seconds});
            // The vehicle stops the motor on its own once `seconds` elapses —
            // this just clears the row back to idle so "Test" is clickable
            // again, not a separate stop command.
            window.setTimeout(() => setStatus(motor, {state: "idle"}), seconds * 1000);
        } catch (error) {
            setStatus(motor, {state: "error", message: error instanceof Error ? error.message : String(error)});
        }
    };

    // Fire-and-forget, not `runTest` looped over every motor: the backend's
    // ack-tracking only holds one pending sender per *command type*, so
    // several concurrently in-flight `motorTest` calls (one per motor) would
    // clobber each other's slot and fail instantly with a misleading
    // timeout — see `stop_all_motor_tests`'s doc on the Rust side. An
    // emergency stop shouldn't wait on an ack anyway.
    const handleStopAll = async () => {
        setStopping(true);
        setStopError(null);
        try {
            await stopAllMotorTests(motors.map((m) => m.motor));
            setStatuses(new Map());
        } catch (error) {
            setStopError(error instanceof Error ? error.message : String(error));
        } finally {
            setStopping(false);
        }
    };

    return (
        <div className="flex w-full flex-col gap-4">
            <h1 className="text-heading text-text-primary">Motor Test</h1>

            {armed && (
                <div className="flex items-start gap-2 border border-state-danger/40 bg-layer-01 px-3 py-2 text-label text-state-danger">
                    <Warning size={16} className="mt-px shrink-0" />
                    <span>Disarm the vehicle to test motors.</span>
                </div>
            )}

            <label className="flex w-fit cursor-pointer items-center gap-2 text-label text-state-warn select-none">
                <input
                    type="checkbox"
                    checked={propsConfirmed}
                    disabled={armed}
                    onChange={(event) => setPropsConfirmed(event.target.checked)}
                />
                Propellers are removed and the vehicle is secured
            </label>

            {sheetState.status === "loading" && (
                <p className="text-label text-text-helper">Loading {firmware} parameter reference…</p>
            )}
            {sheetState.status === "error" && <p className="text-label text-state-danger">{sheetState.message}</p>}

            <div className="flex items-end gap-4">
                <label className="flex flex-col gap-1 text-label text-text-helper">
                    Throttle
                    <input
                        type="number"
                        value={throttlePercent}
                        min={THROTTLE_RANGE[0]}
                        max={THROTTLE_RANGE[1]}
                        step={1}
                        disabled={!unlocked}
                        onChange={(event) => setThrottlePercent(Number(event.target.value))}
                        className="h-control-sm w-20 border border-border-subtle bg-background px-2 font-mono text-body text-text-primary focus-visible:outline-none disabled:text-text-disabled"
                    />
                    %
                </label>
                <label className="flex flex-col gap-1 text-label text-text-helper">
                    Duration
                    <input
                        type="number"
                        value={timeoutSecs}
                        min={TIMEOUT_RANGE[0]}
                        max={TIMEOUT_RANGE[1]}
                        step={0.5}
                        disabled={!unlocked}
                        onChange={(event) => setTimeoutSecs(Number(event.target.value))}
                        className="h-control-sm w-20 border border-border-subtle bg-background px-2 font-mono text-body text-text-primary focus-visible:outline-none disabled:text-text-disabled"
                    />
                    s
                </label>
                <button
                    type="button"
                    disabled={!unlocked || motors.length === 0 || stopping}
                    onClick={() => void handleStopAll()}
                    className="h-control-sm border border-state-danger px-3 text-label text-state-danger hover:enabled:bg-state-danger/10 disabled:border-border-subtle disabled:text-text-disabled"
                >
                    {stopping ? "Stopping…" : "Stop All Motors"}
                </button>
                {stopError && <span className="text-label text-state-danger">{stopError}</span>}
            </div>

            {hasRejection && (
                <p className="text-label text-text-helper">
                    The vehicle refused the test — check the safety switch, and that Frame Setup is done and the
                    vehicle rebooted.
                </p>
            )}

            {motors.length === 0 ? (
                <p className="text-label text-text-helper">
                    No motor outputs found yet — assign SERVOx_FUNCTION to Motor1..N in Frame Setup, or wait for
                    parameters to finish reading.
                </p>
            ) : (
                <div className="border-t border-border-subtle">
                    {motors.map((motor) => (
                        <MotorRow
                            key={motor.motor}
                            motor={motor}
                            disabled={!unlocked}
                            throttlePercent={throttlePercent}
                            timeoutSecs={timeoutSecs}
                            status={statuses.get(motor.motor) ?? {state: "idle"}}
                            onTest={() => void runTest(motor.motor, throttlePercent, timeoutSecs)}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
