import {useEffect, useMemo, useState} from "react";
import {useReboot} from "@/lib/vehicle/useReboot.ts";
import {LiveParamEntry} from "@/lib/params/liveParams.ts";
import {useParamSheet} from "@/lib/params/useParamSheet.ts";
import {ParamDef, VehicleFirmware} from "@/lib/params/paramSheet.ts";
import {
    findMotorOutputs,
    hasBit,
    isDshotType,
    MotorOutput,
    MultirotorConfig,
    multirotorConfig,
    PWM_TYPE_ANGLE,
    PWM_TYPE_RANGE,
    withBit,
} from "@/lib/params/motorOutputs.ts";
import {
    actuatorToPwm,
    copterStickThrottle,
    MotorCurveParams,
    quadplaneStickThrottle,
    RcThrottle,
    ServoRange,
    servoOutputPwm,
    thrustToPwm,
} from "@/lib/params/motorCurves.ts";
import MotorCurveChart, {ChartLine, ChartPoint} from "./MotorCurveChart.tsx";
import {RangeNumberInput, ReverseToggle} from "./ServoSetupPanel.tsx";

interface MotorsSetupPanelProps {
    live: Map<string, LiveParamEntry>;
    onSet: (name: string, value: number) => Promise<number>;
    firmware: VehicleFirmware;
}

/** Everything a row needs to read, write and describe a param. */
interface ParamContext {
    live: Map<string, LiveParamEntry>;
    onSet: (name: string, value: number) => Promise<number>;
    defs: Map<string, ParamDef>;
    onRebootNeeded: () => void;
}

const SERVO_COUNT = 32;
const DEFAULT_SERVO_RANGE: [number, number] = [800, 2200];

function liveValue(ctx: ParamContext, name: string, fallback: number): number {
    return ctx.live.get(name)?.value ?? fallback;
}

/** pdef's `PWM` unit reads as the microseconds it is. */
function unitLabel(def: ParamDef | undefined): string {
    if (!def?.units) return "";
    return def.units === "PWM" ? "µs" : def.units;
}

/** Decimal places implied by the param's own increment, else `fallback`. */
function decimalsFor(def: ParamDef | undefined, fallback: number): number {
    if (!def?.increment || def.increment >= 1) return def?.increment ? 0 : fallback;
    return Math.min(4, Math.max(0, -Math.floor(Math.log10(def.increment) + 1e-9)));
}

function useParamWrite(ctx: ParamContext) {
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [ok, setOk] = useState(false);

    useEffect(() => {
        if (!ok) return;
        const t = window.setTimeout(() => setOk(false), 1500);
        return () => window.clearTimeout(t);
    }, [ok]);

    const write = async (name: string, value: number) => {
        setPending(true);
        setError(null);
        setOk(false);
        try {
            await ctx.onSet(name, value);
            setOk(true);
            if (ctx.defs.get(name)?.rebootRequired) ctx.onRebootNeeded();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setPending(false);
        }
    };

    return {pending, error, ok, write};
}

interface RowSpec {
    name: string;
    label: string;
    /** Used when the param sheet gives no increment to infer it from. */
    decimals?: number;
    /** A value the firmware will refuse to arm with. */
    warning?: string | null;
}

/** One param as a select (when pdef names its values) or a number input,
 * committed on change / blur. */
