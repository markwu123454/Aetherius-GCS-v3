import {useMemo, useState} from "react";
import {useRcChannels} from "@/lib/calibration/useRcChannels.ts";
import {RC_CHANNEL_UNUSED} from "@/lib/calibration/rcChannels.ts";
import {ChannelCalInfo, useRadioCalibration, StickFunction} from "@/lib/calibration/useRadioCalibration.ts";
import {LiveParamEntry} from "@/lib/params/liveParams.ts";
import {VehicleKind} from "@/lib/vehicle/vehicle.ts";
import RadioStickDiagram, {RadioMode} from "./viewport/RadioStickDiagram.tsx";

interface RadioCalibrationPanelProps {
    live: Map<string, LiveParamEntry>;
    vehicleKind: VehicleKind | null;
}

/** ArduPilot's own un-calibrated firmware defaults — used only as the
 * fallback range for a bar's fill when nothing else is known, never
 * written anywhere. */
const DEFAULT_MIN = 1000;
const DEFAULT_MAX = 2000;

interface RangeInfo {
    min: number;
    max: number;
    trim: number;
    /** Whether this is what the current wizard session has captured, or
     * what's already saved on the vehicle from a previous calibration. */
    source: "session" | "saved";
}

/**
 * The range to show for one channel: whatever the in-progress wizard has
 * captured takes priority (that's the point of running it), otherwise the
 * `RCx_MIN/MAX/TRIM` already on the vehicle — read from the same live
 * parameter map the Parameters page uses, so this updates on its own the
 * moment Save actually writes new values back, with no extra plumbing.
 */
function channelRangeInfo(
    index: number,
    results: Map<number, ChannelCalInfo>,
    live: Map<string, LiveParamEntry>,
): RangeInfo | null {
    const captured = results.get(index);
    if (captured) {
        return {min: captured.min, max: captured.max, trim: captured.trim, source: "session"};
    }
    const channel = index + 1;
    const min = live.get(`RC${channel}_MIN`)?.value;
    const max = live.get(`RC${channel}_MAX`)?.value;
    const trim = live.get(`RC${channel}_TRIM`)?.value;
    if (min === undefined || max === undefined || trim === undefined) {
        return null;
    }
    return {min, max, trim, source: "saved"};
}

function percentOf(value: number | undefined, min: number, max: number): number | null {
    if (value === undefined || value === RC_CHANNEL_UNUSED || max <= min) {
        return null;
    }
    return Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
}

function LiveBar({percent}: {percent: number | null}) {
    return (
        <div className="relative h-2 w-full shrink-0 bg-layer-02">
            {percent !== null && (
                <div
                    className="absolute top-1/2 h-3 w-1 bg-state-info"
                    style={{left: `${percent}%`, transform: "translate(-50%, -50%)"}}
                />
            )}
        </div>
    );
}

/** Live value on one line, the min/max/trim behind it on the next — session
 * values in the state-info tone so a just-captured range visibly differs
 * from one merely read back from the vehicle. `value` is `undefined` when no
 * RC data has arrived at all, distinct from the vehicle's own "unused"
 * sentinel for a channel it isn't receiving. */
function ChannelReadout({value, info}: {value: number | undefined; info: RangeInfo | null}) {
    return (
        <div className="flex min-w-0 flex-1 flex-col">
            <span className="font-mono text-micro text-text-primary">
                {value === undefined ? "no data" : value === RC_CHANNEL_UNUSED ? "unused" : value}
            </span>
            <span className={`font-mono text-micro ${info?.source === "session" ? "text-state-info" : "text-text-helper"}`}>
                {info ? `${info.min}–${info.max} · trim ${info.trim}` : "—"}
            </span>
        </div>
    );
}

