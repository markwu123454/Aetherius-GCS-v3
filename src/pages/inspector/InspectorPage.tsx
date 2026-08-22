import {useMemo, useState} from "react";
import {Search} from "@carbon/icons-react";
import {useInspectorStats} from "@/lib/inspector/useInspectorStats.ts";
import type {InspectorRow} from "@/lib/inspector/inspector.ts";

/** A row whose last arrival is older than this reads as stopped rather than
 * merely slow — long enough to ride out an ordinary radio hiccup, short
 * enough that "stopped" is still noticed quickly. */
const STALE_MS = 3000;

function ageText(ageMs: number): string {
    if (ageMs < 1000) return `${ageMs}ms`;
    return `${(ageMs / 1000).toFixed(1)}s`;
}

interface RowProps {
    row: InspectorRow;
    isSelected: boolean;
    onSelect: () => void;
}

function StatRow({row, isSelected, onSelect}: RowProps) {
    const stale = row.ageMs > STALE_MS;
    return (
        <button
            type="button"
            onClick={onSelect}
            className={[
                "grid w-full grid-cols-[1fr_70px_80px_70px] items-center border-b border-border-subtle-base px-3 py-1.5 text-left",
                isSelected ? "bg-layer-hover-01 text-text-primary" : "text-text-secondary hover:bg-layer-hover-01",
            ].join(" ")}
        >
            <span className={["truncate font-mono", stale ? "text-text-disabled" : "text-text-primary"].join(" ")}>
                {row.name}
            </span>
            <span className="text-right font-mono text-micro">{stale ? "—" : row.hz.toFixed(1)}</span>
            <span className="text-right font-mono text-micro">{row.count}</span>
            <span className={["text-right font-mono text-micro", stale ? "text-state-warn" : "text-text-helper"].join(" ")}>
                {ageText(row.ageMs)}
            </span>
        </button>
    );
}

/**
 * Raw MAVLink traffic, verbatim — one row per message type seen since
 * launch (or since Clear), with Hz/count/age and up to its last 10 messages
 * expandable on the right, newest first. Owns no interpretation of any
 * message; this is the one page in the app that deliberately doesn't turn
 * wire data into a judgment, for exactly the case every other page's
 * judgment turns out to be wrong or incomplete and the raw traffic is what's
 * needed to tell why.
 */
export default function InspectorPage() {
    const stats = useInspectorStats();
    const [query, setQuery] = useState("");
    const [selectedName, setSelectedName] = useState<string | null>(null);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        const rows = q ? stats.rows.filter((r) => r.name.toLowerCase().includes(q)) : stats.rows;
        return [...rows].sort((a, b) => a.name.localeCompare(b.name));
    }, [stats.rows, query]);

    const selected = selectedName ? stats.rows.find((r) => r.name === selectedName) ?? null : null;

    return (
        <div className="flex h-full w-full">
            <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle p-2">
                    <Search size={16} className="shrink-0 text-text-helper"/>
                    <input
                        type="text"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Filter message types…"
                        className="h-control-sm w-full bg-transparent text-body text-text-primary placeholder:text-text-helper focus-visible:outline-none"
                    />
                    <span className="shrink-0 text-label text-text-helper">
                        {filtered.length} of {stats.rows.length} types
                    </span>
                    <button
                        type="button"
                        onClick={stats.clear}
                        className="h-control-sm border border-border-subtle px-3 text-label text-text-primary hover:bg-layer-hover-01"
                    >
                        Clear
                    </button>
                </div>

                <div className="grid shrink-0 grid-cols-[1fr_70px_80px_70px] border-b border-border-subtle bg-layer-01 px-3 py-2 text-left text-label text-text-helper">
                    <div>Message</div>
                    <div className="text-right">Hz</div>
                    <div className="text-right">Count</div>
                    <div className="text-right">Age</div>
                </div>

                <div className="min-h-0 flex-1 overflow-auto">
                    {filtered.length === 0 ? (
                        <div className="flex h-full items-center justify-center text-label text-text-helper">
                            {stats.rows.length === 0 ? "Waiting for traffic…" : "No message types match."}
                        </div>
                    ) : (
                        filtered.map((row) => (
                            <StatRow
                                key={row.name}
                                row={row}
                                isSelected={row.name === selectedName}
                                onSelect={() => setSelectedName(row.name === selectedName ? null : row.name)}
                            />
                        ))
                    )}
                </div>
            </div>

            <div className="flex h-full w-96 shrink-0 flex-col border-l border-border-subtle bg-layer-01">
                {selected ? (
                    <>
                        <div className="shrink-0 border-b border-border-subtle p-3">
                            <div className="font-mono text-heading text-text-primary">{selected.name}</div>
                            <div className="text-label text-text-helper">
                                {selected.count} received · last {ageText(selected.ageMs)} ago
                            </div>
                        </div>
                        <div className="min-h-0 flex-1 overflow-auto">
                            {selected.history.map((msg, i) => (
                                <pre
                                    key={i}
                                    className="border-b border-border-subtle-base p-3 font-mono text-micro text-text-secondary last:border-b-0"
                                >
                                    {JSON.stringify(msg, null, 2)}
                                </pre>
                            ))}
                        </div>
                    </>
                ) : (
                    <div className="flex h-full items-center justify-center p-6 text-center text-label text-text-helper">
                        Select a message type to see its recent raw messages.
                    </div>
                )}
            </div>
        </div>
    );
}
