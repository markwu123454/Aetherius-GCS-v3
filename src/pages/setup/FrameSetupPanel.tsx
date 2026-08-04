import {useState} from "react";
import {sendVehicleCommand} from "@/lib/vehicle/commands.ts";
import {LiveParamEntry} from "@/lib/params/liveParams.ts";
import {useParamSheet} from "@/lib/params/useParamSheet.ts";
import {ParamDef} from "@/lib/params/paramSheet.ts";
import {paramDefaultStatus, ParamDefaultStatus} from "@/lib/calibration/paramDefaultStatus.ts";

interface FrameSetupPanelProps {
    live: Map<string, LiveParamEntry>;
    onSet: (name: string, value: number) => Promise<number>;
}

const STATUS_LABEL: Record<ParamDefaultStatus, string> = {
    complete: "Configured",
    incomplete: "Needs configuration",
    unknown: "Unknown",
};

const STATUS_TONE: Record<ParamDefaultStatus, string> = {
    complete: "text-state-ok",
    incomplete: "text-state-danger",
    unknown: "text-text-helper",
};

/** `FRAME_CLASS` values for which `FRAME_TYPE` is meaningless — straight
 * from `FRAME_TYPE`'s own parameter description ("Not used for Tri or
 * Traditional Helicopters"), not a guess about ArduCopter's internals. Every
 * other class/type combination is left unchecked: nothing in the published
 * param docs says which types are valid for which of the remaining classes,
 * so validating further would mean hand-transcribing ArduCopter's C++
 * motor-mixer selection rather than reading it from data. */
const FRAME_TYPE_IGNORED_FOR: Record<number, string> = {
    6: "Traditional Helicopter",
    7: "Tri",
};

interface FrameParamSelectProps {
    param: ParamDef;
    liveEntry: LiveParamEntry | undefined;
    selected: string;
    onSelectedChange: (value: string) => void;
    onSet: (name: string, value: number) => Promise<number>;
    /** When set, this param is known not to apply to the currently selected
     * frame class — the control is shown but disabled, with this as the
     * reason, rather than writing a value ArduPilot will just ignore. */
    disabledReason?: string;
}

/**
 * One enum-valued param (`FRAME_CLASS` or `FRAME_TYPE`) as a plain select —
 * both are always fully enumerated in ArduCopter's own docs, so unlike
 * `ParametersPage`'s general-purpose control this never needs a manual-entry
 * fallback. `selected` is lifted to the parent (rather than owned here like
 * `ParamValueInput` owns its own draft) so picking a Class can immediately
 * gate whether Type is offered at all, without waiting for a `Set` round trip.
 */
function FrameParamSelect({param, liveEntry, selected, onSelectedChange, onSet, disabledReason}: FrameParamSelectProps) {
    const options = param.values ?? [];
    const [pending, setPending] = useState(false);
    const [result, setResult] = useState<{ok: true} | {ok: false; message: string} | null>(null);

    const handleSet = async () => {
        if (selected === "") return;
        setPending(true);
        setResult(null);
        try {
            const confirmed = await onSet(param.name, Number(selected));
            onSelectedChange(String(Math.round(confirmed)));
            setResult({ok: true});
        } catch (error) {
            setResult({ok: false, message: error instanceof Error ? error.message : String(error)});
        } finally {
            setPending(false);
        }
    };

    return (
        <div className="flex flex-col gap-2">
            <span className="text-label text-text-secondary">{param.humanName}</span>
            <p className="text-label text-text-helper">{param.description}</p>
            <div className="flex items-center gap-2">
                <select
                    value={selected}
                    disabled={Boolean(disabledReason)}
                    onChange={(event) => onSelectedChange(event.target.value)}
                    className="h-control-sm flex-1 border border-border-subtle bg-background px-2 text-body text-text-primary focus-visible:outline-none disabled:text-text-disabled"
                >
                    <option value="" disabled>
                        {liveEntry ? "— unrecognized value —" : "— not read yet —"}
                    </option>
                    {options.map((option) => (
                        <option key={option.value} value={option.value}>
                            {option.label}
                        </option>
                    ))}
                </select>
                <button
                    type="button"
                    disabled={selected === "" || pending || Boolean(disabledReason)}
                    onClick={() => void handleSet()}
                    className="h-control-sm w-fit border border-border-subtle px-3 text-label text-text-primary hover:enabled:bg-layer-hover-01 disabled:text-text-disabled"
                >
                    {pending ? "Setting…" : "Set"}
                </button>
            </div>
            {disabledReason ? (
                <span className="text-label text-text-helper">{disabledReason}</span>
            ) : (
                result && (
                    <span className={`text-label ${result.ok ? "text-state-ok" : "text-state-danger"}`}>
                        {result.ok ? "Set." : result.message}
                    </span>
                )
            )}
        </div>
    );
}

