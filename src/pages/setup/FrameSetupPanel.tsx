import {useState} from "react";
import type {ReactNode} from "react";
import {Code} from "@carbon/icons-react";
import {useReboot} from "@/lib/vehicle/useReboot.ts";
import {LiveParamEntry} from "@/lib/params/liveParams.ts";
import {useParamSheet} from "@/lib/params/useParamSheet.ts";
import {ParamDef} from "@/lib/params/paramSheet.ts";
import {paramDefaultStatus, ParamDefaultStatus} from "@/lib/calibration/paramDefaultStatus.ts";
import {findFrameDrawing, frameTypesFor} from "@/lib/frames/motorLayouts.ts";
import FrameDiagram from "@/components/FrameDiagram.tsx";
import {FRAME_TYPE_APPLIES_FOR, SCRIPTED_FRAME_CLASSES} from "./frameDiagrams.ts";

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

/** What a tile or the big preview draws for one class/type: the frame from
 * its layout data, spin rings on; numbers only in the preview, where there's
 * room to read them. Scripted classes have no geometry, so they get the Code
 * icon. `typeValue` null is the class's own tile. */
function DiagramContent({classValue, typeValue, numbers = false}: {classValue: number | null; typeValue: number | null; numbers?: boolean}) {
    if (classValue === null) return null;
    if (SCRIPTED_FRAME_CLASSES.has(classValue)) {
        return <Code size={32} className="text-text-helper" />;
    }
    const frame = findFrameDrawing(classValue, typeValue);
    if (!frame) return null;
    return <FrameDiagram frame={frame} spin numbers={numbers} className="h-full w-full" />;
}

interface TileProps {
    label: string;
    selected: boolean;
    disabled?: boolean;
    /** `sm` for the type row inside the preview card. */
    size?: "md" | "sm";
    onClick: () => void;
    children: ReactNode;
}

function Tile({label, selected, disabled, size = "md", onClick, children}: TileProps) {
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
            <div className={`flex items-center justify-center ${size === "sm" ? "h-16 w-16" : "h-24 w-24"}`}>{children}</div>
            <span className="text-label leading-tight text-text-secondary">{label}</span>
        </button>
    );
}

/**
 * `FRAME_CLASS` (motor count/family) and `FRAME_TYPE` (X/plus/V/... layout)
 * — ArduCopter's equivalent of PX4's airframe picker, shown the way
 * QGroundControl's Frame Setup does: pictures instead of bare enum labels.
 * Every frame is drawn by `FrameDiagram` from ArduPilot's own layout data
 * (checked against its official diagrams at build time, see
 * scripts/build-motor-layouts.mjs), the same drawing the Servo page uses;
 * the 3 script-defined classes get the Code icon since they have no fixed
 * geometry to draw.
 *
 * Both params are `rebootRequired`, and every class/type tile only stages a
 * selection — nothing is written until the shared `Set Frame` button in the
 * preview is clicked, one interaction regardless of whether the picked class
 * has a `FRAME_TYPE` to go with it. Classes where `FRAME_TYPE` actually does
 * something (`FRAME_TYPE_APPLIES_FOR`) write both params together so `Set`
 * never leaves a stale type from a previous class in place.
 */
export default function FrameSetupPanel({live, onSet}: FrameSetupPanelProps) {
    const reboot = useReboot();
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
    const scripted = effectiveClass !== null && SCRIPTED_FRAME_CLASSES.has(effectiveClass);
    // Types this class has a layout for that FRAME_TYPE actually documents —
    // e.g. Y6B/Y6F only under Y6, BetaflightX/DJIX only where ArduPilot mixes
    // them. The undocumented Quad values in the layout data aren't offered.
    const typeOptions =
        showTypeGrid && effectiveClass !== null
            ? frameTypesFor(effectiveClass).filter((t) => frameType?.values?.some((v) => v.value === t))
            : [];
    const missingType = stagedNeedsType && stagedType === "";

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
                // Sticky, so the staged frame, its type choice and Set stay in
                // view while the class grid scrolls underneath. The type row
                // lives in here, next to the preview, rather than below the
                // class grid where a short window hid it entirely.
                <div className="sticky top-0 z-10 flex items-start gap-4 border border-border-subtle bg-layer-01 p-4 shadow-[0_8px_16px_-8px_rgba(0,0,0,0.6)]">
                    <div className="flex h-44 w-44 shrink-0 items-center justify-center bg-background p-2">
                        <DiagramContent classValue={effectiveClass} typeValue={effectiveType} numbers />
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col gap-3">
                        <div className="flex flex-col gap-1">
                            <span className="text-micro text-text-helper">{isEditing ? "Previewing" : "Currently set to"}</span>
                            <span className="text-body text-text-primary">
                                {classLabel ?? (effectiveClass === null ? "Not read yet" : `Frame class ${effectiveClass}`)}
                                {typeLabel && ` — ${typeLabel}`}
                            </span>
                            {scripted && (
                                <span className="text-label text-text-helper">
                                    Motor layout is defined by a Lua script — there's no fixed diagram to show.
                                </span>
                            )}
                        </div>

                        {frameType && typeOptions.length > 0 && (
                            <div className="flex min-w-0 flex-col gap-1.5">
                                <span className={`text-label ${missingType ? "text-state-warn" : "text-text-secondary"}`}>
                                    Frame Type{missingType && " — pick one to continue"}
                                </span>
                                <div
                                    className={`flex gap-2 overflow-x-auto border p-1 pb-2 ${missingType ? "border-state-warn" : "border-transparent"}`}
                                >
                                    {typeOptions.map((typeValue) => (
                                        <Tile
                                            key={typeValue}
                                            size="sm"
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

                        {isEditing && (
                            <div className="flex flex-wrap items-center gap-2">
                                <button
                                    type="button"
                                    disabled={missingType || comboPending}
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
                                {missingType && <span className="text-label text-state-warn">Pick a frame type</span>}
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

            <p className="text-label text-text-helper">
                Both only take effect after a reboot — once you've set the ones you need,{" "}
                <button
                    type="button"
                    onClick={() => void reboot.reboot()}
                    disabled={reboot.pending}
                    className="text-state-info underline disabled:text-text-disabled"
                >
                    {reboot.pending ? "rebooting…" : "reboot the vehicle"}
                </button>
                .
            </p>
            {reboot.error && <p className="text-label text-state-danger">{reboot.error}</p>}
        </div>
    );
}
