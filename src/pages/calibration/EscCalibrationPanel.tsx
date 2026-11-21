import {useEffect, useState, type ReactNode} from "react";
import type {LiveParamEntry} from "@/lib/params/liveParams.ts";
import {CONSOLE_LEVEL_CLASSES, levelFromSeverity} from "@/lib/console/console.ts";
import {isDshotType} from "@/lib/params/motorOutputs.ts";
import {
    beginEscCalibration,
    confirmEscStep,
    ESC_CALIBRATION_VALUE,
    escModeFromParam,
    resetEscCalibration,
    useEscCalibration,
    type EscMode,
    type EscPhase,
} from "@/lib/calibration/escCalibration.ts";

/** `MOT_PWM_TYPE` 3. */
const PWM_TYPE_BRUSHED = 3;

type StepState = "pending" | "active" | "done";

/** Where each guide step sits in the procedure, for deriving its state from
 * the current phase. `idle` covers both steps that happen before the
 * calibration flag is set. */
const PHASE_ORDER: EscPhase[] = [
    "idle",
    "powerOff",
    "stickHigh",
    "battery",
    "safety",
    "tones",
    "powerCycle",
    "finished",
];

function stepState(phase: EscPhase, step: EscPhase): StepState {
    const current = PHASE_ORDER.indexOf(phase);
    const own = PHASE_ORDER.indexOf(step);
    return current > own ? "done" : current === own ? "active" : "pending";
}

/** Output types ESC calibration doesn't apply to, with why — `null` when it
 * does apply (Normal, OneShot, OneShot125, PWMRange, PWMAngle). */
export function escCalibrationNotNeeded(pwmType: number | undefined): string | null {
    if (pwmType === undefined) return null;
    if (pwmType === PWM_TYPE_BRUSHED) return "Brushed motors don't use ESC calibration.";
    if (isDshotType(pwmType)) return "DShot ESCs don't need calibration — the throttle range is fixed by the protocol.";
    return null;
}

function GuideStep({n, title, state, children}: {n: number; title: string; state: StepState; children?: ReactNode}) {
    const tone =
        state === "done" ? "text-state-ok" : state === "active" ? "text-text-primary" : "text-text-disabled";
    return (
        <li className="flex flex-col gap-2 border-b border-border-subtle py-3">
            <div className="flex items-baseline gap-3">
                <span className={`w-4 shrink-0 text-label ${tone}`}>{n}</span>
                <span className={`flex-1 text-label ${tone} ${state === "active" ? "font-semibold" : ""}`}>{title}</span>
                {state === "done" && <span className="text-micro text-state-ok">Done</span>}
            </div>
            {/* Shown from the start so the whole procedure can be read ahead;
                each step's controls are only enabled once it's reached. */}
            {children && <div className="ml-7 flex flex-col gap-2">{children}</div>}
        </li>
    );
}

function Check({ok, label}: {ok: boolean | null; label: string}) {
    return (
        <div className="flex items-center gap-2">
            <span
                className={`text-label ${ok === null ? "text-text-helper" : ok ? "text-state-ok" : "text-state-danger"}`}
            >
                {ok === null ? "…" : ok ? "✓" : "✕"}
            </span>
            <span className="text-label text-text-primary">{label}</span>
        </div>
    );
}

function ActionButton({onClick, disabled, children}: {onClick: () => void; disabled?: boolean; children: ReactNode}) {
    return (
        <button
            type="button"
            disabled={disabled}
            onClick={onClick}
            className="h-control-sm w-fit border border-border-subtle px-3 text-label text-text-primary hover:enabled:bg-layer-hover-01 disabled:text-text-disabled"
        >
            {children}
        </button>
    );
}

const MODE_OPTIONS: {value: EscMode; label: string}[] = [
    {value: "auto", label: "Automatic"},
    {value: "stick", label: "Throttle stick"},
];