const RCMAP_PARAM: Record<StickFunction, string> = {
    roll: "RCMAP_ROLL",
    pitch: "RCMAP_PITCH",
    throttle: "RCMAP_THROTTLE",
    yaw: "RCMAP_YAW",
};
const FUNCTION_ORDER: StickFunction[] = ["roll", "pitch", "throttle", "yaw"];
const FUNCTION_LABEL: Record<StickFunction, string> = {
    roll: "Roll",
    pitch: "Pitch",
    throttle: "Throttle",
    yaw: "Yaw",
};

/**
 * Radio calibration — see `useRadioCalibration` for the actual protocol,
 * re-implemented from QGroundControl's own `RemoteControlCalibrationController`
 * rather than assuming ArduPilot needs a vehicle-side calibration mode (it
 * doesn't; that was tried first and rejected with `MAV_RESULT_UNSUPPORTED`).
 *
 * Laid out as two columns: the wizard — stick diagram, the four primary
 * channels, instructions, controls — as a fixed-width column on the left,
 * the full live channel monitor on the right, so both stay visible together
 * on a wide display instead of requiring a scroll between them. The monitor
 * works with no calibration active at all, same as QGC's Radio Setup screen
 * before Calibrate is ever pressed.
 *
 * QGC additionally offers aux-channel function assignment, Modes 3/4,
 * Spektrum bind, and trim copy — all left out of this pass.
 */
