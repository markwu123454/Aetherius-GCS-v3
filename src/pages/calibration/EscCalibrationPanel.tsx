import {useEffect, useState, type ReactNode} from "react";
import type {LiveParamEntry} from "@/lib/params/liveParams.ts";
import {CONSOLE_LEVEL_CLASSES, levelFromSeverity} from "@/lib/console/console.ts";
import {isDshotType} from "@/lib/params/motorOutputs.ts";
import {
    beginEscCalibration,
    confirmEscStep,
    resetEscCalibration,
    useEscCalibration,
    type EscPhase,
} from "@/lib/calibration/escCalibration.ts";

/** `MOT_PWM_TYPE` 3. */
const PWM_TYPE_BRUSHED = 3;

type StepState = "pending" | "active" | "done";

/** Where each guide step sits in the procedure, for deriving its state from
 * the current phase. `idle` covers both steps that happen before the
 * calibration flag is set. */
const PHASE_ORDER: EscPhase[] = ["idle", "powerOff", "battery", "safety", "tones", "powerCycle", "finished"];

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
 * Step-by-step guide for ArduCopter's automatic ESC calibration. Progress
 * lives in `escCalibration.ts`, not here — see there for why most steps are
 * ticked by hand rather than detected.
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
    const [propsRemoved, setPropsRemoved] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const pwmType = live.get("MOT_PWM_TYPE")?.value;
    const escCalValue = live.get("ESC_CALIBRATION")?.value;
    const notNeeded = escCalibrationNotNeeded(pwmType);

    const phase = esc.phase;
    const paramsComplete = paramsTotal !== null && live.size >= paramsTotal;
    const ready = connected && !armed && radioCalibrated === true && propsRemoved;

    const safetyDefault = live.get("BRD_SAFETY_DEFLT")?.value;
    // Turned on earlier (another session, or before an app restart) — pick
    // the guide up at the power-off step rather than offering to set it again.
    useEffect(() => {
        if (phase === "idle" && escCalValue === 3 && connected) {
            beginEscCalibration((safetyDefault ?? 1) !== 0);
        }
    }, [phase, escCalValue, connected, safetyDefault]);

    // Only trusted once the store has re-downloaded since the final power-up —
    // see `paramsFresh` in escCalibration.ts.
    const paramsLoaded = esc.paramsFresh && paramsComplete;


    async function turnOn() {
        setBusy(true);
        setError(null);
        try {
            await onSet("ESC_CALIBRATION", 3);
            beginEscCalibration((safetyDefault ?? 1) !== 0);
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
    const s3 = stepState(phase, "powerOff");
    const s4 = stepState(phase, "battery");
    const s5 = stepState(phase, "safety");
    const s6 = stepState(phase, "tones");
    const verified = phase === "finished" && paramsLoaded && esc.boardCheck !== "pending";
    const s7: StepState = phase === "finished" ? (verified ? "done" : "active") : stepState(phase, "powerCycle");

    const cancellable = connected && (phase === "powerOff" || phase === "battery" || phase === "safety" || phase === "tones");

    return (
        <div className="flex w-full max-w-lg flex-col gap-6">
            <h2 className="text-heading text-text-primary">ESC</h2>

            {phase === "normalBoot" ? (
                <div className="flex flex-col gap-3">
                    <p className="text-label text-state-danger">
                        The vehicle booted normally — calibration didn't run. Check the transmitter is on and the radio
                        is calibrated, then start again.
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
                            Every motor runs at full throttle for 5 seconds on the next power-up.
                        </p>
                        <ActionButton onClick={() => void turnOn()} disabled={!ready || busy}>
                            Turn on calibration
                        </ActionButton>
                    </GuideStep>

                    <GuideStep n={3} title="Unplug the battery and USB" state={s3}>
                        <p className="text-label text-text-secondary">The flight controller must power off completely.</p>
                        {s3 === "active" && (
                            <p className="text-label text-text-helper">Waiting for the vehicle to go offline…</p>
                        )}
                    </GuideStep>

                    <GuideStep n={4} title="Connect the battery only" state={s4}>
                        <p className="text-label text-text-secondary">
                            Leave USB unplugged. The vehicle stays silent on the radio from here until step{" "}
                            {showSafety ? 7 : 6}.
                        </p>
                        <ActionButton onClick={confirmEscStep} disabled={s4 !== "active"}>Done</ActionButton>
                    </GuideStep>

                    {showSafety && (
                        <GuideStep n={5} title="Press the safety switch" state={s5}>
                            <p className="text-label text-text-secondary">Hold it until it shows solid red.</p>
                            <ActionButton onClick={confirmEscStep} disabled={s5 !== "active"}>Done</ActionButton>
                        </GuideStep>
                    )}

                    <GuideStep n={showSafety ? 6 : 5} title="Listen for the tones" state={s6}>
                        <ul className="flex list-disc flex-col gap-1 pl-4 text-label text-text-secondary">
                            <li>A musical tone, then two beeps</li>
                            <li>One beep per battery cell</li>
                            <li>A long beep — the throttle range is set</li>
                        </ul>
                        <ActionButton onClick={confirmEscStep} disabled={s6 !== "active"}>Heard the long beep</ActionButton>
                    </GuideStep>

                    <GuideStep n={showSafety ? 7 : 6} title="Power up normally" state={s7}>
                        <p className="text-label text-text-secondary">Unplug the battery, then power up as usual.</p>
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
