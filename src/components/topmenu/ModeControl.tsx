import {useEffect, useRef, useState} from "react";
import StatusChip from "./StatusChip.tsx";
import {sendVehicleCommand} from "@/lib/vehicle/commands.ts";
import {modesForKind} from "@/lib/vehicle/modes.ts";
import {VehicleKind} from "@/lib/vehicle/vehicle.ts";

interface ModeControlProps {
    vehicleKind: VehicleKind | null;
    customMode: number | null;
    label: string;
    stale: boolean;
    staleFor: number | null;
    unknown: boolean;
    severe: boolean;
}

export default function ModeControl({
    vehicleKind,
    customMode,
    label,
    stale,
    staleFor,
    unknown,
    severe,
}: ModeControlProps) {
    const [open, setOpen] = useState(false);
    const [pending, setPending] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);
    const rootRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) {
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

    const modes = modesForKind(vehicleKind);
    const options = modes ? Object.entries(modes).map(([value, name]) => ({value: Number(value), name})) : [];

    async function selectMode(mode: number) {
        if (mode === customMode) {
            return;
        }
        setPending(mode);
        setError(null);
        try {
            await sendVehicleCommand({type: "setMode", mode});
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setPending(null);
        }
    }

    return (
        <div ref={rootRef} className="contents">
            <StatusChip
                label="Mode"
                value={label}
                tone="info"
                stale={stale}
                staleFor={staleFor}
                unknown={unknown}
                severe={severe}
                onClick={() => setOpen((value) => !value)}
                expanded={open}
                dropdown={
                    open && (
                        <div className="absolute top-full right-0 z-50 w-56 border border-border-subtle bg-layer-01 shadow-overlay">
                            <div className="flex flex-col gap-2 p-3">
                                {options.length === 0 ? (
                                    <p className="text-label text-text-helper">
                                        Mode switching isn't known for this vehicle type yet.
                                    </p>
                                ) : (
                                    <ul className="flex max-h-80 flex-col overflow-y-auto">
                                        {options.map(({value, name}) => (
                                            <li key={value}>
                                                <button
                                                    type="button"
                                                    disabled={pending !== null}
                                                    onClick={() => void selectMode(value)}
                                                    className={[
                                                        "flex h-control-sm w-full items-center gap-2 px-2 text-left text-label disabled:opacity-40",
                                                        value === customMode
                                                            ? "bg-layer-02 text-text-primary"
                                                            : "text-text-secondary hover:bg-layer-hover-01 hover:text-text-primary",
                                                    ].join(" ")}
                                                >
                                                    <span className="w-3 shrink-0 text-state-info">
                                                        {value === customMode ? "✓" : ""}
                                                    </span>
                                                    {name}
                                                    {pending === value && (
                                                        <span className="ml-auto text-micro text-text-helper">
                                                            Sending…
                                                        </span>
                                                    )}
                                                </button>
                                            </li>
                                        ))}
                                    </ul>
                                )}

                                {error && <p className="text-label text-state-danger">{error}</p>}
                            </div>
                        </div>
                    )
                }
            />
        </div>
    );
}
