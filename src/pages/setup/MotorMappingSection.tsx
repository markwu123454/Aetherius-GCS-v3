import {useMemo, useState} from "react";
import {LiveParamEntry} from "@/lib/params/liveParams.ts";
import {ParamOption} from "@/lib/params/paramSheet.ts";
import {findFrameLayout, FrameLayout, motorAngle, MotorPosition, motorPositionName} from "@/lib/frames/motorLayouts.ts";
import FrameDiagram from "@/components/FrameDiagram.tsx";

interface MotorMappingSectionProps {
    live: Map<string, LiveParamEntry>;
    onSet: (name: string, value: number) => Promise<number>;
    /** `SERVOx_FUNCTION`'s option list from the param sheet — where each
     * `MotorN`'s numeric value and every output's function label come from. */
    functionValues: ParamOption[];
    /** `FRAME_CLASS`'s option list, for naming the frame. */
    frameClassValues: ParamOption[];
    outputCount: number;
    onFunctionChanged: () => void;
}

/** "Motor1" → "Motor 1"; everything else as the param sheet labels it. */
function prettyFunction(label: string): string {
    return label.replace(/^Motor(\d+)$/, "Motor $1");
}

function frameName(classLabel: string, layout: FrameLayout): string {
    const type = layout.typeName.toLowerCase() === "default" ? "" : layout.typeName.replace(/-/g, " ");
    return type ? `${classLabel} ${type}` : classLabel;
}

function SpinChip({motor}: {motor: MotorPosition}) {
    const chip = "bg-background px-1.5 font-mono text-micro leading-4";
    if (motor.kind === "servo") return <span className={`${chip} text-purple-40`}>SERVO</span>;
    if (motor.spin === "Either") return <span className={`${chip} text-text-secondary`}>EITHER DIR</span>;
    return <span className={`${chip} text-text-primary`}>{motor.spin}</span>;
}

/**
 * The frame-aware view of the same `SERVOx_FUNCTION` params the output list
 * below edits: one card per `MotorN` the vehicle's frame uses, named for
 * where it sits, with the output it's on. Picking an output that already
 * holds something swaps the two, so fixing a crossed pair of ESC leads is one
 * change instead of two and nothing silently ends up on no output.
 *
 * Only for frames ArduPilot publishes a fixed motor layout for — see
 * motorLayouts.ts for which, and why the rest are left to the output list.
 */
