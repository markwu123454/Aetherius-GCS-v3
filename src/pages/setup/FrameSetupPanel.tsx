import {useState} from "react";
import type {ReactNode} from "react";
import {Code} from "@carbon/icons-react";
import {sendVehicleCommand} from "@/lib/vehicle/commands.ts";
import {LiveParamEntry} from "@/lib/params/liveParams.ts";
import {useParamSheet} from "@/lib/params/useParamSheet.ts";
import {ParamDef} from "@/lib/params/paramSheet.ts";
import {paramDefaultStatus, ParamDefaultStatus} from "@/lib/calibration/paramDefaultStatus.ts";
import {FRAME_CLASS_DIAGRAMS, FRAME_TYPE_APPLIES_FOR} from "./frameDiagrams.ts";

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

function findParam(groups: {params: ParamDef[]}[], name: string): ParamDef | null {
    for (const group of groups) {
        const found = group.params.find((p) => p.name === name);
        if (found) return found;
    }
    return null;
}

/** What a tile or the big preview renders for one `FRAME_CLASS` value — the
 * three `FrameClassDiagram` kinds each need different markup. */
function DiagramContent({classValue, typeValue}: {classValue: number | null; typeValue: number | null}) {
    if (classValue === null) return null;
    const diagram = FRAME_CLASS_DIAGRAMS[classValue];
    if (!diagram) return null;
    if (diagram.kind === "scripted") {
        return <Code size={32} className="text-text-helper" />;
    }
    if (diagram.kind === "custom") {
        const Icon = diagram.Icon;
        return <Icon />;
    }
    const src = (typeValue !== null ? diagram.types?.[typeValue] : undefined) ?? diagram.classImage;
    return <img src={src} alt="" className="h-full w-full" />;
}

interface TileProps {
    label: string;
    selected: boolean;
    disabled?: boolean;
    onClick: () => void;
    children: ReactNode;
}

function Tile({label, selected, disabled, onClick, children}: TileProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={[
                "flex flex-col items-center gap-1 border p-2 text-center disabled:opacity-60",
                selected
                    ? "border-state-info bg-state-info/10"
                    : "border-border-subtle bg-layer-01 hover:bg-layer-hover-01",
            ].join(" ")}
        >
            <div className="flex h-24 w-24 items-center justify-center">{children}</div>
            <span className="text-label leading-tight text-text-secondary">{label}</span>
        </button>
    );
}