function findParam(groups: {params: ParamDef[]}[], name: string): ParamDef | null {
    for (const group of groups) {
        const found = group.params.find((p) => p.name === name);
        if (found) return found;
    }
    return null;
}

/**
 * `FRAME_CLASS` (motor count/family) and `FRAME_TYPE` (X/plus/V/... layout)
 * — ArduCopter's equivalent of PX4's airframe picker. PX4 selects a whole
 * parameter preset via `SYS_AUTOSTART` and reboots into it; ArduCopter has no
 * such preset system, so this is just the two params that actually govern
 * motor mixing, surfaced the same way QGroundControl's Frame Setup does.
 * Both are `rebootRequired` in the parameter docs, hence the reboot prompt
 * once both are set rather than after each individual one.
 */
export default function FrameSetupPanel({live, onSet}: FrameSetupPanelProps) {
    const sheetState = useParamSheet("ArduCopter");

    const classLiveEntry = live.get("FRAME_CLASS");
    const typeLiveEntry = live.get("FRAME_TYPE");
    const classRounded = classLiveEntry ? Math.round(classLiveEntry.value) : null;
    const typeRounded = typeLiveEntry ? Math.round(typeLiveEntry.value) : null;

    const status = paramDefaultStatus(live, ["FRAME_CLASS"]);

    const frameClass = sheetState.status === "ready" ? findParam(sheetState.sheet.groups, "FRAME_CLASS") : null;
    const frameType = sheetState.status === "ready" ? findParam(sheetState.sheet.groups, "FRAME_TYPE") : null;

    // Selection is lifted here (rather than owned inside `FrameParamSelect`)
    // so choosing a Class gates Type immediately — the operator shouldn't be
    // able to fiddle with a Type value the class they just picked ignores.
    const [classSelected, setClassSelected] = useState(() => (classRounded !== null ? String(classRounded) : ""));
    const [typeSelected, setTypeSelected] = useState(() => (typeRounded !== null ? String(typeRounded) : ""));

    const typeIgnoredReason =
        classSelected !== "" && Number(classSelected) in FRAME_TYPE_IGNORED_FOR
            ? `Not used for ${FRAME_TYPE_IGNORED_FOR[Number(classSelected)]} — this class ignores Frame Type.`
            : undefined;

    return (
        <div className="flex w-full max-w-lg flex-col gap-6">
            <div>
                <h2 className="text-heading text-text-primary">Frame</h2>
                <p className="text-body text-text-secondary">
                    Sets the multicopter's motor count and layout so ArduPilot mixes the right output to each motor.
                    Reference:{" "}
                    <a
                        href="https://ardupilot.org/copter/docs/connect-escs-and-motors.html"
                        target="_blank"
                        rel="noreferrer"
                        className="text-state-info underline"
                    >
                        ArduPilot's Motor Connection docs
                    </a>
                    .
                </p>
            </div>

            <div className="flex items-center gap-2">
                <span className="text-label text-text-helper">Status</span>
                <span className={`text-label ${STATUS_TONE[status]}`}>{STATUS_LABEL[status]}</span>
            </div>

            {sheetState.status === "loading" && (
                <p className="text-label text-text-helper">Loading ArduCopter parameter reference…</p>
            )}
            {sheetState.status === "error" && <p className="text-label text-state-danger">{sheetState.message}</p>}

            {frameClass && (
                <FrameParamSelect
                    param={frameClass}
                    liveEntry={classLiveEntry}
                    selected={classSelected}
                    onSelectedChange={setClassSelected}
                    onSet={onSet}
                />
            )}
            {frameType && (
                <FrameParamSelect
                    param={frameType}
                    liveEntry={typeLiveEntry}
                    selected={typeSelected}
                    onSelectedChange={setTypeSelected}
                    onSet={onSet}
                    disabledReason={typeIgnoredReason}
                />
            )}

            <p className="text-label text-text-helper">
                Both only take effect after a reboot — once you've set the ones you need,{" "}
                <button
                    type="button"
                    onClick={() => void sendVehicleCommand({type: "reboot"})}
                    className="text-state-info underline"
                >
                    reboot the vehicle
                </button>
                .
            </p>
        </div>
    );
}