function ParamRow({ctx, spec}: {ctx: ParamContext; spec: RowSpec}) {
    const entry = ctx.live.get(spec.name);
    const def = ctx.defs.get(spec.name);
    const decimals = decimalsFor(def, spec.decimals ?? 2);
    const shown = entry !== undefined ? entry.value.toFixed(decimals) : "";
    const {pending, error, ok, write} = useParamWrite(ctx);
    const [draft, setDraft] = useState(shown);
    const [editing, setEditing] = useState(false);

    useEffect(() => {
        if (!editing) setDraft(shown);
    }, [shown, editing]);

    if (!entry) return null;

    // Only a draft that differs from what's displayed is a change — blurring
    // an untouched field must not round a learned value (e.g. hover) to the
    // displayed precision and write it back.
    const commit = () => {
        setEditing(false);
        const num = Number(draft.trim());
        if (!draft.trim() || Number.isNaN(num) || draft === shown) return;
        void write(spec.name, num);
    };

    const value = Math.round(entry.value);
    // A float param's pdef values are presets (SPIN_MIN's Low/Default/High),
    // not the only legal values — a select would round 0.01 to "Low".
    const options = entry.paramType.startsWith("REAL") ? undefined : def?.values;

    return (
        <div className="grid grid-cols-[minmax(0,1fr)_13rem] items-center gap-3 border-b border-border-subtle-base px-2 py-1.5 last:border-b-0">
            <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-label text-text-primary">{spec.label}</span>
                    <span className="font-mono text-micro text-text-helper">{spec.name}</span>
                </div>
                {spec.warning && <div className="text-micro text-state-danger">{spec.warning}</div>}
            </div>
            <div className="flex min-w-0 items-center gap-2">
                {options ? (
                    <select
                        value={value}
                        disabled={pending}
                        onChange={(e) => void write(spec.name, Number(e.target.value))}
                        className="h-control-sm min-w-0 flex-1 border border-border-subtle bg-background px-1.5 text-label text-text-primary disabled:text-text-disabled"
                    >
                        {!options.some((o) => o.value === value) && <option value={value}>Value {value}</option>}
                        {options.map((o) => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                    </select>
                ) : (
                    <>
                        <input
                            type="number"
                            value={draft}
                            disabled={pending}
                            step={def?.increment ?? 10 ** -decimals}
                            min={def?.range?.[0]}
                            max={def?.range?.[1]}
                            onFocus={() => setEditing(true)}
                            onChange={(e) => setDraft(e.target.value)}
                            onBlur={commit}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                    e.preventDefault();
                                    e.currentTarget.blur();
                                }
                            }}
                            className="h-control-sm w-24 shrink-0 border border-border-subtle bg-background px-1.5 font-mono text-label text-text-primary focus-visible:outline-none disabled:text-text-disabled"
                        />
                        <span className="shrink-0 text-label text-text-helper">{unitLabel(def)}</span>
                    </>
                )}
                {pending && <span className="shrink-0 text-micro text-text-helper">…</span>}
                {ok && <span className="shrink-0 text-micro text-state-ok">Set</span>}
                {error && <span className="min-w-0 truncate text-micro text-state-danger" title={error}>{error}</span>}
            </div>
        </div>
    );
}

function ParamSection({ctx, title, rows}: {ctx: ParamContext; title: string; rows: RowSpec[]}) {
    const present = rows.filter((row) => ctx.live.has(row.name));
    if (present.length === 0) return null;
    return (
        <section className="flex flex-col gap-2">
            <h3 className="text-label uppercase text-text-helper">{title}</h3>
            <div className="border-t border-border-subtle">
                {present.map((row) => (
                    <ParamRow key={row.name} ctx={ctx} spec={row}/>
                ))}
            </div>
        </section>
    );
}

function Segmented<T extends string>({value, options, onChange}: {value: T; options: {value: T; label: string}[]; onChange: (next: T) => void}) {
    return (
        <div className="flex border border-border-subtle">
            {options.map((o) => (
                <button
                    key={o.value}
                    type="button"
                    aria-pressed={o.value === value}
                    onClick={() => onChange(o.value)}
                    className={`h-control-sm px-3 text-label ${
                        o.value === value ? "bg-layer-02 text-text-primary" : "text-text-secondary hover:bg-layer-hover-01"
                    }`}
                >
                    {o.label}
                </button>
            ))}
        </div>
    );
}

// ── Per-output rows ────────────────────────────────────────────────────────

interface OutputRowProps {
    ctx: ParamContext;
    output: MotorOutput;
    range: [number, number];
    /** Show Min/Trim/Max/Rev columns — at least one output uses them. */
    servoColumns: boolean;
    /** Show the DShot spin-direction column. */
    spinColumn: boolean;
}

function outputGrid(servoColumns: boolean, spinColumn: boolean): string {
    if (servoColumns && spinColumn) return "grid-cols-[3rem_8rem_minmax(0,1fr)_2.5rem_5rem]";
    if (servoColumns) return "grid-cols-[3rem_8rem_minmax(0,1fr)_2.5rem]";
    if (spinColumn) return "grid-cols-[3rem_8rem_5rem]";
    return "grid-cols-[3rem_8rem]";
}