/**
 * `FRAME_CLASS` (motor count/family) and `FRAME_TYPE` (X/plus/V/... layout)
 * — ArduCopter's equivalent of PX4's airframe picker, shown the way
 * QGroundControl's Frame Setup does: pictures instead of bare enum labels.
 * Class images are ArduPilot's own published diagrams (bundled locally,
 * `frameDiagrams.ts` has attribution details); the handful of classes with no
 * usable official diagram get a hand-drawn stand-in, and the 3 script-defined
 * classes get the Code icon since they have no fixed geometry to draw.
 *
 * Both params are `rebootRequired`, and every class/type tile only stages a
 * selection — nothing is written until the shared `Set Frame` button in the
 * preview is clicked, one interaction regardless of whether the picked class
 * has a `FRAME_TYPE` to go with it. Classes where `FRAME_TYPE` actually does
 * something (`FRAME_TYPE_APPLIES_FOR`) write both params together so `Set`
 * never leaves a stale type from a previous class in place.
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

    // null = "not editing, showing the live value". Set by clicking any
    // type-applicable class or type tile; cleared on Set or Cancel.
    const [stagedClass, setStagedClass] = useState<number | null>(null);
    const [stagedType, setStagedType] = useState<string>("");

    const [comboPending, setComboPending] = useState(false);
    const [comboResult, setComboResult] = useState<{ok: true} | {ok: false; message: string} | null>(null);

    const isEditing = stagedClass !== null;
    const effectiveClass = stagedClass ?? classRounded;
    const effectiveType = isEditing ? (stagedType !== "" ? Number(stagedType) : null) : typeRounded;
    const showTypeGrid = effectiveClass !== null && FRAME_TYPE_APPLIES_FOR.has(effectiveClass);
    const stagedNeedsType = stagedClass !== null && FRAME_TYPE_APPLIES_FOR.has(stagedClass);

    const handleClassClick = (value: number) => {
        setStagedClass(value);
        setStagedType(
            FRAME_TYPE_APPLIES_FOR.has(value) && value === classRounded && typeRounded !== null
                ? String(typeRounded)
                : "",
        );
        setComboResult(null);
    };

    const handleTypeClick = (value: number) => {
        if (!isEditing && effectiveClass !== null) {
            setStagedClass(effectiveClass);
        }
        setStagedType(String(value));
        setComboResult(null);
    };

    const handleCancel = () => {
        setStagedClass(null);
        setStagedType("");
        setComboResult(null);
    };

    const handleCombinedSet = async () => {
        if (stagedClass === null || (stagedNeedsType && stagedType === "")) return;
        setComboPending(true);
        setComboResult(null);
        try {
            await onSet("FRAME_CLASS", stagedClass);
            if (stagedNeedsType) {
                await onSet("FRAME_TYPE", Number(stagedType));
            }
            setComboResult({ok: true});
            setStagedClass(null);
            setStagedType("");
        } catch (error) {
            setComboResult({ok: false, message: error instanceof Error ? error.message : String(error)});
        } finally {
            setComboPending(false);
        }
    };

    const classLabel = frameClass?.values?.find((v) => v.value === effectiveClass)?.label ?? null;
    const typeLabel =
        showTypeGrid && effectiveType !== null ? (frameType?.values?.find((v) => v.value === effectiveType)?.label ?? null) : null;
    const previewDiagram = effectiveClass !== null ? FRAME_CLASS_DIAGRAMS[effectiveClass] : null;
    const typeOptions = previewDiagram?.kind === "image" ? Object.keys(previewDiagram.types ?? {}).map(Number) : [];

    return (
        <div className="flex w-full flex-col gap-4">
            <div>
                <h2 className="text-heading text-text-primary">Frame</h2>
                <p className="text-body text-text-secondary">
                    Sets the multicopter's motor count and layout so ArduPilot mixes the right output to each motor.{" "}
                    <a
                        href="https://ardupilot.org/copter/docs/connect-escs-and-motors.html"
                        target="_blank"
                        rel="noreferrer"
                        className="text-state-info underline"
                    >
                        Reference diagrams
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
                <div className="flex items-center gap-4 border border-border-subtle bg-layer-01 p-4">
                    <div className="flex h-44 w-44 shrink-0 items-center justify-center bg-background">
                        <DiagramContent classValue={effectiveClass} typeValue={effectiveType} />
                    </div>
                    <div className="flex flex-col gap-1">
                        <span className="text-micro text-text-helper">{isEditing ? "Previewing" : "Currently set to"}</span>
                        <span className="text-body text-text-primary">
                            {classLabel ?? (effectiveClass === null ? "Not read yet" : `Frame class ${effectiveClass}`)}
                            {typeLabel && ` — ${typeLabel}`}
                        </span>
                        {previewDiagram?.kind === "scripted" && (
                            <span className="text-label text-text-helper">
                                Motor layout is defined by a Lua script — there's no fixed diagram to show.
                            </span>
                        )}
                        {isEditing && (
                            <div className="mt-2 flex items-center gap-2">
                                <button
                                    type="button"
                                    disabled={(stagedNeedsType && stagedType === "") || comboPending}
                                    onClick={() => void handleCombinedSet()}
                                    className="h-control-sm w-fit border border-border-subtle px-3 text-label text-text-primary hover:enabled:bg-layer-hover-01 disabled:text-text-disabled"
                                >
                                    {comboPending ? "Setting…" : "Set Frame"}
                                </button>
                                <button
                                    type="button"
                                    disabled={comboPending}
                                    onClick={handleCancel}
                                    className="text-label text-text-helper hover:text-text-primary"
                                >
                                    Cancel
                                </button>
                                {comboResult && !comboResult.ok && (
                                    <span className="text-label text-state-danger">{comboResult.message}</span>
                                )}
                                {comboResult?.ok && <span className="text-label text-state-ok">Set.</span>}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {frameClass && (
                <div className="flex flex-col gap-2">
                    <span className="text-label text-text-secondary">Frame Class</span>
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
                        {frameClass.values
                            ?.filter((option) => option.value !== 0)
                            .map((option) => (
                                <Tile
                                    key={option.value}
                                    label={option.label}
                                    selected={effectiveClass === option.value}
                                    disabled={comboPending}
                                    onClick={() => handleClassClick(option.value)}
                                >
                                    <DiagramContent classValue={option.value} typeValue={null} />
                                </Tile>
                            ))}
                    </div>
                </div>
            )}

            {frameType && showTypeGrid && effectiveClass !== null && (
                <div className="flex flex-col gap-2">
                    <span className="text-label text-text-secondary">Frame Type</span>
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
                        {/* Only types ArduPilot's own diagrams cover for this class — e.g. Y6B/Y6F
                            don't show up under Quad, BetaflightX/DJIX/etc don't show up under Y6.
                            See frameDiagrams.ts for why this is more reliable than the full param enum. */}
                        {typeOptions.map((typeValue) => (
                            <Tile
                                key={typeValue}
                                label={frameType.values?.find((v) => v.value === typeValue)?.label ?? `Type ${typeValue}`}
                                selected={effectiveType === typeValue}
                                disabled={comboPending}
                                onClick={() => handleTypeClick(typeValue)}
                            >
                                <DiagramContent classValue={effectiveClass} typeValue={typeValue} />
                            </Tile>
                        ))}
                    </div>
                </div>
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
