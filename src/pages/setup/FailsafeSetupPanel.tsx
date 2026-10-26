import {useEffect, useState} from "react";
import {LiveParamEntry} from "@/lib/params/liveParams.ts";
import {VehicleFirmware} from "@/lib/params/paramSheet.ts";

interface FailsafeSetupPanelProps {
    live: Map<string, LiveParamEntry>;
    onSet: (name: string, value: number) => Promise<number>;
    firmware: VehicleFirmware;
}

interface EnumOption {
    value: number;
    label: string;
}

// ── Shared action enum for most failsafe responses ─────────────────────────

const COPTER_ACTION: EnumOption[] = [
    {value: 0, label: "None — do nothing"},
    {value: 1, label: "Land"},
    {value: 2, label: "RTL — return to launch"},
    {value: 3, label: "SmartRTL"},
    {value: 4, label: "SmartRTL, or Land if no path"},
    {value: 5, label: "Terminate (motors off — dangerous)"},
];

const PLANE_ACTION: EnumOption[] = [
    {value: 0, label: "None — do nothing"},
    {value: 1, label: "RTL — return to launch"},
    {value: 2, label: "Continue with mission"},
    {value: 3, label: "Glide"},
    {value: 4, label: "Loiter"},
];

const RC_ENABLE_COPTER: EnumOption[] = [
    {value: 0, label: "Disabled"},
    {value: 1, label: "Enabled (always)"},
    {value: 2, label: "Enabled (when disarmed only)"},
];

const RC_ENABLE_PLANE: EnumOption[] = [
    {value: 0, label: "Disabled"},
    {value: 1, label: "Enabled"},
];

const GCS_ENABLE: EnumOption[] = [
    {value: 0, label: "Disabled"},
    {value: 1, label: "Enabled"},
    {value: 2, label: "Report only — no action"},
];

const EKF_ACTION: EnumOption[] = [
    {value: 1, label: "Land"},
    {value: 2, label: "AltHold — stop navigating"},
];

const CRASH_CHECK: EnumOption[] = [
    {value: 0, label: "Disabled"},
    {value: 1, label: "Disarm"},
    {value: 2, label: "Disarm + disable motor output"},
];

// ── Row components ─────────────────────────────────────────────────────────

/** The line under a row's label, when there's anything the label can't say. */
function RowHint({description, recommended}: {description?: string; recommended?: string}) {
    const parts = [description, recommended && `Recommended: ${recommended}`].filter(Boolean);
    if (parts.length === 0) return null;
    return <div className="text-micro text-text-helper">{parts.join(" · ")}</div>;
}

interface SelectRowProps {
    label: string;
    description?: string;
    param: string;
    options: EnumOption[];
    recommended?: string;
    live: Map<string, LiveParamEntry>;
    onSet: (name: string, value: number) => Promise<number>;
}

function SelectRow({label, description, param, options, recommended, live, onSet}: SelectRowProps) {
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [ok, setOk] = useState(false);

    const entry = live.get(param);
    const value = entry !== undefined ? Math.round(entry.value) : undefined;

    useEffect(() => {
        if (ok) {
            const t = window.setTimeout(() => setOk(false), 1500);
            return () => window.clearTimeout(t);
        }
    }, [ok]);

    const handleChange = async (next: number) => {
        setPending(true);
        setError(null);
        setOk(false);
        try {
            await onSet(param, next);
            setOk(true);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setPending(false);
        }
    };

    return (
        <div className="grid grid-cols-[1fr_14rem] items-center gap-4 border-b border-border-subtle-base px-2 py-2 last:border-b-0">
            <div>
                <div className="text-label text-text-primary">{label}</div>
                <RowHint description={description} recommended={recommended} />
            </div>
            <div className="flex items-center gap-2">
                <select
                    disabled={pending || value === undefined}
                    value={value ?? ""}
                    onChange={(e) => void handleChange(Number(e.target.value))}
                    className="h-control-sm min-w-0 flex-1 border border-border-subtle bg-background px-1.5 text-label text-text-primary disabled:text-text-disabled"
                >
                    {value === undefined && <option value="">—</option>}
                    {options.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                </select>
                {pending && <span className="shrink-0 text-micro text-text-helper">…</span>}
                {ok && <span className="shrink-0 text-micro text-state-ok">Set</span>}
                {error && <span className="shrink-0 text-micro text-state-danger">{error}</span>}
            </div>
        </div>
    );
}

interface NumberRowProps {
    label: string;
    description?: string;
    param: string;
    unit: string;
    min: number;
    max: number;
    step: number;
    decimals: number;
    recommended?: string;
    live: Map<string, LiveParamEntry>;
    onSet: (name: string, value: number) => Promise<number>;
}

function NumberRow({label, description, param, unit, min, max, step, decimals, recommended, live, onSet}: NumberRowProps) {
    const entry = live.get(param);
    const liveValue = entry?.value;

    const [draft, setDraft] = useState(liveValue !== undefined ? liveValue.toFixed(decimals) : "");
    const [editing, setEditing] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [ok, setOk] = useState(false);

    useEffect(() => {
        if (!editing) setDraft(liveValue !== undefined ? liveValue.toFixed(decimals) : "");
    }, [liveValue, editing, decimals]);

    useEffect(() => {
        if (ok) {
            const t = window.setTimeout(() => setOk(false), 1500);
            return () => window.clearTimeout(t);
        }
    }, [ok]);

    const commit = async () => {
        setEditing(false);
        const num = Number(draft.trim());
        if (!draft.trim() || Number.isNaN(num) || num === liveValue) return;
        setPending(true);
        setError(null);
        setOk(false);
        try {
            await onSet(param, num);
            setOk(true);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setPending(false);
        }
    };

    return (
        <div className="grid grid-cols-[1fr_14rem] items-center gap-4 border-b border-border-subtle-base px-2 py-2 last:border-b-0">
            <div>
                <div className="text-label text-text-primary">{label}</div>
                <RowHint description={description} recommended={recommended} />
            </div>
            <div className="flex items-center gap-2">
                <input
                    type="number"
                    value={draft}
                    disabled={pending}
                    step={step}
                    min={min}
                    max={max}
                    placeholder={liveValue === undefined ? "—" : undefined}
                    onFocus={() => setEditing(true)}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => void commit()}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
                    }}
                    className="h-control-sm w-24 shrink-0 border border-border-subtle bg-background px-1.5 font-mono text-label text-text-primary placeholder:text-text-disabled focus-visible:outline-none disabled:text-text-disabled"
                />
                <span className="shrink-0 text-label text-text-helper">{unit}</span>
                {pending && <span className="shrink-0 text-micro text-text-helper">…</span>}
                {ok && <span className="shrink-0 text-micro text-state-ok">Set</span>}
                {error && <span className="shrink-0 text-micro text-state-danger">{error}</span>}
            </div>
        </div>
    );
}

