import {type ReactNode, useMemo, useState} from "react";
import {CheckmarkFilled, ChevronDown, ChevronRight, InProgress, Warning} from "@carbon/icons-react";
import {ParamDiffRow} from "@/lib/params/paramFile.ts";
import {FlagBadges} from "./ParametersPage.tsx";

function fmt(value: number): string {
    return Number(value.toPrecision(6)).toString();
}

type RowState = "idle" | "pending" | "done" | "error";

interface ReviewRowProps {
    row: ParamDiffRow;
    checked: boolean;
    state: RowState;
    error: string | undefined;
    disabled: boolean;
    onToggle: () => void;
}

function ReviewRow({row, checked, state, error, disabled, onToggle}: ReviewRowProps) {
    return (
        <tr className="border-b border-border-subtle-base">
            <td className="w-8 px-3 py-1.5">
                <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled || row.def?.readOnly}
                    onChange={onToggle}
                    title={row.def?.readOnly ? "Read-only — can't be set" : undefined}
                />
            </td>
            <td className="px-3 py-1.5">
                <div className="flex items-center gap-2">
                    <span className="font-mono text-text-primary">{row.name}</span>
                    {row.def && <FlagBadges param={row.def} />}
                </div>
            </td>
            <td className="px-3 py-1.5 text-right font-mono text-text-helper">
                {row.liveValue !== undefined ? fmt(row.liveValue) : "—"}
            </td>
            <td className="px-3 py-1.5 text-right font-mono text-text-primary">{fmt(row.fileValue)}</td>
            <td className="w-32 px-3 py-1.5">
                {state === "pending" && (
                    <span className="flex items-center gap-1 text-state-info">
                        <InProgress size={16} /> Setting…
                    </span>
                )}
                {state === "done" && (
                    <span className="flex items-center gap-1 text-state-ok">
                        <CheckmarkFilled size={16} /> Set
                    </span>
                )}
                {state === "error" && (
                    <span className="flex items-center gap-1 text-state-danger" title={error}>
                        <Warning size={16} /> Failed
                    </span>
                )}
            </td>
        </tr>
    );
}

interface CollapsibleSectionProps {
    title: string;
    count: number;
    tone?: "default" | "warn";
    defaultOpen: boolean;
    children: ReactNode;
}

