import {useEffect, useRef, useState} from "react";
import StatusChip, {Tone} from "./StatusChip.tsx";
import {sendVehicleCommand} from "@/lib/vehicle/commands.ts";

interface ArmControlProps {
    armed: boolean;
    stale: boolean;
    staleFor: number | null;
    unknown: boolean;
    severe: boolean;
}

type PendingAction = "arm" | "disarm";

/** How long the confirm button must be held before the command fires. Long
 * enough that it can't be triggered by an accidental click or drag, short
 * enough that it isn't itself an obstacle in an emergency disarm. */
const HOLD_MS = 1_000;

export default function ArmControl({armed, stale, staleFor, unknown, severe}: ArmControlProps) {
    const [open, setOpen] = useState(false);
    const [pending, setPending] = useState<PendingAction | null>(null);
    const [holding, setHolding] = useState(false);
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    const holdTimer = useRef<number | null>(null);

    useEffect(() => {
        if (!open) {
            setPending(null);
            setHolding(false);
            setError(null);
            return;
        }

        const onPointerDown = (event: PointerEvent) => {
            if (!rootRef.current?.contains(event.target as Node)) {
                setOpen(false);
            }
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setOpen(false);
            }
        };

        window.addEventListener("pointerdown", onPointerDown);
        window.addEventListener("keydown", onKeyDown);
        return () => {
            window.removeEventListener("pointerdown", onPointerDown);
            window.removeEventListener("keydown", onKeyDown);
        };
    }, [open]);

    // Holding through a state flip (armed while "arm" is still selected, say
    // a heartbeat lands while the pointer is still down) would fire the wrong
    // command, so the in-progress hold is abandoned rather than trusted.
    useEffect(() => {
        cancelHold();
        setPending(null);
    }, [armed]);

    function cancelHold() {
        if (holdTimer.current !== null) {
            window.clearTimeout(holdTimer.current);
            holdTimer.current = null;
        }
        setHolding(false);
    }

    function selectAction(action: PendingAction) {
        cancelHold();
        setError(null);
        setPending((current) => (current === action ? null : action));
    }

    function startHold() {
        if (!pending || sending) {
            return;
        }
        setHolding(true);
        holdTimer.current = window.setTimeout(() => {
            holdTimer.current = null;
            void confirm();
        }, HOLD_MS);
    }

    async function confirm() {
        if (!pending) {
            return;
        }
        setSending(true);
        setError(null);
        try {
            await sendVehicleCommand({type: pending});
            setPending(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setSending(false);
            setHolding(false);
        }
    }

    const tone: Tone = armed ? "danger" : "neutral";

    return (
        <div ref={rootRef} className="contents">
            <StatusChip
                label="State"
                value={armed ? "ARMED" : "DISARMED"}
                tone={tone}
                stale={stale}
                staleFor={staleFor}
                unknown={unknown}
                severe={severe}
                onClick={() => setOpen((value) => !value)}
                expanded={open}
                dropdown={
                    open && (
                        <div className="absolute top-full right-0 z-50 w-64 border border-border-subtle bg-layer-01 shadow-overlay">
                            <div className="flex flex-col gap-3 p-3">
                                <div className="grid grid-cols-2 gap-2">
                                    <button
                                        type="button"
                                        disabled={armed || sending}
                                        onClick={() => selectAction("arm")}
                                        className={[
                                            "h-control-sm text-label disabled:opacity-40",
                                            pending === "arm"
                                                ? "bg-blue-60 text-text-on-color"
                                                : "bg-layer-02 text-text-primary hover:bg-layer-hover-02",
                                        ].join(" ")}
                                    >
                                        Arm
                                    </button>
                                    <button
                                        type="button"
                                        disabled={!armed || sending}
                                        onClick={() => selectAction("disarm")}
                                        className={[
                                            "h-control-sm text-label disabled:opacity-40",
                                            pending === "disarm"
                                                ? "bg-red-60 text-text-on-color"
                                                : "bg-layer-02 text-text-primary hover:bg-layer-hover-02",
                                        ].join(" ")}
                                    >
                                        Disarm
                                    </button>
                                </div>

                                {error && <p className="text-label text-state-danger">{error}</p>}

                                <div className="relative h-control-sm w-full overflow-hidden border border-border-subtle bg-layer-02">
                                    <div
                                        aria-hidden="true"
                                        className={pending === "disarm" ? "absolute inset-y-0 left-0 bg-red-60" : "absolute inset-y-0 left-0 bg-blue-60"}
                                        style={{
                                            width: holding ? "100%" : "0%",
                                            transition: holding ? `width ${HOLD_MS}ms linear` : "none",
                                        }}
                                    />
                                    <button
                                        type="button"
                                        disabled={!pending || sending}
                                        onPointerDown={startHold}
                                        onPointerUp={cancelHold}
                                        onPointerLeave={cancelHold}
                                        onPointerCancel={cancelHold}
                                        className="relative z-10 flex h-full w-full items-center justify-center text-label text-text-primary select-none disabled:text-text-disabled"
                                    >
                                        {sending
                                            ? "Sending…"
                                            : pending
                                              ? `Hold to ${pending === "arm" ? "Arm" : "Disarm"}`
                                              : "Select Arm or Disarm"}
                                    </button>
                                </div>
                            </div>
                        </div>
                    )
                }
            />
        </div>
    );
}
