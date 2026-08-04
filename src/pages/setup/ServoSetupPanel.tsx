import {useEffect, useMemo, useState} from "react";
import {sendVehicleCommand} from "@/lib/vehicle/commands.ts";
import {LiveParamEntry} from "@/lib/params/liveParams.ts";
import {useParamSheet} from "@/lib/params/useParamSheet.ts";
import {ParamDef, ParamOption, VehicleFirmware} from "@/lib/params/paramSheet.ts";
import SERVO_FUNCTION_PRIORITY from "@/lib/params/servoFunctionPriority.json";

/**
 * ArduPilot's own pdef lists `SERVOx_FUNCTION` alphabetically by label, which
 * buries the functions an operator reaches for constantly (`Throttle` sits
 * around index 70+ alphabetically) under a wall of `Camera*`/`RCIN*`/
 * `Script*` entries most setups never touch. `servoFunctionPriority.json` is
 * a hand-picked order of function *values* — not labels — because the
 * underlying enum is shared across every ArduPilot vehicle type (confirmed:
 * `Motor1`/`Gripper`/etc. carry the same int on Copter and Plane); a value
 * this list names that the connected vehicle's own function list doesn't
 * have (e.g. `Aileron` on a Copter) is silently skipped rather than erroring,
 * so one list works for every vehicle type without per-firmware branches.
 * Everything the list doesn't mention follows after, natural-sorted the same
 * way the old pure-alphabetical order was (fixes `Motor2` sorting before
 * `Motor10` as a plain string).
 */
function sortFunctionOptions(options: ParamOption[]): ParamOption[] {
    const byValue = new Map(options.map((option) => [option.value, option]));
    const seen = new Set<number>();
    const pinned: ParamOption[] = [];
    for (const {value} of SERVO_FUNCTION_PRIORITY) {
        const option = byValue.get(value);
        if (option) {
            pinned.push(option);
            seen.add(value);
        }
    }
    const rest = options
        .filter((option) => !seen.has(option.value))
        .sort((a, b) => a.label.localeCompare(b.label, undefined, {numeric: true}));
    return [...pinned, ...rest];
}

interface ServoSetupPanelProps {
    live: Map<string, LiveParamEntry>;
    onSet: (name: string, value: number) => Promise<number>;
    firmware: VehicleFirmware;
}

/** ArduPilot supports up to 32 servo outputs — most boards only populate the
 * first 8-16 by default, but every channel is shown regardless, the same way
 * the vehicle itself accepts `SERVO17_FUNCTION` etc. whether or not anything
 * is plugged into that output. */
const SERVO_COUNT = 32;

/** ArduPilot's own documented range for `SERVOx_MIN/TRIM/MAX` — used as the
 * fallback min/max on the number inputs when the param sheet hasn't loaded. */
const DEFAULT_RANGE: [number, number] = [800, 2200];

/** Coarser than the default step of 1 — these are PWM microseconds, and
 * nudging by 1 at a time is never what a hand on the spinner arrows wants. */
const RANGE_STEP = 50;

/** #, Function, Rev, then Min/Trim/Max sharing the last column — the range
 * inputs get the majority of the row's width since they're the thing this
 * table is actually for editing precisely, not the function picker. */
const ROW_GRID = "grid-cols-[3rem_16rem_2.5rem_1fr]";

function findParam(groups: {params: ParamDef[]}[], name: string): ParamDef | null {
    for (const group of groups) {
        const found = group.params.find((p) => p.name === name);
        if (found) return found;
    }
    return null;
}

function ReverseToggle({checked, disabled, onChange}: {checked: boolean; disabled: boolean; onChange: (next: boolean) => void}) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            disabled={disabled}
            title={checked ? "Reversed" : "Normal"}
            onClick={() => onChange(!checked)}
            className={[
                "relative h-5 w-9 shrink-0 border transition-colors duration-100",
                checked ? "border-blue-60 bg-blue-60" : "border-border-subtle bg-layer-02",
                disabled ? "opacity-50" : "",
            ].join(" ")}
        >
            <span
                className={[
                    "absolute top-0.5 h-3.5 w-3.5 bg-background transition-[left] duration-100",
                    // `calc(100% - 1rem)` = track width minus (knob width
                    // 0.875rem + the same 0.125rem gap `left-0.5` uses) — a
                    // fixed `left-4` looked close but wasn't actually the
                    // mirror of the off position, so the gap wasn't even.
                    checked ? "left-[calc(100%-1rem)]" : "left-0.5",
                ].join(" ")}
            />
        </button>
    );
}

