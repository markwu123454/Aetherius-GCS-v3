import {KeyboardEvent, useEffect, useRef, useState} from "react";
import {Add, ChevronDown, ChevronUp, Close, DocumentExport, DocumentImport, Flash, TrashCan} from "@carbon/icons-react";
import {save as saveDialog, open as openDialog} from "@tauri-apps/plugin-dialog";
import {writeTextFile, readTextFile} from "@tauri-apps/plugin-fs";
import {PanelDefinition} from "@/lib/workspace/panels.ts";
import {PanelArea} from "@/panels/panelComponents.tsx";
import {useVehicle} from "@/lib/vehicle/useVehicle.ts";
import {useConnection} from "@/lib/vehicle/useConnection.ts";
import {VehicleState} from "@/lib/vehicle/vehicle.ts";
import {ConnectionStatus} from "@/lib/vehicle/connection.ts";
import {ChecklistFile, ChecklistItem} from "./types.ts";
import {conditionLabel, evaluateCondition} from "./conditions.ts";

const STORAGE_KEY = "aetherius.checklist.v1";
const FILE_FILTERS = [{name: "Checklist", extensions: ["json"]}];

interface PersistedState {
    checklists: ChecklistFile[];
    activeIndex: number;
}

function makeId(): string {
    return Math.random().toString(36).slice(2, 10);
}

const FIRST_TIME_SETUP: ChecklistFile = {
    version: 1,
    name: "First-Time Setup",
    items: [
        {id: "setup-01", text: "You're in Aetherius GCS — tick this off and keep this panel open", checked: false},
        {id: "setup-02", text: "Plug flight controller into computer via USB", checked: false},
        {id: "setup-03", text: "Flash ArduPilot — ☰ › Vehicle › Firmware, pick Copter, Plane or Rover", checked: false},
        {id: "setup-04", text: "Connect to FC — click Connect (top right), pick your COM port", checked: false, autoCheck: {type: "connected"}, autoUncheck: {type: "disconnected"}},
        {id: "setup-05", text: "Set frame class — ☰ › Vehicle › Setup › Frame — Quad, Hex, Octo…", checked: false},
        {id: "setup-06", text: "Set frame geometry — same page — X, +, V, H…", checked: false},
        {id: "setup-07", text: "Calibrate accelerometer — ☰ › Vehicle › Calibration › Accelerometer", checked: false},
        {id: "setup-08", text: "Calibrate gyro — ☰ › Vehicle › Calibration › Gyro (just click Start)", checked: false},
        {id: "setup-09", text: "Calibrate compass — ☰ › Vehicle › Calibration › Compass, rotate through all axes", checked: false},
        {id: "setup-10", text: "Wire RC receiver to FC — CRSF, SBUS or PPM port (check your FC pinout)", checked: false},
        {id: "setup-11", text: "Bind transmitter to receiver — follow your receiver manual", checked: false},
        {id: "setup-12", text: "Calibrate radio — ☰ › Vehicle › Calibration › Radio, move all sticks and switches to limits", checked: false},
        {id: "setup-13", text: "Set flight modes — ☰ › Vehicle › Parameters, search FLTMODE — set Stabilize, Loiter, RTL", checked: false},
        {id: "setup-14", text: "Set RC failsafe — ☰ › Vehicle › Parameters, search FS_THR_ENABLE = 1", checked: false},
        {id: "setup-15", text: "Set RTL altitude — ☰ › Vehicle › Parameters, RTL_ALT = 3000 (means 30 m)", checked: false},
        {id: "setup-16", text: "REMOVE ALL PROPELLERS before the next step — every one", checked: false},
        {id: "setup-17", text: "Test motors — ☰ › Vehicle › Setup › Motor Test, all spin without grinding", checked: false},
        {id: "setup-18", text: "Motor directions correct — compare to frame diagram on your FC manufacturer's page", checked: false},
        {id: "setup-19", text: "Wrong direction? Swap any 2 of the 3 wires between ESC and that motor", checked: false},
        {id: "setup-20", text: "Install propellers — CW prop on CW motor, CCW on CCW (printed on the blade or hub)", checked: false},
        {id: "setup-21", text: "First-time setup done — use a pre-flight checklist before every flight from now on", checked: false},
    ],
};

function loadState(): PersistedState {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) throw new Error("empty");
        const parsed = JSON.parse(raw) as PersistedState;
        if (!Array.isArray(parsed.checklists) || parsed.checklists.length === 0) throw new Error("invalid");
        return {
            checklists: parsed.checklists,
            activeIndex: Math.max(0, Math.min(parsed.activeIndex ?? 0, parsed.checklists.length - 1)),
        };
    } catch {
        return {checklists: [FIRST_TIME_SETUP], activeIndex: 0};
    }
}

