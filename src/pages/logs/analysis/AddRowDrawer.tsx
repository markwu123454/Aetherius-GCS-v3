import {useMemo, useState} from "react";
import {Close} from "@carbon/icons-react";
import {MessageTypeSummary} from "@/lib/logs/analysis.ts";

interface AddRowDrawerProps {
    messageTypes: MessageTypeSummary[];
    addedIds: Set<string>;
    onAdd: (messageType: string, field: string) => void;
    onClose: () => void;
}

/**
 * Lists every message type/field `open_log` found in the log, searchable,
 * to add as a timeline row. A drawer rather than a permanently-docked rail
 * — the row stack wants the horizontal width for the time axis, and this
 * is an occasional action, not something that needs to stay visible.
 *
 * No field-type filtering: `open_log`'s summary doesn't carry per-field
 * type codes, so a text field can be added as a row same as a numeric one
 * — it just draws nothing (`getLogSeries` decodes it to `NaN`), which is a
 * quiet dead end rather than a crash. Worth tightening once the summary
 * carries field types.
 */
export default function AddRowDrawer({messageTypes, addedIds, onAdd, onClose}: AddRowDrawerProps) {
    const [search, setSearch] = useState("");
    const [expanded, setExpanded] = useState<string | null>(null);

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return messageTypes;
        return messageTypes.filter((m) => m.name.toLowerCase().includes(q) || m.fields.some((f) => f.toLowerCase().includes(q)));
    }, [messageTypes, search]);

    return (
        <div className="absolute inset-y-0 right-0 z-20 flex w-72 flex-col border-l border-border-subtle bg-layer-01 shadow-lg">
            <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
                <span className="text-label text-text-primary">Add row</span>
                <button type="button" onClick={onClose} className="text-text-secondary hover:text-text-primary" aria-label="Close">
                    <Close size={16}/>
                </button>
            </div>
            <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search message types or fields…"
                className="border-b border-border-subtle bg-transparent px-3 py-2 text-label text-text-primary outline-none placeholder:text-text-helper"
            />
            <div className="min-h-0 flex-1 overflow-auto">
                {filtered.map((m) => (
                    <div key={m.name} className="border-b border-border-subtle">
                        <button
                            type="button"
                            onClick={() => setExpanded((prev) => (prev === m.name ? null : m.name))}
                            className="flex w-full items-center justify-between px-3 py-2 text-left text-label text-text-primary hover:bg-layer-hover-01"
                        >
                            <span>{m.name}</span>
                            <span className="text-micro text-text-helper">{m.count}</span>
                        </button>
                        {expanded === m.name && (
                            <div className="flex flex-wrap gap-1 px-3 pb-2">
                                {m.fields
                                    .filter((f) => f !== "TimeUS")
                                    .map((field) => {
                                        const id = `${m.name}.${field}`;
                                        const added = addedIds.has(id);
                                        return (
                                            <button
                                                key={field}
                                                type="button"
                                                disabled={added}
                                                onClick={() => onAdd(m.name, field)}
                                                className="border border-border-subtle px-2 py-0.5 text-micro text-text-secondary hover:enabled:bg-layer-hover-01 hover:enabled:text-text-primary disabled:text-text-disabled"
                                            >
                                                {field}
                                            </button>
                                        );
                                    })}
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}