// ── Section wrapper ────────────────────────────────────────────────────────

function Section({title, description, children}: {title: string; description?: string; children: React.ReactNode}) {
    return (
        <section className="flex flex-col gap-2">
            <div>
                <h2 className="text-label uppercase text-text-helper">{title}</h2>
                {description && <p className="text-label text-text-secondary">{description}</p>}
            </div>
            <div className="border-t border-border-subtle">
                {children}
            </div>
        </section>
    );
}

// ── Panel ──────────────────────────────────────────────────────────────────

export default function FailsafeSetupPanel({live, onSet, firmware}: FailsafeSetupPanelProps) {
    const isCopter = firmware === "ArduCopter";
    const action = isCopter ? COPTER_ACTION : PLANE_ACTION;
    const rcEnableOptions = isCopter ? RC_ENABLE_COPTER : RC_ENABLE_PLANE;
    const rcParam = isCopter ? "FS_THR_ENABLE" : "THR_FAILSAFE";
    const rcThreshParam = isCopter ? "FS_THR_VALUE" : "THR_FS_VALUE";

    return (
        <div className="flex w-full flex-col gap-8">
            <h1 className="text-heading text-text-primary">Failsafe</h1>

            <Section
                title="RC Signal Loss"
            >
                <SelectRow
                    label="Enable"
                    param={rcParam}
                    options={rcEnableOptions}
                    recommended="Enabled (always)"
                    live={live}
                    onSet={onSet}
                />
                <NumberRow
                    label="Threshold"
                    param={rcThreshParam}
                    unit="μs"
                    min={800}
                    max={1100}
                    step={5}
                    decimals={0}
                    recommended="975"
                    live={live}
                    onSet={onSet}
                />
            </Section>

            <Section
                title="Battery — Low"
                description="First warning level. Trigger RTL early enough that the vehicle can make it home. Set the voltage a little above the cell minimum (3.5 V/cell is a common starting point)."
            >
                <SelectRow
                    label="Action"
                    param="BATT_FS_LOW_ACT"
                    options={action}
                    recommended="RTL"
                    live={live}
                    onSet={onSet}
                />
                <NumberRow
                    label="Voltage trigger"
                    description="0 = disabled"
                    param="BATT_LOW_VOLT"
                    unit="V"
                    min={0}
                    max={60}
                    step={0.1}
                    decimals={1}
                    live={live}
                    onSet={onSet}
                />
                <NumberRow
                    label="Consumed trigger"
                    description="0 = disabled"
                    param="BATT_LOW_MAH"
                    unit="mAh"
                    min={0}
                    max={100000}
                    step={50}
                    decimals={0}
                    live={live}
                    onSet={onSet}
                />
            </Section>

            <Section
                title="Battery — Critical"
            >
                <SelectRow
                    label="Action"
                    param="BATT_CRT_ACT"
                    options={action}
                    recommended="Land"
                    live={live}
                    onSet={onSet}
                />
                <NumberRow
                    label="Voltage trigger"
                    description="0 = disabled"
                    param="BATT_CRT_VOLT"
                    unit="V"
                    min={0}
                    max={60}
                    step={0.1}
                    decimals={1}
                    live={live}
                    onSet={onSet}
                />
            </Section>

            <Section
                title="GCS Connection Loss"
                description="Triggered when the vehicle stops hearing from this ground station. Only relevant when flying with a telemetry link — set to Disabled if flying RC-only."
            >
                <SelectRow
                    label="Enable"
                    param="FS_GCS_ENABLE"
                    options={GCS_ENABLE}
                    recommended="Enabled"
                    live={live}
                    onSet={onSet}
                />
            </Section>

            {isCopter && (
                <Section
                    title="EKF / Position Error"
                >
                    <SelectRow
                        label="Action"
                        param="FS_EKF_ACTION"
                        options={EKF_ACTION}
                        recommended="Land"
                        live={live}
                        onSet={onSet}
                    />
                    <NumberRow
                        label="Threshold"
                        param="FS_EKF_THRESH"
                        unit=""
                        min={0.6}
                        max={1.0}
                        step={0.05}
                        decimals={2}
                        recommended="0.8"
                        live={live}
                        onSet={onSet}
                    />
                </Section>
            )}

            {isCopter && (
                <Section
                    title="Crash Detection"
                >
                    <SelectRow
                        label="Action"
                        param="FS_CRASH_CHECK"
                        options={CRASH_CHECK}
                        recommended="Disarm"
                        live={live}
                        onSet={onSet}
                    />
                </Section>
            )}
        </div>
    );
}