function OutputRow({ctx, output, range, servoColumns, spinColumn}: OutputRowProps) {
    const {pending, error, write} = useParamWrite(ctx);
    const n = output.channel;
    const f = output.servoFields;
    const field = (name: "MIN" | "TRIM" | "MAX") => ctx.live.get(`SERVO${n}_${name}`)?.value;
    const commit = (name: "MIN" | "TRIM" | "MAX") => (value: number) => write(`SERVO${n}_${name}`, value);
    const spinMask = ctx.live.get("SERVO_BLH_RVMASK")?.value ?? 0;
    const anyServoField = f.min || f.trim || f.max || f.reversed;

    return (
        <div className={`grid ${outputGrid(servoColumns, spinColumn)} items-center gap-3 border-b border-border-subtle-base px-2 py-1.5 last:border-b-0`}>
            <span className="font-mono text-label text-text-secondary">{n}</span>
            <span className="text-label text-text-primary">{output.label}</span>
            {servoColumns && (
                anyServoField ? (
                    <>
                        <div className="grid grid-cols-3 gap-2">
                            {f.min ? <RangeNumberInput value={field("MIN")} range={range} disabled={pending} onCommit={commit("MIN")}/> : <span/>}
                            {f.trim ? <RangeNumberInput value={field("TRIM")} range={range} disabled={pending} onCommit={commit("TRIM")}/> : <span/>}
                            {f.max ? <RangeNumberInput value={field("MAX")} range={range} disabled={pending} onCommit={commit("MAX")}/> : <span/>}
                        </div>
                        {f.reversed ? (
                            <ReverseToggle
                                checked={ctx.live.get(`SERVO${n}_REVERSED`)?.value === 1}
                                disabled={pending || !ctx.live.has(`SERVO${n}_REVERSED`)}
                                onChange={(next) => void write(`SERVO${n}_REVERSED`, next ? 1 : 0)}
                            />
                        ) : <span/>}
                    </>
                ) : (
                    <span className="col-span-2 font-mono text-label text-text-helper">{output.digital ? "DShot 1000–2000" : "—"}</span>
                )
            )}
            {spinColumn && (
                output.digital ? (
                    <ReverseToggle
                        checked={hasBit(spinMask, n - 1)}
                        disabled={pending}
                        onChange={(next) => void write("SERVO_BLH_RVMASK", withBit(spinMask, n - 1, next))}
                    />
                ) : <span/>
            )}
            {error && <span className="col-span-full text-micro text-state-danger">{error}</span>}
        </div>
    );
}

function OutputTable({ctx, outputs, range}: {ctx: ParamContext; outputs: MotorOutput[]; range: [number, number]}) {
    const servoColumns = outputs.some((o) => o.servoFields.min || o.servoFields.max || o.servoFields.trim || o.servoFields.reversed);
    const showTrim = outputs.some((o) => o.servoFields.trim);
    const spinColumn = ctx.live.has("SERVO_BLH_RVMASK") && outputs.some((o) => o.digital && o.source === "multirotor");

    return (
        <section className="flex flex-col gap-2">
            <div className={`grid ${outputGrid(servoColumns, spinColumn)} gap-3 px-2 text-micro uppercase text-text-helper`}>
                <span>Out</span>
                <span>Drives</span>
                {servoColumns && (
                    <>
                        <div className="grid grid-cols-3 gap-2">
                            <span>Min</span>
                            <span>{showTrim ? "Trim" : ""}</span>
                            <span>Max</span>
                        </div>
                        <span>Rev</span>
                    </>
                )}
                {spinColumn && <span>Spin rev</span>}
            </div>
            <div className="border-t border-border-subtle">
                {outputs.map((output) => (
                    <OutputRow key={output.channel} ctx={ctx} output={output} range={range} servoColumns={servoColumns} spinColumn={spinColumn}/>
                ))}
            </div>
        </section>
    );
}

/** An output's own `SERVOx_MIN/TRIM/MAX/REVERSED`. */
function outputRange(ctx: ParamContext, channel: number): ServoRange {
    return {
        min: liveValue(ctx, `SERVO${channel}_MIN`, 1100),
        trim: liveValue(ctx, `SERVO${channel}_TRIM`, 1500),
        max: liveValue(ctx, `SERVO${channel}_MAX`, 1900),
        reversed: ctx.live.get(`SERVO${channel}_REVERSED`)?.value === 1,
    };
}