function getEffectiveChecked(item: ChecklistItem, vehicle: VehicleState, status: ConnectionStatus): boolean {
    if (item.autoCheck && evaluateCondition(item.autoCheck, vehicle, status)) return true;
    if (item.autoUncheck && evaluateCondition(item.autoUncheck, vehicle, status)) return false;
    return item.checked;
}

function getAutoLocked(item: ChecklistItem, vehicle: VehicleState, status: ConnectionStatus): boolean {
    return !!(
        (item.autoCheck && evaluateCondition(item.autoCheck, vehicle, status)) ||
        (item.autoUncheck && evaluateCondition(item.autoUncheck, vehicle, status))
    );
}

function buildAutoTitle(item: ChecklistItem): string {
    const parts: string[] = [];
    if (item.autoCheck) parts.push(conditionLabel(item.autoCheck));
    if (item.autoUncheck) parts.push(conditionLabel(item.autoUncheck));
    return parts.join("\n");
}

// ---------- ItemRow ----------

interface ItemRowProps {
    item: ChecklistItem;
    effectiveChecked: boolean;
    /** True when an auto condition is currently controlling this item's state. */
    autoActive: boolean;
    /** True when the item has any auto condition defined — toggle is always disabled. */
    hasAuto: boolean;
    isFirst: boolean;
    isLast: boolean;
    isEditing: boolean;
    editText: string;
    onToggle: () => void;
    onStartEdit: () => void;
    onEditChange: (text: string) => void;
    onEditDone: () => void;
    onEditCancel: () => void;
    onMoveUp: () => void;
    onMoveDown: () => void;
    onDelete: () => void;
}

function ItemRow({
    item, effectiveChecked, autoActive, hasAuto, isFirst, isLast,
    isEditing, editText,
    onToggle, onStartEdit, onEditChange, onEditDone, onEditCancel,
    onMoveUp, onMoveDown, onDelete,
}: ItemRowProps) {
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (isEditing) {
            inputRef.current?.focus();
            inputRef.current?.select();
        }
    }, [isEditing]);

    return (
        <div className="group flex items-center border-b border-border-subtle/40 px-2 py-1 last:border-b-0 hover:bg-layer-hover-01">
            {/* Checkbox */}
            <button
                className={[
                    "mr-2 shrink-0 transition-opacity",
                    hasAuto ? "cursor-default opacity-50" : "cursor-pointer hover:opacity-70",
                    effectiveChecked ? "text-state-ok" : "text-text-helper",
                ].join(" ")}
                onClick={hasAuto ? undefined : onToggle}
                title={hasAuto ? "Controlled by auto-condition" : effectiveChecked ? "Uncheck" : "Check"}
            >
                {effectiveChecked
                    ? <span className="flex h-4 w-4 items-center justify-center bg-state-ok text-text-on-color"><span className="text-micro font-bold">✓</span></span>
                    : <span className="flex h-4 w-4 items-center justify-center border border-text-helper" />
                }
            </button>

            {/* Text / inline edit */}
            <div className="min-w-0 flex-1">
                {isEditing ? (
                    <input
                        ref={inputRef}
                        className="w-full border border-state-info bg-layer-02 px-1 text-label text-text-primary outline-none"
                        value={editText}
                        onChange={(e) => onEditChange(e.target.value)}
                        onBlur={onEditDone}
                        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                            if (e.key === "Enter") onEditDone();
                            if (e.key === "Escape") onEditCancel();
                        }}
                    />
                ) : (
                    <span
                        className={[
                            "block cursor-default select-none truncate text-label",
                            effectiveChecked ? "text-text-secondary line-through" : "text-text-primary",
                        ].join(" ")}
                        onDoubleClick={onStartEdit}
                        title="Double-click to rename"
                    >
                        {item.text}
                    </span>
                )}
            </div>

            {/* Auto-condition indicator */}
            {hasAuto && (
                <span
                    className={["ml-1 shrink-0", autoActive ? "text-state-info" : "text-text-helper"].join(" ")}
                    title={buildAutoTitle(item)}
                >
                    <Flash size={12} />
                </span>
            )}

            {/* Reorder / delete — visible on hover */}
            <div className="ml-1 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                    className="p-0.5 text-text-helper hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30"
                    onClick={onMoveUp}
                    disabled={isFirst}
                    title="Move up"
                >
                    <ChevronUp size={14} />
                </button>
                <button
                    className="p-0.5 text-text-helper hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30"
                    onClick={onMoveDown}
                    disabled={isLast}
                    title="Move down"
                >
                    <ChevronDown size={14} />
                </button>
                <button
                    className="p-0.5 text-text-helper hover:text-state-danger"
                    onClick={onDelete}
                    title="Delete item"
                >
                    <Close size={14} />
                </button>
            </div>
        </div>
    );
}