function ModeChoice({value, disabled, onChange}: {value: EscMode; disabled: boolean; onChange: (mode: EscMode) => void}) {
    return (
        <div className="flex w-fit border border-border-subtle" role="radiogroup" aria-label="Calibration mode">
            {MODE_OPTIONS.map((option) => (
                <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={option.value === value}
                    disabled={disabled}
                    onClick={() => onChange(option.value)}
                    className={`h-control-sm px-3 text-label ${
                        option.value === value
                            ? "bg-layer-02 text-text-primary"
                            : "text-text-secondary hover:enabled:bg-layer-hover-01 disabled:text-text-disabled"
                    }`}
                >
                    {option.label}
                </button>
            ))}
        </div>
    );
}

interface EscCalibrationPanelProps {
    live: Map<string, LiveParamEntry>;
    connected: boolean;
    /** The transport itself is gone (e.g. USB unplugged) — the vehicle can't
     * come back on its own; only reconnecting brings it back. */
    linkLost: boolean;
    armed: boolean;
    /** `null` while the radio's calibration state can't be read yet. */
    radioCalibrated: boolean | null;
    /** Parameter count the vehicle reported for the current download, `null`
     * until it has. */
    paramsTotal: number | null;
    onSet: (name: string, value: number) => Promise<number>;
}

/**
 * Step-by-step guide for ArduCopter's ESC calibration, automatic or with the
 * throttle stick passed through. Progress lives in `escCalibration.ts`, not
 * here — see there for the two modes and why most steps are ticked by hand
 * rather than detected.
 */