/** Picks which output's own range the chart draws, when outputs differ. */
function OutputPicker({outputs, value, onChange}: {outputs: MotorOutput[]; value: number; onChange: (channel: number) => void}) {
    return (
        <select
            value={value}
            onChange={(e) => onChange(Number(e.target.value))}
            className="h-control-sm border border-border-subtle bg-background px-1.5 text-label text-text-primary"
        >
            {outputs.map((o) => (
                <option key={o.channel} value={o.channel}>Output {o.channel} · {o.label}</option>
            ))}
        </select>
    );
}

// ── Multirotor motors (MOT_ / Q_M_) ────────────────────────────────────────

type CurveInput = "stick" | "thrust";

/** The RC input channel number `RCMAP_THROTTLE` points at. */
function throttleChannel(ctx: ParamContext): number {
    return Math.round(liveValue(ctx, "RCMAP_THROTTLE", 3));
}

function rcThrottle(ctx: ParamContext): RcThrottle {
    const n = throttleChannel(ctx);
    return {
        min: liveValue(ctx, `RC${n}_MIN`, 1100),
        max: liveValue(ctx, `RC${n}_MAX`, 1900),
        deadZone: liveValue(ctx, `RC${n}_DZ`, 30),
    };
}

/**
 * The motor mixer's whole output path in one place: thrust → actuator via
 * `THST_EXPO` and the spin points, actuator → PWM via `PWM_MIN/MAX` (fixed
 * 1000–2000 for DShot and PWMRange/PWMAngle), and — for the Stick view — the
 * pilot's stick → thrust curve that puts mid stick on hover in Stabilize
 * (QStabilize on a QuadPlane). Thrust is what every other mode commands.
 * Under PWMRange/PWMAngle the 1000–2000 command then goes through each
 * output's own SERVOx range, so the chart draws one output at a time.
 */