// ---------- ChecklistPanel ----------

export default function ChecklistPanel({panel: _panel, area: _area}: {panel: PanelDefinition; area: PanelArea}) {
    const vehicle = useVehicle();
    const connection = useConnection();

    const [state, setState] = useState<PersistedState>(loadState);
    const [editingItemId, setEditingItemId] = useState<string | null>(null);
    const [editText, setEditText] = useState("");
    const [editingName, setEditingName] = useState(false);
    const [nameText, setNameText] = useState("");
    const [error, setError] = useState<string | null>(null);

    const nameInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }, [state]);

    useEffect(() => {
        if (editingName) {
            nameInputRef.current?.focus();
            nameInputRef.current?.select();
        }
    }, [editingName]);

    const {checklists, activeIndex} = state;
    const current = checklists[activeIndex] ?? null;

    // ---------- item mutations ----------

    function updateItems(fn: (items: ChecklistItem[]) => ChecklistItem[]): void {
        setState((prev) => ({
            ...prev,
            checklists: prev.checklists.map((cl, i) =>
                i === prev.activeIndex ? {...cl, items: fn(cl.items)} : cl,
            ),
        }));
    }

    function toggleItem(id: string): void {
        updateItems((items) =>
            items.map((item) => (item.id === id ? {...item, checked: !item.checked} : item)),
        );
    }

    function addItem(): void {
        const newItem: ChecklistItem = {id: makeId(), text: "New item", checked: false};
        updateItems((items) => [...items, newItem]);
        setEditingItemId(newItem.id);
        setEditText("New item");
    }

    function deleteItem(id: string): void {
        updateItems((items) => items.filter((item) => item.id !== id));
        if (editingItemId === id) setEditingItemId(null);
    }

    function moveItem(id: string, dir: "up" | "down"): void {
        updateItems((items) => {
            const idx = items.findIndex((item) => item.id === id);
            if (idx < 0) return items;
            const target = dir === "up" ? idx - 1 : idx + 1;
            if (target < 0 || target >= items.length) return items;
            const next = [...items];
            [next[idx], next[target]] = [next[target]!, next[idx]!];
            return next;
        });
    }

    function startEditItem(item: ChecklistItem): void {
        setEditingItemId(item.id);
        setEditText(item.text);
    }

    function finishEditItem(): void {
        if (!editingItemId) return;
        const trimmed = editText.trim();
        if (trimmed) {
            updateItems((items) =>
                items.map((item) => (item.id === editingItemId ? {...item, text: trimmed} : item)),
            );
        }
        setEditingItemId(null);
    }

    // ---------- checklist-level ----------

    function createChecklist(): void {
        const newCl: ChecklistFile = {version: 1, name: "New Checklist", items: []};
        setState((prev) => ({
            checklists: [...prev.checklists, newCl],
            activeIndex: prev.checklists.length,
        }));
        setNameText("New Checklist");
        setEditingName(true);
    }

    function deleteChecklist(): void {
        if (checklists.length <= 1) return;
        setState((prev) => {
            const next = prev.checklists.filter((_, i) => i !== prev.activeIndex);
            return {checklists: next, activeIndex: Math.max(0, Math.min(prev.activeIndex, next.length - 1))};
        });
    }

    function startEditName(): void {
        setNameText(current?.name ?? "");
        setEditingName(true);
    }

    function finishEditName(): void {
        const trimmed = nameText.trim();
        if (trimmed) {
            setState((prev) => ({
                ...prev,
                checklists: prev.checklists.map((cl, i) =>
                    i === prev.activeIndex ? {...cl, name: trimmed} : cl,
                ),
            }));
        }
        setEditingName(false);
    }

    function switchChecklist(index: number): void {
        setEditingItemId(null);
        setState((prev) => ({...prev, activeIndex: index}));
    }

    // ---------- file I/O ----------

    async function exportChecklist(): Promise<void> {
        if (!current) return;
        setError(null);
        try {
            const defaultPath = current.name.replace(/[^a-zA-Z0-9_-]/g, "_") + ".json";
            const path = await saveDialog({defaultPath, filters: FILE_FILTERS});
            if (!path) return;
            await writeTextFile(path, JSON.stringify(current, null, 2));
        } catch (e) {
            setError(e instanceof Error ? e.message : "Export failed");
        }
    }

    async function importChecklist(): Promise<void> {
        setError(null);
        try {
            const path = await openDialog({multiple: false, filters: FILE_FILTERS});
            if (!path || Array.isArray(path)) return;
            const text = await readTextFile(path);
            const data = JSON.parse(text) as Partial<ChecklistFile>;
            if (data.version !== 1 || !Array.isArray(data.items) || typeof data.name !== "string") {
                throw new Error("Not a recognized checklist file.");
            }
            const imported: ChecklistFile = {
                version: 1,
                name: data.name,
                items: data.items.map((item) => ({...item, id: item.id || makeId()})),
            };
            setState((prev) => ({
                checklists: [...prev.checklists, imported],
                activeIndex: prev.checklists.length,
            }));
        } catch (e) {
            setError(e instanceof Error ? e.message : "Import failed");
        }
    }

    // ---------- render ----------

    const items = current?.items ?? [];
    const doneCount = items.filter((item) => getEffectiveChecked(item, vehicle, connection.status)).length;

    return (
        <div className="flex h-full flex-col bg-background">
            {/* Header */}
            <div className="flex shrink-0 items-center gap-1 border-b border-border-subtle px-2 py-1.5">
                {editingName ? (
                    <input
                        ref={nameInputRef}
                        className="min-w-0 flex-1 border border-state-info bg-layer-02 px-1 text-label text-text-primary outline-none"
                        value={nameText}
                        onChange={(e) => setNameText(e.target.value)}
                        onBlur={finishEditName}
                        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                            if (e.key === "Enter") finishEditName();
                            if (e.key === "Escape") setEditingName(false);
                        }}
                    />
                ) : (
                    <select
                        className="min-w-0 flex-1 border border-border-subtle bg-layer-02 px-1 text-label text-text-primary outline-none"
                        value={activeIndex}
                        onChange={(e) => {
                            if (e.target.value === "__new__") createChecklist();
                            else switchChecklist(Number(e.target.value));
                        }}
                        onDoubleClick={startEditName}
                        title="Switch checklist · double-click to rename"
                    >
                        {checklists.map((cl, i) => (
                            <option key={i} value={i}>{cl.name}</option>
                        ))}
                        <option value="__new__">+ New checklist</option>
                    </select>
                )}

                <button className="shrink-0 p-1 text-text-helper hover:text-text-primary" onClick={addItem} title="Add item">
                    <Add size={16} />
                </button>
                {checklists.length > 1 && (
                    <button className="shrink-0 p-1 text-text-helper hover:text-state-danger" onClick={deleteChecklist} title="Delete this checklist">
                        <TrashCan size={16} />
                    </button>
                )}
                <button className="shrink-0 p-1 text-text-helper hover:text-text-primary" onClick={importChecklist} title="Import checklist from file">
                    <DocumentImport size={16} />
                </button>
                <button className="shrink-0 p-1 text-text-helper hover:text-text-primary" onClick={exportChecklist} title="Export checklist to file">
                    <DocumentExport size={16} />
                </button>
            </div>

            {/* Error banner */}
            {error && (
                <div className="flex shrink-0 items-center justify-between border-b border-state-danger/40 bg-state-danger/10 px-3 py-1.5">
                    <span className="text-label text-state-danger">{error}</span>
                    <button className="text-text-helper hover:text-text-primary" onClick={() => setError(null)}>
                        <Close size={14} />
                    </button>
                </div>
            )}

            {/* Item list */}
            <div className="min-h-0 flex-1 overflow-y-auto">
                {items.length === 0 ? (
                    <div className="px-3 py-4 text-center text-label text-text-helper">
                        No items — click + below to add one.
                    </div>
                ) : (
                    items.map((item, index) => (
                        <ItemRow
                            key={item.id}
                            item={item}
                            effectiveChecked={getEffectiveChecked(item, vehicle, connection.status)}
                            autoActive={getAutoLocked(item, vehicle, connection.status)}
                            hasAuto={!!(item.autoCheck || item.autoUncheck)}
                            isFirst={index === 0}
                            isLast={index === items.length - 1}
                            isEditing={editingItemId === item.id}
                            editText={editText}
                            onToggle={() => toggleItem(item.id)}
                            onStartEdit={() => startEditItem(item)}
                            onEditChange={setEditText}
                            onEditDone={finishEditItem}
                            onEditCancel={() => setEditingItemId(null)}
                            onMoveUp={() => moveItem(item.id, "up")}
                            onMoveDown={() => moveItem(item.id, "down")}
                            onDelete={() => deleteItem(item.id)}
                        />
                    ))
                )}
            </div>

            {/* Footer */}
            <div className="flex shrink-0 items-center border-t border-border-subtle px-2 py-1.5">
                <span className="ml-auto text-micro text-text-helper tabular-nums">
                    {doneCount}/{items.length}
                </span>
            </div>
        </div>
    );
}