function CollapsibleSection({title, count, tone = "default", defaultOpen, children}: CollapsibleSectionProps) {
    const [open, setOpen] = useState(defaultOpen);
    if (count === 0) return null;

    return (
        <div className="flex flex-col">
            <button
                type="button"
                onClick={() => setOpen((prev) => !prev)}
                className={[
                    "flex w-full items-center gap-1.5 border-b border-border-subtle bg-layer-02 px-3 py-1.5 text-left text-label",
                    tone === "warn" ? "text-state-warn" : "text-text-secondary",
                ].join(" ")}
            >
                {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                {tone === "warn" && <Warning size={16} />}
                <span>
                    {title} ({count})
                </span>
            </button>
            {open && (
                <table className="w-full border-collapse text-label">
                    <tbody>{children}</tbody>
                </table>
            )}
        </div>
    );
}

interface ParamLoadReviewProps {
    fileName: string;
    rows: ParamDiffRow[];
    connected: boolean;
    armed: boolean | null;
    onSet: (name: string, value: number) => Promise<number>;
    onClose: () => void;
}

/**
 * Full-width takeover of the Parameters page body while a loaded file is
 * being reviewed — deliberately not a small modal (see `Modal.tsx`) and not
 * squeezed alongside the group tree / detail pane, since a diff can run into
 * the hundreds of rows and the normal three-pane layout has no room left for
 * one more thing. Mirrors `ParametersPage`'s existing pattern of branching
 * the whole body on a status, just with one more state.
 */
export default function ParamLoadReview({fileName, rows, connected, armed, onSet, onClose}: ParamLoadReviewProps) {
    const changed = useMemo(() => rows.filter((r) => r.status === "changed"), [rows]);
    const unrecognized = useMemo(() => rows.filter((r) => r.status === "unrecognized"), [rows]);
    const unchangedCount = useMemo(() => rows.filter((r) => r.status === "unchanged").length, [rows]);

    // Checked by default: changed & settable. Unrecognized names are almost
    // always a sign the file doesn't belong to this vehicle, so they start
    // unchecked — including one is an explicit opt-in, not a default.
    const [checked, setChecked] = useState<Set<string>>(
        () => new Set(changed.filter((r) => !r.def?.readOnly).map((r) => r.name)),
    );
    const [rowStates, setRowStates] = useState<Map<string, RowState>>(new Map());
    const [rowErrors, setRowErrors] = useState<Map<string, string>>(new Map());
    const [applying, setApplying] = useState(false);
    const [finished, setFinished] = useState(false);

    const toggle = (name: string) => {
        setChecked((prev) => {
            const next = new Set(prev);
            if (next.has(name)) next.delete(name);
            else next.add(name);
            return next;
        });
    };

    const selectableRows = [...changed, ...unrecognized].filter((r) => !r.def?.readOnly);
    const allSelected = selectableRows.length > 0 && selectableRows.every((r) => checked.has(r.name));
    const selectAll = () => setChecked(new Set(selectableRows.map((r) => r.name)));
    const selectNone = () => setChecked(new Set());

    const armedBlock = armed === true;
    const canApply = connected && !armedBlock && !applying && !finished && checked.size > 0;

    const apply = async () => {
        setApplying(true);
        const targets = [...changed, ...unrecognized].filter((r) => checked.has(r.name));
        for (const row of targets) {
            setRowStates((prev) => new Map(prev).set(row.name, "pending"));
            try {
                await onSet(row.name, row.fileValue);
                setRowStates((prev) => new Map(prev).set(row.name, "done"));
            } catch (error) {
                setRowStates((prev) => new Map(prev).set(row.name, "error"));
                setRowErrors((prev) => new Map(prev).set(row.name, error instanceof Error ? error.message : String(error)));
            }
        }
        setApplying(false);
        setFinished(true);
    };

    const appliedCount = [...rowStates.values()].filter((s) => s === "done").length;
    const failedCount = [...rowStates.values()].filter((s) => s === "error").length;

    return (
        <div className="flex h-full w-full flex-col">
            <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border-subtle p-2">
                <span className="text-body text-text-primary">
                    Reviewing <span className="font-mono">{fileName}</span>
                </span>
                <span className="text-label text-text-helper">
                    {changed.length} changed · {unrecognized.length} unrecognized · {unchangedCount} unchanged
                </span>
                <div className="ml-auto flex items-center gap-2">
                    {!finished && (
                        <>
                            <button
                                type="button"
                                onClick={allSelected ? selectNone : selectAll}
                                disabled={applying}
                                className="h-control-sm border border-border-subtle px-3 text-label text-text-primary hover:enabled:bg-layer-hover-01 disabled:text-text-disabled"
                            >
                                {allSelected ? "Select none" : "Select all"}
                            </button>
                            <button
                                type="button"
                                onClick={onClose}
                                disabled={applying}
                                className="h-control-sm border border-border-subtle px-3 text-label text-text-primary hover:enabled:bg-layer-hover-01 disabled:text-text-disabled"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={() => void apply()}
                                disabled={!canApply}
                                className="h-control-sm border border-border-subtle bg-layer-01 px-3 text-label text-text-primary hover:enabled:bg-layer-hover-01 disabled:text-text-disabled"
                            >
                                {applying ? "Applying…" : `Apply ${checked.size} change${checked.size === 1 ? "" : "s"}`}
                            </button>
                        </>
                    )}
                    {finished && (
                        <>
                            <span className="text-label text-text-secondary">
                                {appliedCount} set{failedCount > 0 ? `, ${failedCount} failed` : ""}
                            </span>
                            <button
                                type="button"
                                onClick={onClose}
                                className="h-control-sm border border-border-subtle bg-layer-01 px-3 text-label text-text-primary hover:bg-layer-hover-01"
                            >
                                Done
                            </button>
                        </>
                    )}
                </div>
            </div>

            {armedBlock && !finished && (
                <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle bg-layer-02 px-3 py-2 text-label text-state-warn">
                    <Warning size={16} />
                    Vehicle is armed — disarm before applying a parameter file.
                </div>
            )}

            <div className="min-h-0 flex-1 overflow-auto">
                <table className="w-full border-collapse text-label">
                    <thead className="sticky top-0 z-10 bg-layer-01 text-text-helper">
                        <tr className="text-left">
                            <th className="w-8 border-b border-border-subtle px-3 py-2 font-normal" />
                            <th className="border-b border-border-subtle px-3 py-2 font-normal">Name</th>
                            <th className="border-b border-border-subtle px-3 py-2 text-right font-normal">Current</th>
                            <th className="border-b border-border-subtle px-3 py-2 text-right font-normal">New</th>
                            <th className="w-32 border-b border-border-subtle px-3 py-2 font-normal">Result</th>
                        </tr>
                    </thead>
                </table>

                <CollapsibleSection title="Changed" count={changed.length} defaultOpen>
                    {changed.map((row) => (
                        <ReviewRow
                            key={row.name}
                            row={row}
                            checked={checked.has(row.name)}
                            state={rowStates.get(row.name) ?? "idle"}
                            error={rowErrors.get(row.name)}
                            disabled={applying || finished}
                            onToggle={() => toggle(row.name)}
                        />
                    ))}
                </CollapsibleSection>

                <CollapsibleSection title="Unrecognized" count={unrecognized.length} tone="warn" defaultOpen={false}>
                    {unrecognized.map((row) => (
                        <ReviewRow
                            key={row.name}
                            row={row}
                            checked={checked.has(row.name)}
                            state={rowStates.get(row.name) ?? "idle"}
                            error={rowErrors.get(row.name)}
                            disabled={applying || finished}
                            onToggle={() => toggle(row.name)}
                        />
                    ))}
                </CollapsibleSection>

                <CollapsibleSection title="Unchanged" count={unchangedCount} defaultOpen={false}>
                    {rows
                        .filter((r) => r.status === "unchanged")
                        .map((row) => (
                            <tr key={row.name} className="border-b border-border-subtle-base">
                                <td className="w-8 px-3 py-1.5" />
                                <td className="px-3 py-1.5 font-mono text-text-helper">{row.name}</td>
                                <td className="px-3 py-1.5 text-right font-mono text-text-helper">{fmt(row.fileValue)}</td>
                                <td className="px-3 py-1.5 text-right font-mono text-text-helper">{fmt(row.fileValue)}</td>
                                <td className="w-32 px-3 py-1.5" />
                            </tr>
                        ))}
                </CollapsibleSection>
            </div>
        </div>
    );
}