function MultirotorBlock({ctx, config, outputs, servoRange}: {ctx: ParamContext; config: MultirotorConfig; outputs: MotorOutput[]; servoRange: [number, number]}) {
    const [input, setInput] = useState<CurveInput>("stick");
    const [chartChannel, setChartChannel] = useState<number | null>(null);
    const P = config.prefix;
    const pwmType = Math.round(liveValue(ctx, `${P}PWM_TYPE`, 0));
    const digital = isDshotType(pwmType);
    const fixedRange = digital || pwmType === PWM_TYPE_RANGE || pwmType === PWM_TYPE_ANGLE;
    const rawPwmMin = liveValue(ctx, `${P}PWM_MIN`, 1000);
    const rawPwmMax = liveValue(ctx, `${P}PWM_MAX`, 2000);

    const params: MotorCurveParams = {
        pwmMin: fixedRange ? 1000 : rawPwmMin,
        pwmMax: fixedRange ? 2000 : rawPwmMax,
        spinMin: liveValue(ctx, `${P}SPIN_MIN`, 0.15),
        spinMax: liveValue(ctx, `${P}SPIN_MAX`, 0.95),
        thrustExpo: liveValue(ctx, `${P}THST_EXPO`, 0.65),
    };
    const spinArm = liveValue(ctx, `${P}SPIN_ARM`, 0.1);
    const hover = liveValue(ctx, `${P}THST_HOVER`, 0.35);
    const rc = rcThrottle(ctx);
    const stickExpo = liveValue(ctx, "Q_THROTTLE_EXPO", 0.2);
    const stickToThrust = (stick: number) =>
        P === "MOT_" ? copterStickThrottle(stick, rc, hover) : quadplaneStickThrottle(stick, rc, hover, stickExpo);

    const scaledOutputs = outputs.filter((o) => o.servoFields.min);
    const chartOutput = scaledOutputs.find((o) => o.channel === chartChannel) ?? scaledOutputs[0];
    const range = chartOutput ? outputRange(ctx, chartOutput.channel) : null;
    const toOutput = (command: number) => {
        if (!range) return command;
        return pwmType === PWM_TYPE_ANGLE
            ? servoOutputPwm((command - 1500) / 5, range, true)
            : servoOutputPwm((command - 1000) / 10, range, false);
    };

    const curve = (x: number) => toOutput(thrustToPwm(input === "stick" ? stickToThrust(x / 100) : x / 100, params));
    const lines: ChartLine[] = [
        {y: toOutput(actuatorToPwm(params.spinMax, params)), label: "Spin max"},
        {y: toOutput(actuatorToPwm(params.spinMin, params)), label: "Spin min"},
        {y: toOutput(actuatorToPwm(spinArm, params)), label: "Armed idle"},
    ];
    const points: ChartPoint[] = [
        input === "stick" ? {x: 50, y: curve(50), label: "Hover"} : {x: hover * 100, y: toOutput(thrustToPwm(hover, params)), label: "Hover"},
    ];
    const lo = range ? Math.min(range.min, range.max) : params.pwmMin;
    const hi = range ? Math.max(range.min, range.max) : params.pwmMax;
    const pad = (hi - lo) * 0.04 || 20;

    const pwmWarning = !fixedRange && (rawPwmMin < 1 || rawPwmMin >= rawPwmMax) ? "Must be below PWM max — arming blocked" : null;
    const spinMinWarning = params.spinMin > 0.3 ? "Above 0.3 — arming blocked" : null;
    const spinArmWarning = spinArm > params.spinMin ? "Above spin min — arming blocked" : null;

    const outputRows: RowSpec[] = [
        {name: `${P}PWM_TYPE`, label: "Output type"},
        ...(fixedRange ? [] : [
            {name: `${P}PWM_MIN`, label: "PWM min", decimals: 0, warning: pwmWarning},
            {name: `${P}PWM_MAX`, label: "PWM max", decimals: 0},
        ]),
        ...(digital
            ? [
                {name: "SERVO_DSHOT_RATE", label: "DShot rate", decimals: 0},
                {name: "SERVO_DSHOT_ESC", label: "DShot ESC type", decimals: 0},
            ]
            : [{name: config.speedParam, label: "Update rate", decimals: 0}]),
    ];
    const safeDisarm = liveValue(ctx, `${P}SAFE_DISARM`, 0) === 1;

    return (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_28rem]">
            <div className="flex min-w-0 flex-col gap-4">
                <div className="flex flex-col gap-2 bg-layer-01 p-3">
                    <div className="flex justify-end gap-2">
                        {chartOutput && scaledOutputs.length > 1 && (
                            <OutputPicker outputs={scaledOutputs} value={chartOutput.channel} onChange={setChartChannel}/>
                        )}
                        <Segmented
                            value={input}
                            options={[{value: "stick", label: "Stick"}, {value: "thrust", label: "Thrust"}]}
                            onChange={setInput}
                        />
                    </div>
                    <MotorCurveChart
                        xDomain={[0, 100]}
                        xTicks={[0, 25, 50, 75, 100]}
                        xLabel={input === "stick" ? "Throttle stick" : "Thrust demand"}
                        formatX={(x) => `${Math.round(x)}%`}
                        yDomain={[lo - pad, hi + pad]}
                        curve={curve}
                        lines={lines}
                        points={points}
                    />
                </div>
                {outputs.length > 0 && <OutputTable ctx={ctx} outputs={outputs} range={servoRange}/>}
            </div>
            <div className="flex flex-col gap-6">
                <ParamSection ctx={ctx} title="Output" rows={outputRows}/>
                <ParamSection
                    ctx={ctx}
                    title="Spin"
                    rows={[
                        {name: `${P}SPIN_ARM`, label: "Armed idle", warning: spinArmWarning},
                        {name: `${P}SPIN_MIN`, label: "Spin min", warning: spinMinWarning},
                        {name: `${P}SPIN_MAX`, label: "Spin max"},
                    ]}
                />
                <ParamSection
                    ctx={ctx}
                    title="Thrust"
                    rows={[
                        {name: `${P}THST_EXPO`, label: "Thrust expo", decimals: 2},
                        {name: `${P}THST_HOVER`, label: "Hover thrust", decimals: 3},
                        {name: `${P}HOVER_LEARN`, label: "Learn hover"},
                    ]}
                />
                <ParamSection
                    ctx={ctx}
                    title="Stick"
                    rows={[
                        {name: `RC${throttleChannel(ctx)}_DZ`, label: "Dead zone", decimals: 0},
                        ...(P === "Q_M_" ? [{name: "Q_THROTTLE_EXPO", label: "Stick expo", decimals: 2}] : []),
                    ]}
                />
                <ParamSection
                    ctx={ctx}
                    title="Spool"
                    rows={[
                        {name: `${P}SPOOL_TIME`, label: "Spool up"},
                        {name: `${P}SPOOL_TIM_DN`, label: "Spool down"},
                        {name: `${P}SAFE_DISARM`, label: "Output when disarmed"},
                        ...(safeDisarm ? [{name: `${P}SAFE_TIME`, label: "Re-enable delay"}] : []),
                        {name: `${P}IDLE_SEC`, label: "Idle delay", decimals: 1},
                    ]}
                />
                <ParamSection
                    ctx={ctx}
                    title="Battery"
                    rows={[
                        {name: `${P}BAT_VOLT_MAX`, label: "Max voltage", decimals: 1},
                        {name: `${P}BAT_VOLT_MIN`, label: "Min voltage", decimals: 1},
                        {name: `${P}BAT_CURR_MAX`, label: "Current limit", decimals: 1},
                        {name: `${P}BAT_CURR_TC`, label: "Current limit time", decimals: 2},
                        {name: `${P}BAT_IDX`, label: "Battery"},
                    ]}
                />
                <ParamSection
                    ctx={ctx}
                    title="Advanced"
                    rows={[
                        {name: `${P}YAW_HEADROOM`, label: "Yaw headroom", decimals: 0},
                        {name: `${P}SLEW_UP_TIME`, label: "Slew up", decimals: 3},
                        {name: `${P}SLEW_DN_TIME`, label: "Slew down", decimals: 3},
                    ]}
                />
            </div>
        </div>
    );
}

