import {useEffect, useState} from "react";
import {Information} from "@carbon/icons-react";
import {LiveParamEntry} from "@/lib/params/liveParams.ts";
import {VehicleFirmware} from "@/lib/params/paramSheet.ts";

interface TrimSetupPanelProps {
    live: Map<string, LiveParamEntry>;
    onSet: (name: string, value: number) => Promise<number>;
    firmware: VehicleFirmware;
}

const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;

const AHRS_AXES = [
    {label: "Roll", param: "AHRS_TRIM_X"},
    {label: "Pitch", param: "AHRS_TRIM_Y"},
    {label: "Yaw", param: "AHRS_TRIM_Z"},
] as const;

const CHANNEL_COUNT = 16;
const PWM_RANGE: [number, number] = [800, 2200];

type FlightTrimConfig = {
    label: string;
    param: string;
    unit: string;
    min: number;
    max: number;
    step: number;
    decimals: number;
    toDisplay: (raw: number) => number;
    toRaw: (display: number) => number;
};

const FLIGHT_TRIMS: FlightTrimConfig[] = [
    {
        label: "Cruise Throttle",
        param: "TRIM_THROTTLE",
        unit: "%",
        min: 0,
        max: 100,
        step: 1,
        decimals: 0,
        toDisplay: (v) => v,
        toRaw: (v) => v,
    },
    {
        label: "Cruise Pitch",
        param: "TRIM_PITCH_CD",
        unit: "°",
        min: -45,
        max: 45,
        step: 0.1,
        decimals: 1,
        toDisplay: (v) => v / 100,
        toRaw: (v) => v * 100,
    },
    {
        label: "Cruise Airspeed",
        param: "TRIM_ARSPD_CM",
        unit: "m/s",
        min: 0,
        max: 100,
        step: 0.1,
        decimals: 1,
        toDisplay: (v) => v / 100,
        toRaw: (v) => v * 100,
    },
];

// ── Shared number input ────────────────────────────────────────────────────

interface TrimInputProps {
    value: number | undefined;
    min: number;
    max: number;
    step: number;
    decimals: number;
    disabled: boolean;
    onCommit: (value: number) => Promise<void>;
}

function TrimInput({value, min, max, step, decimals, disabled, onCommit}: TrimInputProps) {
    const [draft, setDraft] = useState(value !== undefined ? value.toFixed(decimals) : "");
    const [editing, setEditing] = useState(false);

    useEffect(() => {
        if (!editing) {
            setDraft(value !== undefined ? value.toFixed(decimals) : "");
        }
    }, [value, editing, decimals]);

    const commit = async () => {
        setEditing(false);
        const trimmed = draft.trim();
        if (trimmed === "") return;
        const num = Number(trimmed);
        if (Number.isNaN(num) || num === value) return;
        await onCommit(num);
    };

    return (
        <input
            type="number"
            value={draft}
            disabled={disabled}
            step={step}
            min={min}
            max={max}
            placeholder={value === undefined ? "—" : undefined}
            onFocus={() => setEditing(true)}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={(e) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    e.currentTarget.blur();
                }
            }}
            className="h-control-sm w-full min-w-0 border border-border-subtle bg-background px-1.5 font-mono text-label text-text-primary placeholder:text-text-disabled focus-visible:outline-none disabled:text-text-disabled"
        />
    );
}

// ── AHRS trim row (radians ↔ degrees) ──────────────────────────────────────

interface AhrsTrimRowProps {
    label: string;
    param: string;
    live: Map<string, LiveParamEntry>;
    onSet: (name: string, value: number) => Promise<number>;
}

function AhrsTrimRow({label, param, live, onSet}: AhrsTrimRowProps) {
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const entry = live.get(param);
    const displayValue = entry !== undefined ? entry.value * RAD_TO_DEG : undefined;

    const handleCommit = async (deg: number) => {
        setPending(true);
        setError(null);
        try {
            await onSet(param, deg * DEG_TO_RAD);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setPending(false);
        }
    };

    return (
        <div className="grid grid-cols-[5rem_10rem_auto_1fr] items-center gap-3 border-b border-border-subtle-base px-2 py-1.5">
            <span className="text-label text-text-secondary">{label}</span>
            <TrimInput
                value={displayValue}
                min={-10}
                max={10}
                step={0.01}
                decimals={3}
                disabled={pending}
                onCommit={handleCommit}
            />
            <span className="text-label text-text-helper">degrees</span>
            {error && <span className="text-micro text-state-danger">{error}</span>}
        </div>
    );
}

// ── Channel trim row (SERVO / RC) ──────────────────────────────────────────

interface ChannelTrimRowProps {
    prefix: "SERVO" | "RC";
    channel: number;
    live: Map<string, LiveParamEntry>;
    onSet: (name: string, value: number) => Promise<number>;
}