export default function MotorMappingSection({live, onSet, functionValues, frameClassValues, outputCount, onFunctionChanged}: MotorMappingSectionProps) {
    const [hot, setHot] = useState<number | null>(null);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirmDefaults, setConfirmDefaults] = useState(false);

    const frameClass = live.get("FRAME_CLASS")?.value;
    const frameType = live.get("FRAME_TYPE")?.value ?? 0;
    const layout = frameClass === undefined ? null : findFrameLayout(Math.round(frameClass), Math.round(frameType));
    const classLabel = frameClassValues.find((o) => o.value === frameClass)?.label ?? `Frame class ${frameClass}`;

    const functionByValue = useMemo(() => new Map(functionValues.map((o) => [o.value, o.label])), [functionValues]);
    const motorFunction = useMemo(() => {
        const map = new Map<number, number>();
        for (const o of functionValues) {
            const match = /^Motor(\d+)$/.exec(o.label);
            if (match) map.set(Number(match[1]), o.value);
        }
        return map;
    }, [functionValues]);

    // outputs[n] = SERVOn_FUNCTION as the vehicle last reported it.
    const outputs: (number | undefined)[] = [];
    for (let n = 1; n <= outputCount; n++) {
        const entry = live.get(`SERVO${n}_FUNCTION`);
        outputs[n] = entry ? Math.round(entry.value) : undefined;
    }
    const outputOf = (fn: number) => outputs.findIndex((value, n) => n > 0 && value === fn);

    if (frameClass === undefined || functionValues.length === 0) {
        return null;
    }

    const writeAll = async (writes: [number, number][]) => {
        setPending(true);
        setError(null);
        try {
            for (const [output, value] of writes) {
                await onSet(`SERVO${output}_FUNCTION`, value);
            }
            onFunctionChanged();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setPending(false);
        }
    };

    const assign = (motor: MotorPosition, target: number) => {
        const fn = motorFunction.get(motor.number);
        if (fn === undefined) return;
        const from = outputOf(fn);
        if (target === Math.max(from, 0)) return;
        if (target === 0) {
            void writeAll([[from, 0]]);
            return;
        }
        const writes: [number, number][] = [[target, fn]];
        // Swap: whatever was on the target moves to where this motor was.
        if (from > 0) writes.push([from, outputs[target] ?? 0]);
        void writeAll(writes);
    };

    // ArduPilot's own default wiring: MotorN on output N. Stray copies of the
    // frame's motor functions elsewhere are cleared so no motor ends up on
    // two outputs.
    const defaultWrites = (): [number, number][] => {
        if (!layout) return [];
        const writes: [number, number][] = [];
        const frameFunctions = new Set(layout.motors.map((m) => motorFunction.get(m.number)));
        for (const m of layout.motors) {
            const fn = motorFunction.get(m.number);
            if (fn !== undefined && m.number <= outputCount && outputs[m.number] !== fn) writes.push([m.number, fn]);
        }
        const targets = new Set(layout.motors.map((m) => m.number));
        for (let n = 1; n <= outputCount; n++) {
            const value = outputs[n];
            if (!targets.has(n) && value !== undefined && frameFunctions.has(value)) writes.push([n, 0]);
        }
        return writes;
    };

    if (!layout) {
        return (
            <section className="flex flex-col gap-1 bg-layer-01 p-3">
                <h2 className="text-heading text-text-primary">Motor mapping</h2>
                <p className="text-label text-text-helper">
                    ArduPilot publishes no fixed motor layout for {classLabel}. Assign its outputs in the list below.
                </p>
            </section>
        );
    }

    const pendingDefaults = confirmDefaults ? defaultWrites() : [];

    return (
        <section className="flex flex-col gap-3 bg-layer-01 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <h2 className="text-heading text-text-primary">Motor mapping</h2>
                    <span className="text-label text-text-secondary">
                        {frameName(classLabel, layout)}
                        <span className="ml-2 font-mono text-text-helper">
                            FRAME_CLASS {frameClass} · FRAME_TYPE {frameType}
                        </span>
                    </span>
                </div>
                {confirmDefaults ? (
                    <div className="flex items-center gap-2 text-label">
                        <span className="text-text-secondary">
                            {pendingDefaults.length === 0
                                ? "Already in default order."
                                : `Overwrite output${pendingDefaults.length === 1 ? "" : "s"} ${pendingDefaults.map(([n]) => n).join(", ")}?`}
                        </span>
                        {pendingDefaults.length > 0 && (
                            <button
                                type="button"
                                disabled={pending}
                                onClick={() => {
                                    setConfirmDefaults(false);
                                    void writeAll(pendingDefaults);
                                }}
                                className="h-control-sm bg-state-info px-3 text-text-on-color disabled:opacity-50"
                            >
                                Overwrite
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={() => setConfirmDefaults(false)}
                            className="h-control-sm border border-border-strong px-3 text-text-primary hover:bg-layer-hover-01"
                        >
                            {pendingDefaults.length === 0 ? "Close" : "Cancel"}
                        </button>
                    </div>
                ) : (
                    <button
                        type="button"
                        disabled={pending}
                        onClick={() => setConfirmDefaults(true)}
                        className="h-control-sm border border-border-strong px-3 text-label text-text-primary hover:bg-layer-hover-01 disabled:text-text-disabled"
                    >
                        Set default order
                    </button>
                )}
            </div>

            <div className="grid grid-cols-[11rem_minmax(0,1fr)] items-stretch gap-3">
                <div className="flex items-center justify-center bg-background p-2">
                    <FrameDiagram frame={layout} highlight={hot} numbers className="aspect-square w-full"/>
                </div>
                <div className="min-w-0 overflow-x-auto pb-1">
                    <div className="flex w-max gap-2">
                        {layout.motors.map((motor) => {
                            const fn = motorFunction.get(motor.number);
                            const out = fn === undefined ? -1 : outputOf(fn);
                            const assigned = out > 0;
                            return (
                                <div
                                    key={motor.number}
                                    onPointerEnter={() => setHot(motor.number)}
                                    onPointerLeave={() => setHot(null)}
                                    onFocus={() => setHot(motor.number)}
                                    onBlur={() => setHot(null)}
                                    className={`flex w-38 flex-none flex-col gap-1.5 border bg-layer-02 p-2 ${
                                        hot === motor.number ? "border-state-info" : assigned ? "border-transparent" : "border-state-warn"
                                    }`}
                                >
                                    <FrameDiagram frame={layout} highlight={motor.number} className="aspect-square w-full bg-background"/>
                                    <div className="flex items-baseline justify-between gap-1">
                                        <span className="text-body font-semibold text-text-primary">Motor {motor.number}</span>
                                        {fn !== undefined && <span className="font-mono text-micro text-text-helper">fn {fn}</span>}
                                    </div>
                                    <span className="min-h-8 text-label text-text-primary">{motorPositionName(motor)}</span>
                                    <div className="flex min-h-4 flex-wrap gap-1">
                                        <SpinChip motor={motor}/>
                                        {motor.stack && (
                                            <span className="bg-background px-1.5 font-mono text-micro leading-4 text-text-secondary">
                                                {motor.stack === "top" ? "TOP" : "BOTTOM"}
                                            </span>
                                        )}
                                        {motor.sameAs !== undefined && (
                                            <span className="bg-background px-1.5 font-mono text-micro leading-4 text-text-secondary">
                                                SAME AS {motor.sameAs}
                                            </span>
                                        )}
                                        {motor.kind === "motor" && Math.hypot(motor.x, motor.y) >= 0.05 && (
                                            <span className="bg-background px-1.5 font-mono text-micro leading-4 text-text-secondary">
                                                {motorAngle(motor)}°
                                            </span>
                                        )}
                                    </div>
                                    <div className="mt-auto flex flex-col gap-0.5">
                                        <label
                                            htmlFor={`motor-output-${motor.number}`}
                                            className={`text-micro uppercase ${assigned ? "text-text-helper" : "text-state-warn"}`}
                                        >
                                            {assigned ? "Servo output" : "Not assigned"}
                                        </label>
                                        {/* The closed picker shows just the output number; the
                                            open list names what's on every output. A native select
                                            can't show its value differently from its option, so a
                                            styled face sits under a transparent select that still
                                            takes every click and key. */}
                                        <div className="group relative">
                                            <span
                                                aria-hidden="true"
                                                className={`flex h-control-sm items-center justify-between border-b bg-layer-01 px-2 font-mono text-body group-hover:bg-layer-hover-01 group-focus-within:outline-2 group-focus-within:outline-focus ${
                                                    assigned ? "border-border-strong text-text-primary" : "border-state-warn text-state-warn"
                                                }`}
                                            >
                                                {assigned ? out : "—"}
                                                <span className="mb-0.5 size-1.5 rotate-45 border-r-[1.5px] border-b-[1.5px] border-text-secondary"/>
                                            </span>
                                            <select
                                                id={`motor-output-${motor.number}`}
                                                value={assigned ? out : 0}
                                                disabled={pending || fn === undefined}
                                                onChange={(event) => assign(motor, Number(event.target.value))}
                                                className="absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-default"
                                            >
                                                <option value={0}>— Not assigned</option>
                                                {Array.from({length: outputCount}, (_, i) => i + 1).map((n) => {
                                                    const value = outputs[n];
                                                    const label = value === undefined ? "not read yet" : prettyFunction(functionByValue.get(value) ?? `Function ${value}`);
                                                    return (
                                                        <option key={n} value={n}>
                                                            {n} · {label}
                                                        </option>
                                                    );
                                                })}
                                            </select>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>

            {error && <p className="text-label text-state-danger">{error}</p>}
        </section>
    );
}