// ── Plane fixed-wing throttle ──────────────────────────────────────────────

/** The range ArduPilot actually uses for a throttle output: its own SERVOx
 * params, or 1000–2000 (trim 1500 if 3D) once it's DShot. */
function throttleRange(ctx: ParamContext, output: MotorOutput): ServoRange {
    const range = outputRange(ctx, output.channel);
    if (!output.digital) return range;
    const threeD = hasBit(liveValue(ctx, "SERVO_BLH_3DMASK", 0), output.channel - 1);
    return {min: 1000, trim: threeD ? 1500 : 1000, max: 2000, reversed: range.reversed};
}

/**
 * Plane's forward throttle has no motor curve: the throttle percentage maps
 * straight onto the output's own MIN/MAX (around TRIM once `THR_MIN` is
 * negative). Manual passes the stick through; every other mode clamps it to
 * `THR_MIN`/`THR_MAX`, drawn as the reference lines.
 */
function ThrottleBlock({ctx, outputs, servoRange}: {ctx: ParamContext; outputs: MotorOutput[]; servoRange: [number, number]}) {
    const [selected, setSelected] = useState<number | null>(null);
    const output = outputs.find((o) => o.channel === selected) ?? outputs[0];
    const thrMin = liveValue(ctx, "THR_MIN", 0);
    const thrMax = liveValue(ctx, "THR_MAX", 100);
    const cruise = liveValue(ctx, "TRIM_THROTTLE", 45);
    const reverseThrust = thrMin < 0;

    const rows: RowSpec[] = [
        {name: "THR_MIN", label: "Min throttle", decimals: 0},
        {name: "THR_MAX", label: "Max throttle", decimals: 0},
        {name: "TRIM_THROTTLE", label: "Cruise throttle", decimals: 0},
        {name: "TKOFF_THR_MAX", label: "Takeoff max", decimals: 0},
        {name: "THR_SLEWRATE", label: "Slew rate", decimals: 0},
        {name: "THR_PASS_STAB", label: "Passthrough in stabilized modes"},
        {name: "FWD_BAT_VOLT_MAX", label: "Battery comp max voltage", decimals: 1},
        {name: "FWD_BAT_VOLT_MIN", label: "Battery comp min voltage", decimals: 1},
    ];

    let chart: React.ReactNode = null;
    if (output) {
        const range = throttleRange(ctx, output);
        const curve = (x: number) => servoOutputPwm(x, range, reverseThrust);
        const lines: ChartLine[] = [{y: curve(thrMax), label: "Max"}];
        if (thrMin !== 0) lines.push({y: curve(thrMin), label: "Min"});
        const lo = Math.min(range.min, range.max);
        const hi = Math.max(range.min, range.max);
        const pad = (hi - lo) * 0.04 || 20;
        chart = (
            <div className="flex flex-col gap-2 bg-layer-01 p-3">
                {outputs.length > 1 && (
                    <div className="flex justify-end">
                        <Segmented
                            value={String(output.channel)}
                            options={outputs.map((o) => ({value: String(o.channel), label: `${o.channel} · ${o.label}`}))}
                            onChange={(v) => setSelected(Number(v))}
                        />
                    </div>
                )}
                <MotorCurveChart
                    xDomain={reverseThrust ? [-100, 100] : [0, 100]}
                    xTicks={reverseThrust ? [-100, -50, 0, 50, 100] : [0, 25, 50, 75, 100]}
                    xLabel="Throttle input"
                    formatX={(x) => `${Math.round(x)}%`}
                    yDomain={[lo - pad, hi + pad]}
                    curve={curve}
                    lines={lines}
                    points={[{x: cruise, y: curve(cruise), label: "Cruise"}]}
                />
            </div>
        );
    }

    return (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_28rem]">
            <div className="flex min-w-0 flex-col gap-4">
                {chart}
                {outputs.length > 0 ? (
                    <OutputTable ctx={ctx} outputs={outputs} range={servoRange}/>
                ) : (
                    <p className="text-label text-text-helper">No output is set to Throttle.</p>
                )}
            </div>
            <div className="flex flex-col gap-6">
                <ParamSection ctx={ctx} title="Throttle" rows={rows}/>
            </div>
        </div>
    );
}