export default function EscCalibrationPanel({
    live,
    connected,
    linkLost,
    armed,
    radioCalibrated,
    paramsTotal,
    onSet,
}: EscCalibrationPanelProps) {
    const esc = useEscCalibration();
    const [chosenMode, setChosenMode] = useState<EscMode>("auto");
    const [propsRemoved, setPropsRemoved] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const pwmType = live.get("MOT_PWM_TYPE")?.value;
    const escCalValue = live.get("ESC_CALIBRATION")?.value;
    const notNeeded = escCalibrationNotNeeded(pwmType);

    const phase = esc.phase;
    const mode = phase === "idle" ? chosenMode : esc.mode;
    const stick = mode === "stick";
    const paramsComplete = paramsTotal !== null && live.size >= paramsTotal;
    const ready = connected && !armed && radioCalibrated === true && propsRemoved;

    const safetyDefault = live.get("BRD_SAFETY_DEFLT")?.value;
    // Turned on earlier (another session, or before an app restart) — pick
    // the guide up at the power-off step rather than offering to set it again.
    useEffect(() => {
        const pending = escModeFromParam(escCalValue);
        if (phase === "idle" && pending !== null && connected) {
            beginEscCalibration(pending, (safetyDefault ?? 1) !== 0);
        }
    }, [phase, escCalValue, connected, safetyDefault]);

    // Only trusted once the store has re-downloaded since the final power-up —
    // see `paramsFresh` in escCalibration.ts.
    const paramsLoaded = esc.paramsFresh && paramsComplete;


    async function turnOn() {
        setBusy(true);
        setError(null);
        try {
            await onSet("ESC_CALIBRATION", ESC_CALIBRATION_VALUE[chosenMode]);
            beginEscCalibration(chosenMode, (safetyDefault ?? 1) !== 0);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    async function cancel() {
        setBusy(true);
        setError(null);
        try {
            await onSet("ESC_CALIBRATION", 0);
            resetEscCalibration();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    if (notNeeded && phase === "idle") {
        return (
            <div className="flex w-full max-w-lg flex-col gap-6">
                <h2 className="text-heading text-text-primary">ESC</h2>
                <p className="text-label text-text-secondary">{notNeeded}</p>
            </div>
        );
    }

    const showSafety = phase === "idle" ? (safetyDefault ?? 1) !== 0 : esc.safetyStep;
    const sUnplug = stepState(phase, "powerOff");
    const sStick = stepState(phase, "stickHigh");
    const sBattery = stepState(phase, "battery");
    const sSafety = stepState(phase, "safety");
    const sTones = stepState(phase, "tones");
    const verified = phase === "finished" && paramsLoaded && esc.boardCheck !== "pending";
    const sPowerUp: StepState = phase === "finished" ? (verified ? "done" : "active") : stepState(phase, "powerCycle");

    const nBattery = stick ? 5 : 4;
    const nTones = nBattery + (showSafety ? 2 : 1);
    const nPowerUp = nTones + 1;

    const cancellable =
        connected &&
        (phase === "powerOff" || phase === "stickHigh" || phase === "battery" || phase === "safety" || phase === "tones");

    return (
        <div className="flex w-full max-w-lg flex-col gap-6">
            <h2 className="text-heading text-text-primary">ESC</h2>

            <div className="flex flex-col gap-2">
                <ModeChoice value={mode} disabled={phase !== "idle"} onChange={setChosenMode}/>
                <p className="text-label text-text-helper">
                    Tones and timing vary by ESC — check its manual. ESCs with fixed throttle endpoints don't calibrate
                    this way.
                </p>
            </div>

            {phase === "normalBoot" ? (
                <div className="flex flex-col gap-3">
                    <p className="text-label text-state-danger">
                        {stick
                            ? "The vehicle booted normally — calibration didn't run. Check the transmitter is on, the radio is calibrated and the throttle stick is at full before the battery goes in, then start again."
                            : "The vehicle booted normally — calibration didn't run. Check the transmitter is on and the radio is calibrated, then start again."}
                    </p>
                    <ActionButton onClick={resetEscCalibration}>Start over</ActionButton>
                </div>
            ) : (
                <ol className="flex flex-col">
                    <GuideStep n={1} title="Get ready" state={phase === "idle" ? "active" : "done"}>
                        <Check ok={connected ? !armed : null} label="Disarmed"/>
                        <Check ok={radioCalibrated} label="Radio calibrated"/>
                        <label className="flex w-fit cursor-pointer items-center gap-2 text-label text-state-warn select-none">
                            <input
                                type="checkbox"
                                checked={propsRemoved}
                                disabled={phase !== "idle"}
                                onChange={(event) => setPropsRemoved(event.target.checked)}
                            />
                            Propellers are removed
                        </label>
                    </GuideStep>

                    <GuideStep n={2} title="Turn on calibration" state={phase === "idle" ? (ready ? "active" : "pending") : "done"}>
                        <p className="text-label text-text-secondary">
                            {stick
                                ? "On the next power-up the throttle stick drives every motor directly."
                                : "Every motor runs at full throttle for 5 seconds on the next power-up. If your ESC needs the throttle lowered sooner, use Throttle stick."}
                        </p>
                        <ActionButton onClick={() => void turnOn()} disabled={!ready || busy}>
                            Turn on calibration
                        </ActionButton>
                    </GuideStep>

                    <GuideStep n={3} title="Unplug the battery and USB" state={sUnplug}>
                        <p className="text-label text-text-secondary">The flight controller must power off completely.</p>
                        {sUnplug === "active" && (
                            <p className="text-label text-text-helper">Waiting for the vehicle to go offline…</p>
                        )}
                    </GuideStep>

                    {stick && (
                        <GuideStep n={4} title="Hold the throttle stick at full" state={sStick}>
                            <p className="text-label text-text-secondary">
                                Transmitter on. Keep it there until the ESCs beep to confirm full throttle.
                            </p>
                            <ActionButton onClick={confirmEscStep} disabled={sStick !== "active"}>Done</ActionButton>
                        </GuideStep>
                    )}

                    <GuideStep n={nBattery} title="Connect the battery only" state={sBattery}>
                        <p className="text-label text-text-secondary">
                            Leave USB unplugged. The vehicle stays silent on the radio from here until step {nPowerUp}.
                        </p>
                        <ActionButton onClick={confirmEscStep} disabled={sBattery !== "active"}>Done</ActionButton>
                    </GuideStep>

                    {showSafety && (
                        <GuideStep n={nBattery + 1} title="Press the safety switch" state={sSafety}>
                            <p className="text-label text-text-secondary">Hold it until it shows solid red.</p>
                            <ActionButton onClick={confirmEscStep} disabled={sSafety !== "active"}>Done</ActionButton>
                        </GuideStep>
                    )}

                    <GuideStep n={nTones} title="Listen for the tones" state={sTones}>
                        <ul className="flex list-disc flex-col gap-1 pl-4 text-label text-text-secondary">
                            {stick ? (
                                <>
                                    <li>The ESCs beep to confirm full throttle — move the stick to the bottom straight away</li>
                                    <li>They beep to confirm the bottom — the throttle range is set</li>
                                </>
                            ) : (
                                <>
                                    <li>The ESCs beep to confirm full throttle</li>
                                    <li>About 5 seconds later they beep to confirm zero — the throttle range is set</li>
                                </>
                            )}
                        </ul>
                        <p className="text-label text-text-helper">
                            {stick
                                ? "If the beeping carries on, the ESC may be in its settings menu — unplug the battery without moving the stick and start again."
                                : "If the beeping carries on, the ESC went into its settings menu instead — unplug the battery and use Throttle stick."}
                        </p>
                        <ActionButton onClick={confirmEscStep} disabled={sTones !== "active"}>Range is set</ActionButton>
                    </GuideStep>

                    <GuideStep n={nPowerUp} title="Power up normally" state={sPowerUp}>
                        <p className="text-label text-text-secondary">
                            {stick
                                ? "Until the battery is unplugged the stick drives the motors directly. Keep it at the bottom, unplug the battery, then power up as usual."
                                : "Unplug the battery, then power up as usual."}
                        </p>
                        {phase === "powerCycle" && (
                            <p className="text-label text-text-helper">
                                {linkLost ? "Link lost — reconnect to the vehicle." : "Waiting for the vehicle to reconnect…"}
                            </p>
                        )}
                        {phase === "finished" && (
                            <>
                                <Check ok={true} label="Reconnected"/>
                                <Check
                                    ok={esc.boardCheck === "pending" || esc.boardCheck === "unknown" ? null : esc.boardCheck === "same"}
                                    label={
                                        esc.boardCheck === "pending"
                                            ? "Checking flight controller…"
                                            : esc.boardCheck === "same"
                                              ? "Same flight controller"
                                              : esc.boardCheck === "different"
                                                ? "A different flight controller connected"
                                                : "Flight controller can't be confirmed — no board ID reported"
                                    }
                                />
                                {!paramsLoaded ? (
                                    <Check
                                        ok={null}
                                        label={`Reading parameters…${paramsTotal !== null ? ` ${live.size} of ${paramsTotal}` : ""}`}
                                    />
                                ) : (
                                    <Check
                                        ok={escCalValue === 0}
                                        label={
                                            escCalValue === 0
                                                ? "ESC_CALIBRATION is back to 0"
                                                : `ESC_CALIBRATION is ${escCalValue ?? "missing"} — calibration didn't run`
                                        }
                                    />
                                )}
                                {verified && <ActionButton onClick={resetEscCalibration}>Start over</ActionButton>}
                            </>
                        )}
                    </GuideStep>
                </ol>
            )}

            {error && <p className="text-label text-state-danger">{error}</p>}

            {cancellable && (
                <ActionButton onClick={() => void cancel()} disabled={busy}>
                    Cancel calibration
                </ActionButton>
            )}

            {phase !== "idle" && (
                <section className="flex flex-col gap-2">
                    <h3 className="text-label uppercase text-text-helper">Vehicle messages</h3>
                    <div className="max-h-48 overflow-auto border border-border-subtle bg-layer-01 p-2">
                        {esc.messages.length === 0 ? (
                            <p className="text-micro text-text-helper">None yet</p>
                        ) : (
                            esc.messages.map((m, i) => (
                                <p key={i} className={`font-mono text-micro ${CONSOLE_LEVEL_CLASSES[levelFromSeverity(m.severity)]}`}>
                                    {new Date(m.at).toLocaleTimeString()} {m.text}
                                </p>
                            ))
                        )}
                    </div>
                </section>
            )}
        </div>
    );
}