interface RangeNumberInputProps {
    value: number | undefined;
    disabled: boolean;
    range: [number, number];
    onCommit: (value: number) => Promise<void>;
}

/**
 * A plain number input rather than a draggable range line — precise entry
 * (typing an exact PWM value) matters more here than a visual sense of where
 * trim sits, and 32 rows of draggable pointers would be fiddly to hit
 * accurately anyway. Committed on blur/Enter rather than on every keystroke,
 * same reasoning as `ParametersPage`'s manual value input; `editing` keeps a
 * value arriving from the vehicle mid-type from clobbering what's being typed.
 */
function RangeNumberInput({value, disabled, range, onCommit}: RangeNumberInputProps) {
    const [draft, setDraft] = useState(value !== undefined ? String(Math.round(value)) : "");
    const [editing, setEditing] = useState(false);

    useEffect(() => {
        if (!editing) {
            setDraft(value !== undefined ? String(Math.round(value)) : "");
        }
    }, [value, editing]);

    const commit = async () => {
        setEditing(false);
        if (draft.trim() === "") {
            return;
        }
        const num = Number(draft);
        if (Number.isNaN(num) || num === value) {
            return;
        }
        await onCommit(num);
    };

    return (
        <input
            type="number"
            value={draft}
            disabled={disabled}
            step={RANGE_STEP}
            min={range[0]}
            max={range[1]}
            placeholder={value === undefined ? "—" : undefined}
            onFocus={() => setEditing(true)}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => void commit()}
            onKeyDown={(event) => {
                if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                }
            }}
            className="h-control-sm w-full min-w-0 border border-border-subtle bg-background px-1.5 font-mono text-label text-text-primary placeholder:text-text-disabled focus-visible:outline-none disabled:text-text-disabled"
        />
    );
}

interface ServoRowProps {
    channel: number;
    live: Map<string, LiveParamEntry>;
    onSet: (name: string, value: number) => Promise<number>;
    functionOptions: ParamOption[];
    range: [number, number];
    onFunctionChanged: () => void;
}

type PendingField = "function" | "reversed" | "min" | "trim" | "max" | null;

function ServoRow({channel, live, onSet, functionOptions, range, onFunctionChanged}: ServoRowProps) {
    const [pendingField, setPendingField] = useState<PendingField>(null);
    const [error, setError] = useState<string | null>(null);

    const functionEntry = live.get(`SERVO${channel}_FUNCTION`);
    const reversedEntry = live.get(`SERVO${channel}_REVERSED`);
    const min = live.get(`SERVO${channel}_MIN`)?.value;
    const trim = live.get(`SERVO${channel}_TRIM`)?.value;
    const max = live.get(`SERVO${channel}_MAX`)?.value;

    const functionValue = functionEntry ? String(Math.round(functionEntry.value)) : "";
    const reversed = reversedEntry?.value === 1;

    const handleFunctionChange = async (value: string) => {
        if (value === "") return;
        setPendingField("function");
        setError(null);
        try {
            await onSet(`SERVO${channel}_FUNCTION`, Number(value));
            onFunctionChanged();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setPendingField(null);
        }
    };

    const handleReversedChange = async (next: boolean) => {
        setPendingField("reversed");
        setError(null);
        try {
            await onSet(`SERVO${channel}_REVERSED`, next ? 1 : 0);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setPendingField(null);
        }
    };

    const handleRangeCommit = (field: "min" | "trim" | "max") => async (value: number) => {
        setPendingField(field);
        setError(null);
        try {
            await onSet(`SERVO${channel}_${field.toUpperCase()}`, value);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setPendingField(null);
        }
    };

    return (
        <div className={`grid ${ROW_GRID} items-center gap-3 border-b border-border-subtle-base px-2 py-1.5`}>
            <span className="font-mono text-label text-text-secondary">{channel}</span>
            <select
                value={functionValue}
                disabled={pendingField !== null}
                onChange={(event) => void handleFunctionChange(event.target.value)}
                className="h-control-sm w-full border border-border-subtle bg-background px-2 text-body text-text-primary focus-visible:outline-none disabled:text-text-disabled"
            >
                <option value="" disabled>
                    {functionEntry ? "— unrecognized value —" : "— not read yet —"}
                </option>
                {functionOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                        {option.label}
                    </option>
                ))}
            </select>
            <ReverseToggle checked={reversed} disabled={pendingField !== null || !reversedEntry} onChange={(next) => void handleReversedChange(next)}/>
            <div className="grid grid-cols-3 gap-2">
                <RangeNumberInput value={min} range={range} disabled={pendingField !== null} onCommit={handleRangeCommit("min")}/>
                <RangeNumberInput value={trim} range={range} disabled={pendingField !== null} onCommit={handleRangeCommit("trim")}/>
                <RangeNumberInput value={max} range={range} disabled={pendingField !== null} onCommit={handleRangeCommit("max")}/>
            </div>
            {error && <span className="col-span-4 text-micro text-state-danger">{error}</span>}
        </div>
    );
}