export default function RadioCalibrationPanel({live, vehicleKind}: RadioCalibrationPanelProps) {
    const channels = useRcChannels();
    const calibration = useRadioCalibration(channels, vehicleKind, live);
    const [mode, setMode] = useState<RadioMode>(2);

    // Which channel is currently Roll/Pitch/Throttle/Yaw. While calibrating,
    // what the wizard has identified so far takes priority over the
    // vehicle's existing `RCMAP_*` — that's the whole point of identifying
    // it fresh rather than trusting stale config.
    const attitudeChannels = useMemo(
        () =>
            FUNCTION_ORDER.map((fn) => {
                const claimed = [...calibration.results.entries()].find(([, info]) => info.function === fn);
                if (claimed) {
                    return {function: fn, channelIndex: claimed[0]};
                }
                const mapped = live.get(RCMAP_PARAM[fn])?.value;
                return {function: fn, channelIndex: mapped !== undefined ? Math.round(mapped) - 1 : null};
            }),
        [calibration.results, live],
    );

    const currentStep = calibration.step;
    // The "neutral" step doesn't carry a `direction` — it isn't identifying
    // one axis, it's the instruction to rest everything except Throttle,
    // which it asks to be lowered instead. The diagram should show that
    // asymmetry rather than showing every stick centered while the text
    // says otherwise.
    const diagramDirection =
        currentStep?.id === "neutral"
            ? {function: "throttle" as const, axis: "vertical" as const, sign: -1 as const}
            : currentStep && currentStep.direction && currentStep.function
              ? {function: currentStep.function, ...currentStep.direction}
              : null;

    return (
        <div className="flex w-full flex-col gap-6">
            <div>
                <h2 className="text-heading text-text-primary">Radio</h2>
                <p className="text-body text-text-secondary">
                    Records each RC channel's min/max/trim so stick input maps correctly. Reference:{" "}
                    <a
                        href="https://ardupilot.org/copter/docs/common-radio-control-calibration.html"
                        target="_blank"
                        rel="noreferrer"
                        className="text-state-info underline"
                    >
                        ArduPilot's Radio Calibration docs
                    </a>
                    .
                </p>
            </div>

            {!channels && (
                <p className="text-label text-state-danger">RC not connected — no channel data received from the vehicle.</p>
            )}

            <div className="flex flex-wrap gap-8">
                <div className="flex min-w-[300px] flex-1 flex-col gap-4 border-r border-border-subtle pr-8">
                    <section className="flex flex-col gap-2">
                        <h3 className="text-label text-text-helper uppercase">Attitude Controls</h3>
                        {attitudeChannels.map((fn) => {
                            const info = fn.channelIndex !== null ? channelRangeInfo(fn.channelIndex, calibration.results, live) : null;
                            const raw = channels && fn.channelIndex !== null ? channels[fn.channelIndex] : undefined;
                            return (
                                <div key={fn.function} className="flex items-center gap-3">
                                    <span className="w-16 shrink-0 text-label text-text-secondary">
                                        {FUNCTION_LABEL[fn.function]}
                                    </span>
                                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                                        <LiveBar percent={fn.channelIndex === null ? null : percentOf(raw, info?.min ?? DEFAULT_MIN, info?.max ?? DEFAULT_MAX)}/>
                                        {fn.channelIndex === null ? (
                                            <span className="font-mono text-micro text-text-helper">unmapped</span>
                                        ) : (
                                            <ChannelReadout value={raw} info={info}/>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </section>

                    <div className="flex flex-col gap-3 border-t border-border-subtle pt-4">
                        {!calibration.calibrating && (
                            <button
                                type="button"
                                disabled={!channels}
                                onClick={calibration.start}
                                className="h-control-sm w-fit border border-border-subtle px-3 text-label text-text-primary hover:enabled:bg-layer-hover-01 disabled:text-text-disabled"
                            >
                                Calibrate
                            </button>
                        )}

                        {calibration.calibrating && currentStep && (
                            <>
                                <div className="flex items-start justify-center gap-6 py-2">
                                    <RadioStickDiagram mode={mode} direction={diagramDirection}/>
                                </div>

                                <div className="flex items-center gap-1 text-micro">
                                    <span className="text-text-helper">Transmitter Mode</span>
                                    {([1, 2] as const).map((m) => (
                                        <button
                                            key={m}
                                            type="button"
                                            aria-pressed={mode === m}
                                            onClick={() => setMode(m)}
                                            className={[
                                                "border px-1.5 py-0.5",
                                                mode === m
                                                    ? "border-border-strong text-text-primary"
                                                    : "border-transparent text-text-helper hover:text-text-primary",
                                            ].join(" ")}
                                        >
                                            {m}
                                        </button>
                                    ))}
                                </div>

                                <p className="text-label text-state-info">{currentStep.instruction}</p>
                                {calibration.error && <p className="text-label text-state-danger">{calibration.error}</p>}

                                <div className="flex gap-2">
                                    {!currentStep.auto && currentStep.id !== "save" && (
                                        <button
                                            type="button"
                                            onClick={calibration.next}
                                            className="h-control-sm bg-blue-60 px-3 text-label text-text-on-color hover:bg-blue-50"
                                        >
                                            Continue
                                        </button>
                                    )}
                                    {currentStep.id === "save" && (
                                        <button
                                            type="button"
                                            disabled={calibration.saving}
                                            onClick={() => void calibration.save()}
                                            className="h-control-sm bg-blue-60 px-3 text-label text-text-on-color hover:enabled:bg-blue-50 disabled:opacity-50"
                                        >
                                            {calibration.saving ? "Saving…" : "Save"}
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        disabled={calibration.saving}
                                        onClick={calibration.cancel}
                                        className="h-control-sm border border-border-subtle px-3 text-label text-text-secondary hover:enabled:bg-layer-hover-01 disabled:text-text-disabled"
                                    >
                                        Cancel
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                </div>

                <div className="flex w-full max-w-[200px] shrink-0 flex-col gap-2">
                    <h3 className="text-label text-text-helper uppercase">Channel Monitor</h3>
                    {channels ? (
                        <div className="flex flex-col gap-2">
                            {channels.map((value, index) => {
                                const info = channelRangeInfo(index, calibration.results, live);
                                return (
                                    <div key={index} className="flex items-center gap-3">
                                        <span className="w-6 shrink-0 text-label text-text-helper">{index + 1}</span>
                                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                                            <LiveBar percent={percentOf(value, info?.min ?? DEFAULT_MIN, info?.max ?? DEFAULT_MAX)}/>
                                            <ChannelReadout value={value} info={info}/>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <p className="text-label text-text-helper">RC not connected</p>
                    )}
                </div>
            </div>
        </div>
    );
}
