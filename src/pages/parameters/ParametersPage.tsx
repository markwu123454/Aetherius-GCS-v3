import {useEffect, useMemo, useState} from "react";
import {Search} from "@carbon/icons-react";
import {useParamSheet} from "@/lib/params/useParamSheet.ts";
import {
    ALL_GROUPS_KEY,
    groupLabel,
    ParamDef,
    ParamGroup,
    ParamMatch,
    ParamOption,
    searchParams,
    VehicleFirmware,
} from "@/lib/params/paramSheet.ts";
import {formatParamValue, LiveParamEntry} from "@/lib/params/liveParams.ts";
import {useLiveParams} from "@/lib/params/useLiveParams.ts";
import {useConnection} from "@/lib/vehicle/useConnection.ts";
import {useVehicle} from "@/lib/vehicle/useVehicle.ts";
import {VehicleKind} from "@/lib/vehicle/vehicle.ts";
import {buildGroupTree, findAncestorIds, GroupRelation, GroupTreeNode} from "@/lib/params/groupRelations.ts";
import {ARDUCOPTER_GROUP_RELATIONS} from "@/lib/params/groupRelations.ArduCopter.ts";
import {ARDUPLANE_GROUP_RELATIONS} from "@/lib/params/groupRelations.ArduPlane.ts";

const RELATIONS_BY_VEHICLE: Record<VehicleFirmware, GroupRelation[]> = {
    ArduCopter: ARDUCOPTER_GROUP_RELATIONS,
    ArduPlane: ARDUPLANE_GROUP_RELATIONS,
};

/** A flag badge next to a parameter's name — each only appears when true. */
function flagsOf(param: ParamDef): {label: string; title: string}[] {
    const flags: {label: string; title: string}[] = [];
    if (param.user === "Advanced") {
        flags.push({label: "ADV", title: "Advanced parameter"});
    }
    if (param.readOnly) {
        flags.push({label: "RO", title: "Read-only"});
    }
    if (param.rebootRequired) {
        flags.push({label: "REBOOT", title: "Requires a reboot to take effect"});
    }
    if (param.calibration) {
        flags.push({label: "CAL", title: "Set by a calibration routine"});
    }
    if (param.volatile) {
        flags.push({label: "VOLATILE", title: "Not persisted to EEPROM"});
    }
    return flags;
}

function FlagBadges({param}: {param: ParamDef}) {
    const flags = flagsOf(param);
    if (flags.length === 0) {
        return null;
    }
    return (
        <span className="flex shrink-0 gap-1">
            {flags.map((flag) => (
                <span
                    key={flag.label}
                    title={flag.title}
                    className="border border-border-subtle px-1 text-micro text-text-helper"
                >
                    {flag.label}
                </span>
            ))}
        </span>
    );
}