function ChannelTrimRow({prefix, channel, live, onSet}: ChannelTrimRowProps) {
    const paramName = `${prefix}${channel}_TRIM`;
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const entry = live.get(paramName);
    const value = entry?.value;

    const handleCommit = async (v: number) => {
        setPending(true);
        setError(null);
        try {
            await onSet(paramName, v);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setPending(false);
        }
    };

    return (
        <div className="grid grid-cols-[3rem_10rem_auto_1fr] items-center gap-3 border-b border-border-subtle-base px-2 py-1.5">
            <span className="font-mono text-label text-text-secondary">{channel}</span>
            <TrimInput
                value={value}
                min={PWM_RANGE[0]}
                max={PWM_RANGE[1]}
                step={10}
                decimals={0}
                disabled={pending}
                onCommit={handleCommit}
            />
            <span className="text-label text-text-helper">μs</span>
            {error && <span className="text-micro text-state-danger">{error}</span>}
        </div>
    );
}

// ── Flight trim row ────────────────────────────────────────────────────────

interface FlightTrimRowProps extends FlightTrimConfig {
    live: Map<string, LiveParamEntry>;
    onSet: (name: string, value: number) => Promise<number>;
}

function FlightTrimRow({label, param, unit, min, max, step, decimals, toDisplay, toRaw, live, onSet}: FlightTrimRowProps) {
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const entry = live.get(param);
    const displayValue = entry !== undefined ? toDisplay(entry.value) : undefined;

    const handleCommit = async (v: number) => {
        setPending(true);
        setError(null);
        try {
            await onSet(param, toRaw(v));
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setPending(false);
        }
    };

    return (
        <div className="grid grid-cols-[9rem_10rem_auto_1fr] items-center gap-3 border-b border-border-subtle-base px-2 py-1.5">
            <span className="text-label text-text-secondary">{label}</span>
            <TrimInput
                value={displayValue}
                min={min}
                max={max}
                step={step}
                decimals={decimals}
                disabled={pending}
                onCommit={handleCommit}
            />
            <span className="text-label text-text-helper">{unit}</span>
            {error && <span className="text-micro text-state-danger">{error}</span>}
        </div>
    );
}

// ── Panel ──────────────────────────────────────────────────────────────────

export default function TrimSetupPanel({live, onSet, firmware}: TrimSetupPanelProps) {
    const isPlane = firmware === "ArduPlane";
    const channels = Array.from({length: CHANNEL_COUNT}, (_, i) => i + 1);

    return (
        <div className="flex w-full flex-col gap-8">
            <div>
                <h1 className="text-heading text-text-primary">Trim</h1>
                <p className="text-body text-text-secondary">
                    Corrects for physical offsets in the controller mounting or airframe — distinct from PID tuning,
                    which controls how aggressively the controller reacts to errors.
                </p>
            </div>

            <section className="flex flex-col gap-2">
                <div>
                    <h2 className="text-label uppercase text-text-helper">Board Level</h2>
                    <p className="text-label text-text-secondary">
                        Compensates for the flight controller not being mounted perfectly level. Use these if the
                        vehicle consistently rolls or pitches in one direction even with a physically level airframe.
                    </p>
                </div>
                <div className="border-t border-border-subtle">
                    {AHRS_AXES.map(({label, param}) => (
                        <AhrsTrimRow key={param} label={label} param={param} live={live} onSet={onSet} />
                    ))}
                </div>
            </section>

            <section className="flex flex-col gap-2">
                <div>
                    <h2 className="text-label uppercase text-text-helper">Servo Output Trim</h2>
                    <p className="text-label text-text-secondary">
                        The PWM neutral position for each output channel. Adjust if a control surface isn't physically
                        centered at 1500 μs. Min/Max limits are configured in Servo Setup.
                    </p>
                </div>
                <div className="border-t border-border-subtle">
                    {channels.map((ch) => (
                        <ChannelTrimRow key={ch} prefix="SERVO" channel={ch} live={live} onSet={onSet} />
                    ))}
                </div>
            </section>

            <section className="flex flex-col gap-2">
                <div>
                    <h2 className="text-label uppercase text-text-helper">RC Input Trim</h2>
                    <p className="text-label text-text-secondary">
                        The expected center PWM from the transmitter on each channel.
                    </p>
                    <div className="mt-1 flex items-start gap-1.5 text-label text-text-helper">
                        <Information size={16} className="mt-px shrink-0" />
                        <span>
                            These values are written automatically by RC Calibration. It is recommended to run RC
                            Calibration rather than editing them here.
                        </span>
                    </div>
                </div>
                <div className="border-t border-border-subtle">
                    {channels.map((ch) => (
                        <ChannelTrimRow key={ch} prefix="RC" channel={ch} live={live} onSet={onSet} />
                    ))}
                </div>
            </section>

            {isPlane && (
                <section className="flex flex-col gap-2">
                    <div>
                        <h2 className="text-label uppercase text-text-helper">Flight Trim</h2>
                        <p className="text-label text-text-secondary">
                            Target conditions for level cruise flight, used by automatic modes.
                        </p>
                    </div>
                    <div className="border-t border-border-subtle">
                        {FLIGHT_TRIMS.map((config) => (
                            <FlightTrimRow key={config.param} {...config} live={live} onSet={onSet} />
                        ))}
                    </div>
                </section>
            )}
        </div>
    );
}