// ── Panel ──────────────────────────────────────────────────────────────────

/**
 * Motor setup, the counterpart to Servo setup's output list: the params that
 * actually set a motor's output range, with a curve of the PWM the firmware
 * will send for each input. Copter shows its `MOT_` motors; Plane shows
 * fixed-wing throttle, plus a QuadPlane's `Q_M_` lift motors when
 * `Q_ENABLE` is on. Output Min/Trim/Max/Rev appear here only where the
 * firmware reads them for that output — see motorOutputs.ts.
 */
export default function MotorsSetupPanel({live, onSet, firmware}: MotorsSetupPanelProps) {
    const reboot = useReboot();
    const sheetState = useParamSheet(firmware);
    const [rebootNeeded, setRebootNeeded] = useState(false);

    const defs = useMemo(() => {
        const map = new Map<string, ParamDef>();
        if (sheetState.status === "ready") {
            for (const group of sheetState.sheet.groups) {
                for (const param of group.params) map.set(param.name, param);
            }
        }
        return map;
    }, [sheetState]);

    const ctx: ParamContext = {live, onSet, defs, onRebootNeeded: () => setRebootNeeded(true)};
    const servoRange: [number, number] = defs.get("SERVO1_MIN")?.range ?? DEFAULT_SERVO_RANGE;
    const outputs = findMotorOutputs(firmware, live, defs.get("SERVO1_FUNCTION")?.values ?? [], SERVO_COUNT);
    const multi = multirotorConfig(firmware, live);
    const motorOutputs = outputs.filter((o) => o.source === "multirotor");
    const throttleOutputs = outputs.filter((o) => o.source === "throttle");

    return (
        <div className="flex w-full flex-col gap-6">
            <h1 className="text-heading text-text-primary">Motors</h1>

            {sheetState.status === "loading" && (
                <p className="text-label text-text-helper">Loading {firmware} parameter reference…</p>
            )}
            {sheetState.status === "error" && <p className="text-label text-state-danger">{sheetState.message}</p>}

            {rebootNeeded && (
                <div className="flex items-center gap-2 border border-state-warn/40 bg-layer-01 px-3 py-2 text-label">
                    <span className="text-state-warn">This change only takes effect after a reboot.</span>
                    <button
                        type="button"
                        onClick={() => void reboot.reboot()}
                        disabled={reboot.pending}
                        className="text-state-info underline disabled:text-text-disabled"
                    >
                        {reboot.pending ? "Rebooting…" : "Reboot the vehicle"}
                    </button>
                    {reboot.error && <span className="text-state-danger">{reboot.error}</span>}
                </div>
            )}

            {firmware === "ArduPlane" && (
                <section className="flex flex-col gap-3">
                    <h2 className="text-heading text-text-primary">Forward throttle</h2>
                    <ThrottleBlock ctx={ctx} outputs={throttleOutputs} servoRange={servoRange}/>
                </section>
            )}

            {multi ? (
                <section className="flex flex-col gap-3">
                    {firmware === "ArduPlane" && <h2 className="text-heading text-text-primary">VTOL motors</h2>}
                    <MultirotorBlock ctx={ctx} config={multi} outputs={motorOutputs} servoRange={servoRange}/>
                </section>
            ) : firmware === "ArduCopter" && live.size > 0 ? (
                <p className="text-label text-text-helper">This vehicle reports no MOT_ parameters.</p>
            ) : null}
        </div>
    );
}
