import {useMemo, useState} from "react";
import {useReboot} from "@/lib/vehicle/useReboot.ts";
import {LiveParamEntry} from "@/lib/params/liveParams.ts";
import {useParamSheet} from "@/lib/params/useParamSheet.ts";
import {ParamDef, VehicleFirmware} from "@/lib/params/paramSheet.ts";
import {hasBit, withBit} from "@/lib/params/motorOutputs.ts";
import {ParamContext, ParamRow, RowSpec, useParamWrite} from "./MotorsSetupPanel.tsx";

interface LoggingSetupPanelProps {
    live: Map<string, LiveParamEntry>;
    onSet: (name: string, value: number) => Promise<number>;
    firmware: VehicleFirmware;
}

/**
 * A bitmask param as one tickbox per documented bit, labelled from the param
 * reference. Each tick writes the whole mask with just that bit flipped, so
 * bits the reference doesn't document are carried through untouched.
 */
function BitmaskRow({ctx, spec}: {ctx: ParamContext; spec: RowSpec}) {
    const entry = ctx.live.get(spec.name);
    const bits = ctx.defs.get(spec.name)?.bitmask ?? [];
    const {pending, error, ok, write} = useParamWrite(ctx);
    if (!entry) return null;
    const mask = Math.round(entry.value);

    return (
        <div className="flex flex-col gap-2 border-b border-border-subtle-base px-2 py-2 last:border-b-0">
            <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-label text-text-primary">{spec.label}</span>
                <span className="font-mono text-micro text-text-helper">{spec.name}</span>
                {pending && <span className="text-micro text-text-helper">…</span>}
                {ok && <span className="text-micro text-state-ok">Set</span>}
                {error && <span className="text-micro text-state-danger">{error}</span>}
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-x-4 gap-y-1">
                {bits.map((bit) => (
                    <label key={bit.value} className="flex cursor-pointer items-center gap-2 text-label text-text-primary select-none">
                        <input
                            type="checkbox"
                            checked={hasBit(mask, bit.value)}
                            disabled={pending}
                            onChange={(e) => void write(spec.name, withBit(mask, bit.value, e.target.checked))}
                        />
                        {bit.label}
                    </label>
                ))}
            </div>
        </div>
    );
}

/** Bitmask params get tickboxes; everything else the Motors panel's row
 * (a select when the reference names the values, a number otherwise). */
function LogRow({ctx, spec}: {ctx: ParamContext; spec: RowSpec}) {
    return ctx.defs.get(spec.name)?.bitmask ? <BitmaskRow ctx={ctx} spec={spec}/> : <ParamRow ctx={ctx} spec={spec}/>;
}

function LogSection({ctx, title, rows}: {ctx: ParamContext; title: string; rows: RowSpec[]}) {
    const present = rows.filter((row) => ctx.live.has(row.name));
    if (present.length === 0) return null;
    return (
        <section className="flex flex-col gap-2">
            <h3 className="text-label uppercase text-text-helper">{title}</h3>
            <div className="border-t border-border-subtle">
                {present.map((row) => (
                    <LogRow key={row.name} ctx={ctx} spec={row}/>
                ))}
            </div>
        </section>
    );
}

// Rows the firmware doesn't have (older releases predate the rate limits,
// for one) are skipped by `LogSection`, so one list serves every version.

const CONTENT_ROWS: RowSpec[] = [{name: "LOG_BITMASK", label: "Logged messages"}];

const RATE_ROWS: RowSpec[] = [
    {name: "LOG_FILE_RATEMAX", label: "File rate limit", decimals: 1},
    {name: "LOG_DARM_RATEMAX", label: "File rate limit while disarmed", decimals: 1},
    {name: "LOG_MAV_RATEMAX", label: "MAVLink rate limit", decimals: 1},
    {name: "LOG_BLK_RATEMAX", label: "Block storage rate limit", decimals: 1},
];

const FILE_ROWS: RowSpec[] = [
    {name: "LOG_BACKEND_TYPE", label: "Log to"},
    {name: "LOG_DISARMED", label: "Log while disarmed"},
    {name: "LOG_FILE_DSRMROT", label: "New file on disarm"},
    {name: "LOG_MAX_FILES", label: "Files kept", decimals: 0},
    {name: "LOG_FILE_MB_FREE", label: "Minimum free space", decimals: 0},
    {name: "LOG_FILE_BUFSIZE", label: "Write buffer", decimals: 0},
    {name: "LOG_MAV_BUFSIZE", label: "MAVLink buffer", decimals: 0},
    {name: "LOG_FILE_TIMEOUT", label: "Write timeout", decimals: 0},
    {name: "LOG_REPLAY", label: "EKF replay data"},
];

const IMU_ROWS: RowSpec[] = [
    {name: "INS_LOG_BAT_MASK", label: "IMUs sampled"},
    {name: "INS_LOG_BAT_OPT", label: "Batch options"},
    {name: "INS_LOG_BAT_CNT", label: "Samples per batch", decimals: 0},
    {name: "INS_LOG_BAT_LGIN", label: "Batch interval", decimals: 0},
    {name: "INS_LOG_BAT_LGCT", label: "Samples per message", decimals: 0},
    {name: "INS_RAW_LOG_OPT", label: "Raw IMU logging"},
];

/**
 * Onboard (dataflash) logging: which messages are written, how fast, where
 * to, and when files are started and pruned — plus the IMU batch sampler,
 * whose high-rate raw samples are what vibration/FFT analysis needs.
 */
export default function LoggingSetupPanel({live, onSet, firmware}: LoggingSetupPanelProps) {
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

    return (
        <div className="flex w-full flex-col gap-6">
            <h1 className="text-heading text-text-primary">Logging</h1>

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

            {sheetState.status === "ready" && (
                <>
                    <LogSection ctx={ctx} title="Content" rows={CONTENT_ROWS}/>
                    <LogSection ctx={ctx} title="Rates" rows={RATE_ROWS}/>
                    <LogSection ctx={ctx} title="Files" rows={FILE_ROWS}/>
                    <LogSection ctx={ctx} title="IMU batch sampling" rows={IMU_ROWS}/>
                    {live.size > 0 && !live.has("LOG_BITMASK") && (
                        <p className="text-label text-text-helper">This vehicle reports no LOG_ parameters.</p>
                    )}
                </>
            )}
        </div>
    );
}