function OptionTable({title, options}: {title: string; options: ParamOption[]}) {
    return (
        <div className="flex flex-col gap-1">
            <span className="text-label text-text-secondary">{title}</span>
            <table className="w-full text-label">
                <tbody>
                    {options.map((option) => (
                        <tr key={option.value} className="border-t border-border-subtle-base">
                            <td className="w-12 py-1 pr-2 font-mono text-text-helper">{option.value}</td>
                            <td className="py-1 text-text-primary">{option.label}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

interface GroupRowProps {
    label: string;
    count: number;
    /** Params that belong to this row's own group, not its children — shown
     * as a small marker when a row that also has children (so it looks, at
     * a glance, like a plain label) is actually selectable in its own right. */
    ownCount: number;
    depth: number;
    isActive: boolean;
    selectable: boolean;
    hasToggle: boolean;
    expanded: boolean;
    onToggle: () => void;
    onSelect: () => void;
}

function GroupRow({
    label,
    count,
    ownCount,
    depth,
    isActive,
    selectable,
    hasToggle,
    expanded,
    onToggle,
    onSelect,
}: GroupRowProps) {
    const showOwnMarker = selectable && hasToggle && ownCount > 0;
    const paddingLeft = `${depth * 14}px`;

    const arrow = (
        <span className="flex w-4 shrink-0 items-center justify-center">{hasToggle ? (expanded ? "▾" : "▸") : null}</span>
    );
    const rowLabel = (
        <span className="flex min-w-0 flex-1 items-center justify-between gap-2 pl-2">
            <span className="flex min-w-0 items-center gap-1.5">
                {/*showOwnMarker && (
                    <span className="shrink-0 text-state-info" aria-hidden="true">
                        ●
                    </span>
                )*/}
                <span className="truncate">{label}</span>
            </span>
            <span className="shrink-0 text-micro text-text-helper">{count}</span>
        </span>
    );

    // Nothing but a toggle behind this row — the label was never a separate
    // click target worth having, so the whole row does the one thing that's
    // actually available instead of half of it being dead space that still
    // lit up on hover as if it did something.
    if (!selectable && hasToggle) {
        return (
            <button
                type="button"
                onClick={onToggle}
                aria-expanded={expanded}
                style={{paddingLeft}}
                className="flex w-full items-center py-1.5 pr-3 text-left text-label whitespace-nowrap text-text-secondary hover:bg-layer-hover-01 hover:text-text-primary"
            >
                {arrow}
                {rowLabel}
            </button>
        );
    }

    // Neither selectable nor expandable — genuinely nothing to click, so it
    // renders with no hover state at all rather than pretend otherwise.
    if (!selectable && !hasToggle) {
        return (
            <div
                style={{paddingLeft}}
                className="flex w-full items-center gap-1 py-1.5 pr-3 text-label whitespace-nowrap text-text-helper"
            >
                {arrow}
                {rowLabel}
            </div>
        );
    }

    // Selectable, with or without its own toggle — the toggle (when present)
    // is a separate small hit target so it expands without also selecting.
    return (
        <div className="flex w-full items-stretch text-label whitespace-nowrap" style={{paddingLeft}}>
            {hasToggle ? (
                <button
                    type="button"
                    onClick={onToggle}
                    aria-label={expanded ? "Collapse" : "Expand"}
                    className="flex w-4 shrink-0 items-center justify-center text-text-helper hover:text-text-primary"
                >
                    {expanded ? "▾" : "▸"}
                </button>
            ) : (
                <span className="w-4 shrink-0"/>
            )}
            <button
                type="button"
                aria-current={isActive}
                title={showOwnMarker ? `${label} has ${ownCount} parameters of its own, plus its sub-groups` : undefined}
                onClick={onSelect}
                className={[
                    "flex min-w-0 flex-1 items-center justify-between gap-2 py-1.5 pr-3 pl-2 text-left",
                    isActive
                        ? "bg-background text-text-primary"
                        : "text-text-secondary hover:bg-layer-hover-01 hover:text-text-primary",
                ].join(" ")}
            >
                <span className="flex min-w-0 items-center gap-1.5">
                    {/*showOwnMarker && (
                        <span className="shrink-0 text-state-info" aria-hidden="true">
                            ●
                        </span>
                    )*/}
                    <span className="truncate">{label}</span>
                </span>
                <span className="shrink-0 text-micro text-text-helper">{count}</span>
            </button>
        </div>
    );
}

interface GroupTreeRowsProps {
    node: GroupTreeNode;
    selectedKey: string | null;
    expandedIds: Set<string>;
    onToggle: (id: string) => void;
    onSelect: (key: string) => void;
}

/** One relation node plus, if it's open, everything under it. Past the
 * depth cap `node.flattened` is already true and its children are already a
 * flat leaf list (see `buildGroupTree`) — rendering just stops offering a
 * toggle and always shows them, rather than needing separate logic here. */
function GroupTreeRows({node, selectedKey, expandedIds, onToggle, onSelect}: GroupTreeRowsProps) {
    const hasChildren = node.children.length > 0;
    const isOpen = node.flattened || expandedIds.has(node.id);

    return (
        <>
            <GroupRow
                label={node.label}
                count={node.count}
                ownCount={node.ownCount}
                depth={node.depth}
                isActive={node.key !== null && node.key === selectedKey}
                selectable={node.key !== null}
                hasToggle={hasChildren && !node.flattened}
                expanded={isOpen}
                onToggle={() => onToggle(node.id)}
                onSelect={() => {
                    if (node.key !== null) {
                        onSelect(node.key);
                    }
                }}
            />
            {hasChildren &&
                isOpen &&
                node.children.map((child) => (
                    <GroupTreeRows
                        key={child.id}
                        node={child}
                        selectedKey={selectedKey}
                        expandedIds={expandedIds}
                        onToggle={onToggle}
                        onSelect={onSelect}
                    />
                ))}
        </>
    );
}

interface GroupListProps {
    groups: ParamGroup[];
    vehicle: VehicleFirmware;
    selectedKey: string | null;
    onSelect: (key: string) => void;
}

function collectLeaves(nodes: GroupTreeNode[]): {key: string; label: string; count: number; ownCount: number}[] {
    return nodes.flatMap((node) => {
        const own = node.key !== null ? [{key: node.key, label: node.label, count: node.count, ownCount: node.ownCount}] : [];
        return [...own, ...collectLeaves(node.children)];
    });
}

/**
 * A hand-maintained relation registry (`groupRelations.*.ts`) nests numbered
 * instances and real parent/sub-table groups; everything the registry
 * doesn't mention falls back to a flat top-level row, same as before. While
 * filtering, hierarchy stops mattering — every matching group everywhere in
 * the tree shows as one flat list, since "where does this nest" isn't the
 * question a filter is answering.
 */
function GroupList({groups, vehicle, selectedKey, onSelect}: GroupListProps) {
    const [filter, setFilter] = useState("");
    const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

    const tree = useMemo(() => buildGroupTree(groups, RELATIONS_BY_VEHICLE[vehicle]), [groups, vehicle]);
    const totalParams = useMemo(() => groups.reduce((sum, g) => sum + g.params.length, 0), [groups]);

    const toggle = (id: string) => {
        setExpandedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    };

    // Selecting a group by any route — the filter box below, or anything
    // else that drives `selectedKey` — should reveal where it actually
    // lives, not leave someone browsing the tree wondering which family it's
    // hiding in.
    useEffect(() => {
        if (!selectedKey || selectedKey === ALL_GROUPS_KEY) {
            return;
        }
        const ancestors = findAncestorIds(tree, selectedKey);
        if (ancestors && ancestors.length > 0) {
            setExpandedIds((prev) => {
                const next = new Set(prev);
                ancestors.forEach((id) => next.add(id));
                return next;
            });
        }
    }, [selectedKey, tree]);

    const filterQuery = filter.trim().toLowerCase();
    const filteredLeaves = useMemo(() => {
        if (!filterQuery) {
            return null;
        }
        return collectLeaves(tree).filter((leaf) => leaf.label.toLowerCase().includes(filterQuery));
    }, [tree, filterQuery]);

    return (
        <div className="flex h-full w-56 shrink-0 flex-col border-r border-border-subtle bg-layer-01">
            <div className="shrink-0 border-b border-border-subtle p-2">
                <input
                    type="text"
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                    placeholder="Filter groups…"
                    className="h-control-sm w-full border border-border-subtle bg-background px-2 text-body text-text-primary placeholder:text-text-helper focus-visible:outline-none"
                />
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
                {/* Pinned above the filter, since "show everything" should
                    never itself be filtered away by a group-name search. */}
                <button
                    type="button"
                    aria-current={selectedKey === ALL_GROUPS_KEY}
                    onClick={() => onSelect(ALL_GROUPS_KEY)}
                    className={[
                        "flex w-full items-center justify-between gap-2 border-b border-border-subtle px-3 py-1.5 text-left text-label whitespace-nowrap",
                        selectedKey === ALL_GROUPS_KEY
                            ? "bg-background text-text-primary"
                            : "text-text-secondary hover:bg-layer-hover-01 hover:text-text-primary",
                    ].join(" ")}
                >
                    <span className="truncate">All</span>
                    <span className="shrink-0 text-micro text-text-helper">{totalParams}</span>
                </button>

                {filteredLeaves
                    ? filteredLeaves.map((leaf) => (
                          <GroupRow
                              key={leaf.key}
                              label={leaf.label}
                              count={leaf.count}
                              ownCount={leaf.ownCount}
                              depth={0}
                              isActive={leaf.key === selectedKey}
                              selectable
                              hasToggle={false}
                              expanded={false}
                              onToggle={() => {}}
                              onSelect={() => onSelect(leaf.key)}
                          />
                      ))
                    : tree.map((node) => (
                          <GroupTreeRows
                              key={node.id}
                              node={node}
                              selectedKey={selectedKey}
                              expandedIds={expandedIds}
                              onToggle={toggle}
                              onSelect={onSelect}
                          />
                      ))}
            </div>
        </div>
    );
}

interface ParamRowsProps {
    rows: ParamMatch[];
    showGroup: boolean;
    selected: ParamMatch | null;
    onSelect: (match: ParamMatch) => void;
    live: Map<string, LiveParamEntry>;
}

function ParamRows({rows, showGroup, selected, onSelect, live}: ParamRowsProps) {
    return (
        <table className="w-full border-collapse text-label">
            <thead className="sticky top-0 bg-layer-01 text-text-helper">
                <tr className="text-left">
                    <th className="border-b border-border-subtle px-3 py-2 font-normal">Name</th>
                    {showGroup && <th className="border-b border-border-subtle px-3 py-2 font-normal">Group</th>}
                    <th className="border-b border-border-subtle px-3 py-2 font-normal">Human name</th>
                    <th className="border-b border-border-subtle px-3 py-2 font-normal">Value</th>
                    <th className="border-b border-border-subtle px-3 py-2 font-normal">Units</th>
                </tr>
            </thead>
            <tbody>
                {rows.map((row) => {
                    const isActive = selected?.param.name === row.param.name && selected?.group === row.group;
                    const liveEntry = live.get(row.param.name);
                    return (
                        <tr
                            key={`${row.group}:${row.param.name}`}
                            role="button"
                            tabIndex={0}
                            aria-pressed={isActive}
                            onClick={() => onSelect(row)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    onSelect(row);
                                }
                            }}
                            className={[
                                "cursor-pointer border-b border-border-subtle-base",
                                isActive ? "bg-layer-hover-01" : "hover:bg-layer-hover-01",
                            ].join(" ")}
                        >
                            <td className="px-3 py-1.5">
                                <div className="flex items-center gap-2">
                                    <span className="font-mono text-text-primary">{row.param.name}</span>
                                    <FlagBadges param={row.param}/>
                                </div>
                            </td>
                            {showGroup && (
                                <td className="px-3 py-1.5 text-text-helper">{groupLabel(row.group)}</td>
                            )}
                            <td className="px-3 py-1.5 text-text-secondary">{row.param.humanName}</td>
                            <td
                                className={[
                                    "px-3 py-1.5 font-mono",
                                    liveEntry ? "text-text-primary" : "text-text-disabled",
                                ].join(" ")}
                                title={liveEntry ? undefined : "Not read from the vehicle yet"}
                            >
                                {liveEntry ? formatParamValue(liveEntry) : "—"}
                            </td>
                            <td className="px-3 py-1.5 text-text-helper">{row.param.unitText ?? row.param.units ?? ""}</td>
                        </tr>
                    );
                })}
            </tbody>
        </table>
    );
}

type ValueInputMode = "structured" | "manual";

interface ParamValueInputProps {
    param: ParamDef;
    liveEntry: LiveParamEntry | undefined;
    connected: boolean;
    onSet: (name: string, value: number) => Promise<number>;
}

/**
 * How to set this parameter's value. A documented `values`/`bitmask` param
 * defaults to its structured control (dropdown or per-bit checkboxes) since
 * that is safer than a bare number — but falls back to Manual, prefilled with
 * the real number, whenever the live value can't be faithfully represented
 * that way: an enum value the docs don't list, or a bitmask with bits set
 * beyond the documented ones. The real value is never hidden behind a control
 * that can't show it.
 */
function ParamValueInput({param, liveEntry, connected, onSet}: ParamValueInputProps) {
    const structured = Boolean(param.values || param.bitmask);

    const documentedMask = useMemo(
        () => (param.bitmask ?? []).reduce((mask, bit) => mask | (1 << bit.value), 0),
        [param.bitmask],
    );
    const liveRounded = liveEntry ? Math.round(liveEntry.value) : null;
    const matchesOption =
        param.values?.some((option) => liveEntry !== undefined && Math.abs(option.value - liveEntry.value) < 1e-6) ??
        false;
    const hasStrayBits = Boolean(param.bitmask) && liveRounded !== null && (liveRounded & ~documentedMask) !== 0;
    const fallsBackToManual = liveEntry !== undefined && ((param.values !== undefined && !matchesOption) || hasStrayBits);

    const [mode, setMode] = useState<ValueInputMode>(structured && !fallsBackToManual ? "structured" : "manual");
    const [manualValue, setManualValue] = useState(() => (liveEntry ? formatParamValue(liveEntry) : ""));
    const [selectedOption, setSelectedOption] = useState(() =>
        liveEntry && matchesOption ? String(liveRounded) : "",
    );
    const [checkedBits, setCheckedBits] = useState<Set<number>>(() => {
        if (!param.bitmask || liveRounded === null) {
            return new Set();
        }
        return new Set(param.bitmask.filter((bit) => (liveRounded & (1 << bit.value)) !== 0).map((bit) => bit.value));
    });
    const [pending, setPending] = useState(false);
    const [result, setResult] = useState<{ok: true; value: number} | {ok: false; message: string} | null>(null);

    const bitmaskTotal = useMemo(
        () => [...checkedBits].reduce((sum, bit) => sum + 2 ** bit, 0),
        [checkedBits],
    );

    const draft: number | null =
        !structured || mode === "manual"
            ? manualValue.trim() === ""
                ? null
                : Number(manualValue)
            : param.values
              ? selectedOption === ""
                  ? null
                  : Number(selectedOption)
              : bitmaskTotal;

    const canSet = connected && !param.readOnly && draft !== null && !Number.isNaN(draft) && !pending;

    const handleSet = async () => {
        if (draft === null) {
            return;
        }
        setPending(true);
        setResult(null);
        try {
            const confirmed = await onSet(param.name, draft);
            setResult({ok: true, value: confirmed});
            // Every control syncs here, not just whichever mode is currently
            // shown — otherwise switching modes after a successful set (e.g.
            // set via Manual, then flip to Select) would still show whatever
            // that other control happened to be seeded with at mount.
            const confirmedRounded = Math.round(confirmed);
            setManualValue(formatParamValue({value: confirmed, paramType: liveEntry?.paramType ?? "REAL32"}));
            if (param.values) {
                const matchesConfirmed = param.values.some((option) => Math.abs(option.value - confirmed) < 1e-6);
                setSelectedOption(matchesConfirmed ? String(confirmedRounded) : "");
            }
            if (param.bitmask) {
                setCheckedBits(
                    new Set(
                        param.bitmask.filter((bit) => (confirmedRounded & (1 << bit.value)) !== 0).map((bit) => bit.value),
                    ),
                );
            }
        } catch (error) {
            setResult({ok: false, message: error instanceof Error ? error.message : String(error)});
        } finally {
            setPending(false);
        }
    };

    const setButtonTitle = param.readOnly
        ? "This parameter is read-only"
        : !connected
          ? "Not connected to a vehicle"
          : undefined;

    return (
        <div className="flex flex-col gap-2 border-t border-border-subtle-base py-2">
            <div className="flex items-center justify-between">
                <span className="text-label text-text-helper">Value</span>
                {structured && (
                    <div className="flex gap-1 text-micro">
                        <button
                            type="button"
                            aria-pressed={mode === "structured"}
                            onClick={() => setMode("structured")}
                            className={[
                                "border px-1.5 py-0.5",
                                mode === "structured"
                                    ? "border-border-strong text-text-primary"
                                    : "border-transparent text-text-helper hover:text-text-primary",
                            ].join(" ")}
                        >
                            {param.bitmask ? "Bits" : "Select"}
                        </button>
                        <button
                            type="button"
                            aria-pressed={mode === "manual"}
                            onClick={() => setMode("manual")}
                            className={[
                                "border px-1.5 py-0.5",
                                mode === "manual"
                                    ? "border-border-strong text-text-primary"
                                    : "border-transparent text-text-helper hover:text-text-primary",
                            ].join(" ")}
                        >
                            Manual
                        </button>
                    </div>
                )}
            </div>

            {(!structured || mode === "manual") && (
                <input
                    type="number"
                    value={manualValue}
                    onChange={(event) => setManualValue(event.target.value)}
                    min={param.range?.[0]}
                    max={param.range?.[1]}
                    step={param.increment ?? "any"}
                    placeholder={liveEntry ? undefined : "— not read yet"}
                    disabled={param.readOnly}
                    className="h-control-sm w-full border border-border-subtle bg-background px-2 font-mono text-body text-text-primary placeholder:text-text-disabled focus-visible:outline-none disabled:text-text-disabled"
                />
            )}

            {structured && mode === "structured" && param.values && (
                <select
                    value={selectedOption}
                    onChange={(event) => setSelectedOption(event.target.value)}
                    disabled={param.readOnly}
                    className="h-control-sm w-full border border-border-subtle bg-background px-2 text-body text-text-primary focus-visible:outline-none disabled:text-text-disabled"
                >
                    <option value="" disabled>
                        {liveEntry ? "— unrecognized value —" : "— not read yet —"}
                    </option>
                    {param.values.map((option) => (
                        <option key={option.value} value={option.value}>
                            {option.value} — {option.label}
                        </option>
                    ))}
                </select>
            )}

            {structured && mode === "structured" && !param.values && param.bitmask && (
                <div className="flex flex-col gap-1">
                    {param.bitmask.map((bit) => (
                        <label key={bit.value} className="flex items-center gap-2 text-label text-text-secondary">
                            <input
                                type="checkbox"
                                checked={checkedBits.has(bit.value)}
                                disabled={param.readOnly}
                                onChange={(event) =>
                                    setCheckedBits((prev) => {
                                        const next = new Set(prev);
                                        if (event.target.checked) {
                                            next.add(bit.value);
                                        } else {
                                            next.delete(bit.value);
                                        }
                                        return next;
                                    })
                                }
                            />
                            {bit.label}
                        </label>
                    ))}
                    {hasStrayBits && (
                        <span className="text-micro text-state-warn">
                            The live value has bits set beyond these — switch to Manual to see the raw number.
                        </span>
                    )}
                    <span className="font-mono text-micro text-text-helper">= {bitmaskTotal}</span>
                </div>
            )}

            <div className="flex items-center gap-2">
                <button
                    type="button"
                    disabled={!canSet}
                    title={setButtonTitle}
                    onClick={handleSet}
                    className="h-control-sm w-fit border border-border-subtle px-3 text-label text-text-primary hover:enabled:bg-layer-hover-01 disabled:text-text-disabled"
                >
                    {pending ? "Setting…" : "Set"}
                </button>
                {result && (
                    <span className={`text-label ${result.ok ? "text-state-ok" : "text-state-danger"}`}>
                        {result.ok
                            ? `Set to ${formatParamValue({value: result.value, paramType: liveEntry?.paramType ?? "REAL32"})}`
                            : result.message}
                    </span>
                )}
            </div>
        </div>
    );
}

interface ParamDetailProps {
    match: ParamMatch | null;
    live: Map<string, LiveParamEntry>;
    connected: boolean;
    onSet: (name: string, value: number) => Promise<number>;
}

function ParamDetail({match, live, connected, onSet}: ParamDetailProps) {
    if (!match) {
        return (
            <div className="flex h-full w-80 shrink-0 items-center justify-center border-l border-border-subtle bg-layer-01 p-6 text-center text-label text-text-helper">
                Select a parameter to see its documentation.
            </div>
        );
    }

    const {param, group} = match;

    return (
        <div className="flex h-full w-80 shrink-0 flex-col gap-4 overflow-auto border-l border-border-subtle bg-layer-01 p-4">
            <div>
                <div className="text-micro text-text-helper uppercase">{groupLabel(group)}</div>
                <div className="font-mono text-heading text-text-primary">{param.name}</div>
                <div className="text-body text-text-secondary">{param.humanName}</div>
            </div>

            <FlagBadges param={param}/>

            <p className="text-body text-text-secondary">{param.description}</p>

            <ParamValueInput
                key={`${group}:${param.name}`}
                param={param}
                liveEntry={live.get(param.name)}
                connected={connected}
                onSet={onSet}
            />

                <div className="flex flex-col gap-1 text-label">
                {(param.units || param.unitText) && (
                    <div className="flex items-center justify-between border-t border-border-subtle-base py-1">
                        <span className="text-text-helper">Units</span>
                        <span className="text-text-primary">{param.unitText ?? param.units}</span>
                    </div>
                )}
                {param.range && (
                    <div className="flex items-center justify-between border-t border-border-subtle-base py-1">
                        <span className="text-text-helper">Range</span>
                        <span className="font-mono text-text-primary">
                            {param.range[0]} – {param.range[1]}
                        </span>
                    </div>
                )}
                {param.increment !== undefined && (
                    <div className="flex items-center justify-between border-t border-border-subtle-base py-1">
                        <span className="text-text-helper">Increment</span>
                        <span className="font-mono text-text-primary">{param.increment}</span>
                    </div>
                )}
            </div>

            {param.values && <OptionTable title="Values" options={param.values}/>}
            {param.bitmask && <OptionTable title="Bitmask" options={param.bitmask}/>}
        </div>
    );
}

/** `HEARTBEAT`'s vehicle type is the only thing that picks a reference sheet
 * — Rover/Sub/AntennaTracker report as "other" and have no sheet here. */
function firmwareOf(kind: VehicleKind | null): VehicleFirmware | null {
    if (kind === "multirotor") {
        return "ArduCopter";
    }
    if (kind === "plane") {
        return "ArduPlane";
    }
    return null;
}

/**
 * Names and structure come from the official ArduCopter/ArduPlane parameter
 * documentation, auto-selected from the connected vehicle's reported type;
 * values come from whatever's actually connected.
 */
export default function ParametersPage() {
    const connection = useConnection();
    const vehicleTelemetry = useVehicle();
    const connected = connection.status === "connected";
    // `vehicleKind` is deliberately kept around after a disconnect (so other
    // views can show it struck through), so it alone can't be trusted to mean
    // "connected" — `connected` is checked independently wherever it matters.
    const firmware = firmwareOf(vehicleTelemetry.vehicleKind);

    const state = useParamSheet(firmware);
    const live = useLiveParams(connection.status);

    const [selectedGroupKey, setSelectedGroupKey] = useState<string | null>(null);
    const [query, setQuery] = useState("");
    const [selected, setSelected] = useState<ParamMatch | null>(null);

    // A fresh sheet starts on its own vehicle-level group, and any selection
    // from the previous firmware stops being meaningful.
    useEffect(() => {
        setSelectedGroupKey(firmware);
        setSelected(null);
        setQuery("");
    }, [firmware]);

    const searchResults = useMemo(() => {
        if (state.status !== "ready") {
            return [];
        }
        return searchParams(state.sheet, query);
    }, [state, query]);

    const groupRows: ParamMatch[] = useMemo(() => {
        if (state.status !== "ready" || !selectedGroupKey) {
            return [];
        }
        if (selectedGroupKey === ALL_GROUPS_KEY) {
            return state.sheet.groups.flatMap((group) =>
                group.params.map((param) => ({group: group.key, param})),
            );
        }
        const group = state.sheet.groups.find((g) => g.key === selectedGroupKey);
        return group ? group.params.map((param) => ({group: group.key, param})) : [];
    }, [state, selectedGroupKey]);

    const searching = query.trim().length > 0;
    const rows = searching ? searchResults : groupRows;
    // The Group column only earns its place when a row's group isn't already
    // implied by the current selection.
    const showGroup = searching || selectedGroupKey === ALL_GROUPS_KEY;

    if (!connected) {
        return (
            <div className="flex h-full w-full items-center justify-center text-label text-text-helper">
                Connect a vehicle to browse its parameters.
            </div>
        );
    }

    if (state.status === "idle") {
        return (
            <div className="flex h-full w-full items-center justify-center text-label text-text-helper">
                {vehicleTelemetry.vehicleKind === "other"
                    ? "This vehicle type isn't supported by the parameter reference yet."
                    : "Waiting for the vehicle to report its type…"}
            </div>
        );
    }

    return (
        <div className="flex h-full w-full">
            {state.status === "loading" && (
                <div className="flex flex-1 items-center justify-center text-label text-text-helper">
                    Loading {firmware} parameter reference…
                </div>
            )}

            {state.status === "error" && (
                <div className="flex flex-1 items-center justify-center text-label text-state-danger">
                    {state.message}
                </div>
            )}

            {state.status === "ready" && (
                <>
                    <GroupList
                        groups={state.sheet.groups}
                        vehicle={state.sheet.vehicle}
                        selectedKey={selectedGroupKey}
                        onSelect={(key) => {
                            setSelectedGroupKey(key);
                            setQuery("");
                        }}
                    />

                    <div className="flex min-w-0 flex-1 flex-col">
                        <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle p-2">
                            <Search size={16} className="shrink-0 text-text-helper"/>
                            <input
                                type="text"
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                                placeholder={`Search all ${state.sheet.groups.reduce((n, g) => n + g.params.length, 0)} ${firmware} parameters…`}
                                className="h-control-sm w-full bg-transparent text-body text-text-primary placeholder:text-text-helper focus-visible:outline-none"
                            />
                            <span className="shrink-0 text-label text-text-helper">
                                {searching ? `${rows.length} matches` : `${rows.length} parameters`}
                            </span>
                            <span className="shrink-0 text-label text-text-helper">
                                {live.total !== null ? `${live.values.size}/${live.total} read` : "Reading…"}
                            </span>
                            <button
                                type="button"
                                onClick={live.refresh}
                                className="h-control-sm border border-border-subtle px-3 text-label text-text-primary hover:bg-layer-hover-01"
                            >
                                Refresh
                            </button>
                        </div>
                        <div className="min-h-0 flex-1 overflow-auto">
                            <ParamRows
                                rows={rows}
                                showGroup={showGroup}
                                selected={selected}
                                onSelect={setSelected}
                                live={live.values}
                            />
                        </div>
                    </div>

                    <ParamDetail match={selected} live={live.values} connected={connected} onSet={live.setParam}/>
                </>
            )}
        </div>
    );
}