/**
 * `SERVOx_FUNCTION`/`SERVOx_REVERSED`/`SERVOx_MIN`/`SERVOx_TRIM`/`SERVOx_MAX`
 * for every output channel (1-32) as one table, rather than 32 separate
 * `Parameters` group visits. Every field commits immediately (Function and
 * Reversed on change, the range inputs on blur/Enter) — there's no per-row
 * "Set" button, unlike `ParametersPage`'s general-purpose control.
 */
export default function ServoSetupPanel({live, onSet, firmware}: ServoSetupPanelProps) {
    const sheetState = useParamSheet(firmware);
    const [rebootNeeded, setRebootNeeded] = useState(false);

    const functionParam = sheetState.status === "ready" ? findParam(sheetState.sheet.groups, "SERVO1_FUNCTION") : null;
    const minParam = sheetState.status === "ready" ? findParam(sheetState.sheet.groups, "SERVO1_MIN") : null;
    const functionOptions = useMemo(() => sortFunctionOptions(functionParam?.values ?? []), [functionParam]);
    const range: [number, number] = minParam?.range ?? DEFAULT_RANGE;

    const channels = useMemo(() => Array.from({length: SERVO_COUNT}, (_, i) => i + 1), []);

    return (
        <div className="flex h-full w-full flex-col gap-4">
            <div>
                <h1 className="text-heading text-text-primary">Servo Setup</h1>
            </div>

            {sheetState.status === "loading" && (
                <p className="text-label text-text-helper">Loading {firmware} parameter reference…</p>
            )}
            {sheetState.status === "error" && <p className="text-label text-state-danger">{sheetState.message}</p>}

            {rebootNeeded && (
                <div className="flex items-center gap-2 border border-state-warn/40 bg-layer-01 px-3 py-2 text-label">
                    <span className="text-state-warn">A function change only takes effect after a reboot.</span>
                    <button
                        type="button"
                        onClick={() => void sendVehicleCommand({type: "reboot"})}
                        className="text-state-info underline"
                    >
                        Reboot the vehicle
                    </button>
                </div>
            )}

            <div className={`grid ${ROW_GRID} gap-3 px-2 text-micro text-text-helper uppercase`}>
                <span>#</span>
                <span>Function</span>
                <span>Rev</span>
                <div className="grid grid-cols-3 gap-2">
                    <span>Min</span>
                    <span>Trim</span>
                    <span>Max</span>
                </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto border-t border-border-subtle">
                {channels.map((channel) => (
                    <ServoRow
                        key={channel}
                        channel={channel}
                        live={live}
                        onSet={onSet}
                        functionOptions={functionOptions}
                        range={range}
                        onFunctionChanged={() => setRebootNeeded(true)}
                    />
                ))}
            </div>
        </div>
    );
}
