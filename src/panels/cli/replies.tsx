import {ReactNode, useState} from "react";
import {ChevronDown, ChevronRight} from "@carbon/icons-react";
import type {CliRecord} from "@/lib/cli/cli.ts";
import {countChanges, diffLines, hunks} from "./diff.ts";
import LineChart from "./LineChart.tsx";

/* The reply layouts the CLI panel draws in an expanded row — one per shape
 * of `data`, shared by every command that replies with that shape. */

type Json = Record<string, unknown>;

const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const num = (v: unknown): number => (typeof v === "number" ? v : Number.NaN);

export function fmt(v: unknown, places = 3): string {
    if (typeof v !== "number") return v === null || v === undefined ? "—" : String(v);
    if (!Number.isFinite(v)) return "—";
    if (Number.isInteger(v)) return String(v);
    return String(Number(v.toFixed(places)));
}

export function size(bytes: number): string {
    if (!Number.isFinite(bytes)) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function logTime(secs: number, decimals = 1): string {
    if (!Number.isFinite(secs)) return "—";
    const minutes = Math.floor(secs / 60);
    const rest = secs - minutes * 60;
    return `${minutes}:${rest.toFixed(decimals).padStart(decimals ? 3 + decimals : 2, "0")}`;
}

const thousands = (n: number) => (Number.isFinite(n) ? n.toLocaleString("en-US") : "—");

/* ---------- building blocks ---------- */

export function Mono({children, className = ""}: {children: ReactNode; className?: string}) {
    return <span className={`font-mono ${className}`}>{children}</span>;
}

export function KeyValue({rows}: {rows: [string, ReactNode][]}) {
    return (
        <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-2 gap-y-1">
            {rows
                .filter(([, v]) => v !== null && v !== undefined && v !== "")
                .map(([k, v]) => (
                    <div key={k} className="contents">
                        <span className="text-text-helper">{k}</span>
                        <span className="min-w-0 font-mono break-words">{v}</span>
                    </div>
                ))}
        </div>
    );
}

export function Table({headers, rows, right = []}: {headers: string[]; rows: ReactNode[][]; right?: number[]}) {
    return (
        <div className="overflow-x-auto">
            <table className="w-full border-collapse">
                <thead>
                    <tr>
                        {headers.map((h, i) => (
                            <th
                                key={h + i}
                                className={`border-b border-border-subtle-base pr-2 pb-1 text-micro font-normal whitespace-nowrap text-text-helper uppercase last:pr-0 ${right.includes(i) ? "text-right" : "text-left"}`}
                            >
                                {h}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row, r) => (
                        <tr key={r}>
                            {row.map((cell, i) => (
                                <td key={i} className={`pt-1 pr-2 font-mono whitespace-nowrap last:pr-0 ${right.includes(i) ? "text-right" : ""}`}>
                                    {cell}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function Chip({children, tone = "neutral"}: {children: ReactNode; tone?: "neutral" | "bad"}) {
    return (
        <span
            className={`shrink-0 border px-1 text-micro uppercase ${tone === "bad" ? "border-red-40 text-red-40" : "border-border-subtle text-text-helper"}`}
        >
            {children}
        </span>
    );
}

function Check({ok}: {ok: boolean}) {
    return ok ? (
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="#c6c6c6" strokeWidth="1.5" aria-hidden="true">
            <path d="M3 8.5l3 3 7-7"/>
        </svg>
    ) : (
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="#ff8389" strokeWidth="1.5" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8"/>
        </svg>
    );
}

function CodeBlock({lines, label}: {lines: {sign?: " " | "-" | "+"; no?: number | null; text: string}[]; label: string}) {
    return (
        <div role="region" aria-label={label} className="overflow-x-auto border border-border-subtle-base bg-background py-1 font-mono text-label">
            {lines.map((line, i) => (
                <div
                    key={i}
                    className={`flex ${line.sign === "-" ? "bg-[rgba(250,77,86,0.15)]" : line.sign === "+" ? "bg-[rgba(36,161,72,0.2)]" : ""}`}
                >
                    <span className="w-8 shrink-0 pr-2 text-right text-gray-50">{line.no ?? ""}</span>
                    {line.sign !== undefined && (
                        <span className={`w-4 shrink-0 text-center ${line.sign === "-" ? "text-red-40" : line.sign === "+" ? "text-green-40" : ""}`}>
                            {line.sign === " " ? "" : line.sign === "-" ? "−" : "+"}
                        </span>
                    )}
                    <span className="pr-2 whitespace-pre">{line.text}</span>
                </div>
            ))}
        </div>
    );
}

/** A file's change as a diff with three lines of context, or the whole
 * file when it's new. */
function FileDiff({oldText, newText, label}: {oldText: string | null; newText: string; label: string}) {
    if (oldText === null) {
        const lines = newText.split(/\r?\n/);
        return <CodeBlock label={label} lines={lines.slice(0, 400).map((text, i) => ({no: i + 1, text}))}/>;
    }
    const lines = diffLines(oldText, newText);
    if (!lines) return <CodeBlock label={label} lines={[{text: "too large to diff here"}]}/>;
    const shown = hunks(lines);
    if (!shown.some((l) => l && l.kind !== " ")) return <span className="text-text-helper">unchanged</span>;
    return (
        <CodeBlock
            label={label}
            lines={shown.map((l) => (l ? {sign: l.kind, no: l.kind === "-" ? l.oldNo : l.newNo, text: l.text} : {text: "…"}))}
        />
    );
}

function diffStat(oldText: string | null, newText: string): string {
    if (oldText === null) return `${newText.split(/\r?\n/).length} lines`;
    const lines = diffLines(oldText, newText);
    if (!lines) return "";
    const {added, removed} = countChanges(lines);
    return `+${added} −${removed}`;
}

/* ---------- approvals ---------- */

export function ApprovalView({record}: {record: CliRecord}) {
    const approval = obj(record.approval);
    switch (approval.kind) {
        case "paramChanges":
            return <ParamChangeApproval changes={arr(approval.changes).map(obj)}/>;
        case "scriptFiles":
            return <ScriptFiles files={arr(approval.files).map(obj)}/>;
        case "scriptDelete":
            return (
                <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                        <Mono className="min-w-0 flex-1 truncate text-text-secondary">{str(approval.remote)}</Mono>
                        <Chip tone="bad">Delete</Chip>
                    </div>
                    <CodeBlock label="File to delete" lines={str(approval.old).split(/\r?\n/).slice(0, 30).map((text, i) => ({no: i + 1, text}))}/>
                </div>
            );
        case "logPull":
            return <KeyValue rows={[["Log", str(approval.id)], ["Size", size(num(approval.bytes))]]}/>;
        case "reboot":
            return <span>Reboot the vehicle</span>;
        case "watch":
            return <KeyValue rows={[["Watching", `${str(approval.folder)} → ${str(approval.target)}`]]}/>;
        default:
            // A plain command: the row already shows the command line.
            return null;
    }
}

function ParamChangeApproval({changes}: {changes: Json[]}) {
    const outOfRange = changes.filter((c) => c.outOfRange === true).map((c) => str(c.name));
    return (
        <div className="flex flex-col gap-2">
            <Table
                headers={["Parameter", "Current", "New", "Range"]}
                right={[1, 2, 3]}
                rows={changes.map((c) => {
                    const range = arr(c.range);
                    const units = c.units ? ` ${str(c.units)}` : "";
                    return [
                        str(c.name),
                        <span className="text-text-helper">{fmt(c.from, 6)}</span>,
                        <span className={`font-medium ${c.outOfRange ? "text-red-40" : ""}`}>{fmt(c.to, 6)}</span>,
                        <span className="text-text-helper">{range.length === 2 ? `${fmt(range[0], 6)}–${fmt(range[1], 6)}${units}` : "—"}</span>,
                    ];
                })}
            />
            {outOfRange.length > 0 && (
                <div className="flex items-center gap-2">
                    <Chip tone="bad">Out of range</Chip>
                    <Mono>{outOfRange.join(", ")}</Mono>
                </div>
            )}
        </div>
    );
}

function ScriptFiles({files}: {files: Json[]}) {
    const [open, setOpen] = useState<number>(0);
    return (
        <div className="flex flex-col">
            {files.map((file, i) => {
                const oldText = typeof file.old === "string" ? file.old : null;
                const newText = str(file.text);
                const expanded = open === i;
                return (
                    <div key={i} className={i > 0 ? "border-t border-border-subtle-base" : ""}>
                        <button
                            type="button"
                            aria-expanded={expanded}
                            onClick={() => setOpen(expanded ? -1 : i)}
                            className="flex w-full items-center gap-2 py-1 text-left hover:bg-background-hover"
                        >
                            {expanded ? <ChevronDown size={12}/> : <ChevronRight size={12}/>}
                            <Mono className="min-w-0 flex-1 truncate text-text-secondary">{str(file.remote)}</Mono>
                            <Chip>{file.new ? "New file" : "Changed"}</Chip>
                            <Mono className="text-text-helper">{diffStat(oldText, newText)}</Mono>
                        </button>
                        {expanded && (
                            <div className="pb-1">
                                <FileDiff oldText={oldText} newText={newText} label={`Changes to ${str(file.remote)}`}/>
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

/* ---------- finished replies ---------- */

function StatusReply({data}: {data: Json}) {
    const link = obj(data.link);
    const p = obj(data.permissions);
    const params = obj(data.params);
    const connected = data.link !== null && data.link !== undefined;
    return (
        <KeyValue
            rows={[
                ["Link", connected ? [str(link.endpoint), str(link.board)].filter(Boolean).join(" · ") : "none"],
                ["Firmware", connected ? str(data.firmware) : ""],
                ["State", connected ? `${data.armed === true ? "Armed" : data.armed === false ? "Disarmed" : "—"} · ${str(data.mode) || "—"}` : ""],
                ["Params", connected ? `${fmt(params.loaded)} loaded` : ""],
                [
                    "CLI",
                    `reads ${str(p.reads)} · logs ${str(p.logs)} · params ${str(p.params)} · scripts ${str(p.scripts)} · reboot ${str(p.reboot)} · while armed ${str(p.whileArmed)}`,
                ],
            ]}
        />
    );
}

/** Names a `params get/describe` asked for that the vehicle doesn't have. */
function NotOnVehicle({data}: {data: Json}) {
    const missing = arr(data.missing);
    return missing.length > 0 ? <KeyValue rows={[["Not on vehicle", missing.map(str).join(", ")]]}/> : null;
}

function ParamDocReply({data}: {data: Json}) {
    return (
        <div className="flex flex-col gap-4">
            {arr(data.params).map(obj).map((p) => {
                const units = p.units ? ` ${str(p.units)}` : "";
                const range = arr(p.range);
                return (
                    <div key={str(p.name)} className="flex flex-col gap-2">
                        <div className="flex flex-col">
                            <Mono className="font-medium">{str(p.name)}</Mono>
                            {p.humanName ? <span className="text-text-secondary">{str(p.humanName)}</span> : null}
                        </div>
                        <KeyValue
                            rows={[
                                ["Value", `${fmt(p.value, 6)}${units}`],
                                ["Range", range.length === 2 ? `${fmt(range[0], 6)} – ${fmt(range[1], 6)}${units}` : ""],
                                ["Increment", p.increment === null || p.increment === undefined ? "" : fmt(p.increment, 6)],
                                ["Level", str(p.level)],
                                ["Reboot", p.rebootRequired ? "needed after a change" : ""],
                                ["Values", arr(p.values).map(obj).map((v) => `${fmt(v.value)} ${str(v.label)}`).join(" · ")],
                            ]}
                        />
                        {p.description ? <p className="m-0 text-text-secondary">{str(p.description)}</p> : null}
                        {arr(p.bitmask).length > 0 && (
                            <div className="flex flex-col gap-1">
                                <span className="text-micro text-text-helper uppercase">Bits</span>
                                <div className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono">
                                    {arr(p.bitmask).map(obj).map((b) => (
                                        <span key={str(b.bit)} className={`flex items-center gap-1.5 ${b.set ? "" : "text-text-helper"}`}>
                                            <span
                                                aria-hidden="true"
                                                className={`inline-block shrink-0 ${b.set ? "h-2.5 w-2.5 bg-text-primary" : "h-2 w-2 border border-border-strong"}`}
                                            />
                                            {fmt(b.bit)} · {str(b.label)}
                                            {b.set ? <span className="sr-only">, set</span> : null}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

function ChangeResult({data}: {data: Json}) {
    const dry = data.dryRun === true;
    const changes = arr(data.changes).map(obj);
    const skipped = arr(data.skipped).map(str);
    const unchanged = arr(data.unchanged).map(str);
    return (
        <div className="flex flex-col gap-2">
            {changes.length > 0 && (
                <Table
                    headers={["Parameter", "From", "To", dry ? "" : "Result"]}
                    right={[1, 2, 3]}
                    rows={changes.map((c) => [
                        str(c.name),
                        <span className="text-text-helper">{fmt(c.from, 6)}</span>,
                        fmt(c.to, 6),
                        dry ? "" : c.confirmed ? <span className="font-sans text-text-helper">confirmed</span> : <span className="font-sans text-red-40">not confirmed</span>,
                    ])}
                />
            )}
            <div className="flex flex-wrap gap-x-3 font-mono">
                <span>{dry ? "dry run, nothing sent" : changes.length ? `applied ${fmt(data.applied)} of ${fmt(data.total)}` : "nothing to change"}</span>
                {data.rebootNeeded === true && <span className="text-text-secondary">reboot needed</span>}
            </div>
            {unchanged.length > 0 && <KeyValue rows={[["Unchanged", unchanged.join(", ")]]}/>}
            {skipped.length > 0 && <KeyValue rows={[["Not on vehicle", skipped.join(", ")]]}/>}
        </div>
    );
}

function ScriptResult({data}: {data: Json}) {
    const errors = arr(data.luaErrors).map(str);
    const steps: [boolean, string][] = [];
    for (const f of arr(data.files).map(obj)) steps.push([true, `uploaded → ${str(f.remote)} · ${size(num(f.bytes))}${f.new ? " · new" : ""}`]);
    if (data.removed) steps.push([true, `removed ${str(data.removed)}`]);
    if (data.restarted === true) steps.push([true, "scripting restarted"]);
    else if (data.rebootNeeded === true) steps.push([false, "scripting not restarted: reboot to load"]);
    else steps.push([true, "scripting not restarted"]);
    if (data.restarted === true) steps.push([errors.length === 0, errors.length ? `${errors.length} Lua error${errors.length === 1 ? "" : "s"} within 3 s` : "no Lua errors"]);
    return (
        <div className="flex flex-col gap-2">
            <div className="grid grid-cols-[12px_minmax(0,1fr)] items-center gap-x-2 gap-y-1 font-mono">
                {steps.map(([ok, text], i) => (
                    <div key={i} className="contents">
                        <Check ok={ok}/>
                        <span className={`break-all ${ok ? "" : "text-red-40"}`}>{text}</span>
                    </div>
                ))}
            </div>
            {errors.length > 0 && (
                <div role="region" aria-label="Lua errors" className="border border-border-subtle-base bg-background px-2 py-1.5 font-mono break-words text-red-40">
                    {errors.map((e, i) => <div key={i}>{e}</div>)}
                </div>
            )}
        </div>
    );
}

export function WatchPushes({items}: {items: Json[]}) {
    const [open, setOpen] = useState<number | null>(null);
    if (items.length === 0) return <span className="text-text-helper">No pushes yet</span>;
    return (
        <div className="flex flex-col">
            <div className="grid grid-cols-[12px_60px_minmax(0,1fr)_auto] gap-2 border-b border-border-subtle-base pb-1 text-micro text-text-helper uppercase">
                <span/>
                <span>Time</span>
                <span>File</span>
                <span>Result</span>
            </div>
            {items.map((item, i) => {
                const diff = obj(item.diff);
                const bad = !["pushed"].includes(str(item.result));
                return (
                    <div key={i}>
                        <button
                            type="button"
                            aria-expanded={open === i}
                            onClick={() => setOpen(open === i ? null : i)}
                            className="grid w-full grid-cols-[12px_60px_minmax(0,1fr)_auto] items-center gap-2 py-1 text-left hover:bg-background-hover"
                        >
                            {open === i ? <ChevronDown size={12}/> : <ChevronRight size={12}/>}
                            <Mono className="text-text-helper">{str(item.time)}</Mono>
                            <Mono className="truncate">{str(item.file)}</Mono>
                            <Chip tone={bad ? "bad" : "neutral"}>{str(item.result)}</Chip>
                        </button>
                        {open === i && (
                            <div className="mb-1.5 ml-5 flex flex-col gap-1">
                                {diff.new !== undefined && (
                                    <FileDiff oldText={typeof diff.old === "string" ? diff.old : null} newText={str(diff.new)} label={`Changes to ${str(item.file)}`}/>
                                )}
                                {item.reason ? <Mono className="text-text-secondary">{str(item.reason)}</Mono> : null}
                                {arr(item.luaErrors).map((e, k) => (
                                    <Mono key={k} className="break-words text-red-40">{str(e)}</Mono>
                                ))}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

const SEVERITY_CLASS: Record<string, string> = {
    emergency: "text-state-danger",
    alert: "text-state-danger",
    critical: "text-state-danger",
    error: "text-state-danger",
    warning: "text-state-warn",
};

export function MessageList({messages}: {messages: Json[]}) {
    if (messages.length === 0) return <span className="text-text-helper">No messages</span>;
    return (
        <div className="grid grid-cols-[auto_auto_minmax(0,1fr)] gap-x-2 gap-y-1 font-mono">
            {messages.map((m, i) => {
                const tone = SEVERITY_CLASS[str(m.severity)] ?? "";
                return (
                    <div key={i} className="contents">
                        <span className="text-text-helper">{m.time !== undefined ? str(m.time) : logTime(num(m.t))}</span>
                        <span className={tone || "text-text-helper"}>{str(m.severity ?? m.type)}</span>
                        <span className={`break-words ${tone}`}>{str(m.text)}</span>
                    </div>
                );
            })}
        </div>
    );
}

function Segments({data}: {data: Json}) {
    const segments = arr(data.segments).map(obj);
    const armed = arr(data.armed).map(obj);
    const end = Math.max(1, ...segments.map((s) => num(s.to)), ...armed.map((a) => num(a.to)));
    const bar = (from: number, to: number, color: string) => (
        <span className="relative h-2 bg-layer-02">
            <span className="absolute inset-y-0" style={{left: `${(from / end) * 100}%`, width: `${((to - from) / end) * 100}%`, background: color}}/>
        </span>
    );
    return (
        <div role="table" aria-label="Flight modes over the log" className="grid grid-cols-[72px_minmax(0,1fr)_92px] items-center gap-x-2 gap-y-1.5 font-mono">
            {segments.map((s, i) => (
                <div key={i} role="row" className="contents">
                    <span role="cell" className="truncate">{str(s.mode)}</span>
                    <span role="cell">{bar(num(s.from), num(s.to), "#4589ff")}</span>
                    <span role="cell" className="text-right text-text-helper">{logTime(num(s.from), 0)} – {logTime(num(s.to), 0)}</span>
                </div>
            ))}
            {armed.map((a, i) => (
                <div key={`a${i}`} role="row" className="contents">
                    <span role="cell" className="text-text-secondary">Armed</span>
                    <span role="cell">{bar(num(a.from), num(a.to), "#a8a8a8")}</span>
                    <span role="cell" className="text-right text-text-helper">{logTime(num(a.from), 0)} – {logTime(num(a.to), 0)}</span>
                </div>
            ))}
            <span/>
            <span className="flex justify-between text-micro text-text-helper">
                <span>0:00</span>
                <span>{logTime(end / 2, 0)}</span>
                <span>{logTime(end, 0)}</span>
            </span>
            <span/>
        </div>
    );
}

function SeriesReply({data, unit}: {data: Json; unit?: string}) {
    const columns = arr(data.columns).map(str);
    const rows = arr(data.rows).map(arr);
    const x = rows.map((r) => num(r[0]));
    const series = columns.slice(1).map((label, i) => ({label, values: rows.map((r) => (r[i + 1] === null ? Number.NaN : num(r[i + 1])))}));
    return (
        <div className="flex flex-col gap-2">
            <LineChart x={x} series={series} unit={unit} xFormat={(v) => logTime(v, 0)} ariaLabel={`${columns.slice(1).join(", ")} over time`}/>
            <Mono className="text-text-helper">
                {rows.length} rows{data.averaged ? ` · averaged from ${thousands(num(data.samples))} samples` : ""}
            </Mono>
        </div>
    );
}

function SpectrumReply({data, view}: {data: Json; view: Json}) {
    const fields = arr(data.fields).map(obj);
    const spectra = arr(view.spectra).map(obj);
    const x = arr(obj(spectra[0]).bins).map((b) => num(arr(b)[0]));
    const series = spectra.map((s) => ({label: str(s.field), values: arr(s.bins).map((b) => num(arr(b)[1]))}));
    const firstPeaks = arr(obj(fields[0]).peaks).map(obj);
    const peakCount = Math.max(0, ...fields.map((f) => arr(f.peaks).length));
    return (
        <div className="flex flex-col gap-2">
            <Mono className="text-text-helper">
                {fmt(data.sampleRate, 0)} Hz · {fmt(data.resolution, 2)} Hz resolution · {fmt(data.seconds, 0)} s
            </Mono>
            {x.length > 0 && (
                <LineChart
                    x={x}
                    series={series}
                    unit="dB"
                    xFormat={(v) => `${Math.round(v)}`}
                    markers={firstPeaks.map((p) => ({x: num(p.hz), y: num(p.db), label: `${Math.round(num(p.hz))} Hz`}))}
                    ariaLabel={`Spectrum of ${series.map((s) => s.label).join(", ")}`}
                />
            )}
            <Table
                headers={["Field", ...Array.from({length: peakCount}, (_, i) => `Peak ${i + 1}`)]}
                right={Array.from({length: peakCount}, (_, i) => i + 1)}
                rows={fields.map((f) => [
                    str(f.field),
                    ...Array.from({length: peakCount}, (_, i) => {
                        const p = obj(arr(f.peaks)[i]);
                        return p.hz === undefined ? "—" : `${fmt(p.hz, 0)} Hz  ${fmt(p.db, 0)} dB`;
                    }),
                ])}
            />
        </div>
    );
}

function StatsReply({data}: {data: Json}) {
    return (
        <Table
            headers={["Field", "n", "Min", "Max", "Mean", "RMS", "p95"]}
            right={[1, 2, 3, 4, 5, 6]}
            rows={arr(data.fields).map(obj).map((f) => [str(f.field), thousands(num(f.n)), fmt(f.min), fmt(f.max), fmt(f.mean), fmt(f.rms), fmt(f.p95)])}
        />
    );
}

/** The finished reply for `command`, in the layout its data calls for. */
export function ReplyView({record, data}: {record: CliRecord; data: unknown}) {
    const d = obj(data);
    const view = obj(record.view);
    switch (record.command) {
        case "status":
            return <StatusReply data={d}/>;
        case "params get":
            return (
                <div className="flex flex-col gap-2">
                    <Table
                        headers={["Parameter", "Value", ""]}
                        right={[1]}
                        rows={arr(d.params).map(obj).map((p) => [str(p.name), fmt(p.value, 6), <span className="text-text-helper">{str(p.units)}</span>])}
                    />
                    <NotOnVehicle data={d}/>
                </div>
            );
        case "params describe":
            return (
                <div className="flex flex-col gap-4">
                    <ParamDocReply data={d}/>
                    <NotOnVehicle data={d}/>
                </div>
            );
        case "params set":
        case "params apply":
            return <ChangeResult data={d}/>;
        case "params diff":
            return (
                <div className="flex flex-col gap-2">
                    <Table
                        headers={["Parameter", "Vehicle", "File"]}
                        right={[1, 2]}
                        rows={arr(d.differ).map(obj).map((r) => [str(r.name), <span className="text-text-helper">{fmt(r.live, 6)}</span>, <span className="font-medium">{fmt(r.file, 6)}</span>])}
                    />
                    <Mono>{arr(d.differ).length} differ · {fmt(d.same)} same · {arr(d.missing).length} not on vehicle</Mono>
                    {arr(d.missing).length > 0 && <KeyValue rows={[["Not on vehicle", arr(d.missing).map(str).join(", ")]]}/>}
                </div>
            );
        case "params save":
            return <KeyValue rows={[["Saved", `${fmt(d.count)} parameters`], ["File", str(d.path)]]}/>;
        case "params refresh":
            return <KeyValue rows={[["Loaded", `${fmt(d.loaded)} parameters`]]}/>;
        case "script ls":
            return (
                <Table
                    headers={[str(d.dir), "Size"]}
                    right={[1]}
                    rows={arr(d.entries).map(obj).map((e) => [e.dir ? `${str(e.name)}/` : str(e.name), e.dir ? "" : size(num(e.bytes))])}
                />
            );
        case "script pull":
            return <KeyValue rows={[["From", str(d.remote)], ["Size", size(num(d.bytes))]]}/>;
        case "script push":
            if (d.pushed !== undefined) {
                return (
                    <div className="flex flex-col gap-2">
                        <Mono>{fmt(d.pushed)} pushed · {fmt(d.held)} held</Mono>
                        <WatchPushes items={record.items}/>
                    </div>
                );
            }
            return <ScriptResult data={d}/>;
        case "script rm":
        case "script restart":
            return <ScriptResult data={d}/>;
        case "console":
            return <MessageList messages={record.items.length ? record.items : arr(d.messages).map(obj)}/>;
        case "logs ls":
            return (
                <Table
                    headers={["ID", "Date", "Size"]}
                    right={[0, 2]}
                    rows={arr(d.logs).map(obj).map((l) => [fmt(l.id), l.time ? str(l.time).replace("T", " ").slice(0, 16) : "unknown", size(num(l.bytes))])}
                />
            );
        case "logs pull":
            return (
                <KeyValue
                    rows={[
                        ["File", str(d.file)],
                        ["Size", size(num(d.bytes))],
                        ["Took", d.alreadySaved ? "already downloaded" : `${fmt(d.seconds, 1)} s`],
                        ["Earlier", d.earlier ? `${str(d.earlier)} is an earlier log` : ""],
                    ]}
                />
            );
        case "logs local":
            return (
                <Table
                    headers={["ID", "File", "Size", "On vehicle"]}
                    right={[0, 2]}
                    rows={arr(d.logs).map(obj).map((l) => [fmt(l.id), str(l.file), size(num(l.bytes)), l.onVehicle ? "yes" : ""])}
                />
            );
        case "logs info":
            return (
                <KeyValue
                    rows={[
                        ["File", `${str(d.file)} · ${size(num(d.bytes))}`],
                        ["Firmware", str(d.firmware)],
                        ["Start", str(d.start).replace("T", " ")],
                        ["Duration", logTime(num(d.duration), 0)],
                        ["Messages", `${fmt(d.types)} types · ${thousands(num(d.records))} records`],
                    ]}
                />
            );
        case "logs schema": {
            const messages = arr(d.messages).map(obj);
            if (messages.length === 1) {
                const m = messages[0];
                return (
                    <div className="flex flex-col gap-2">
                        <Mono>{str(m.name)} · {fmt(m.rate, 1)} Hz · {thousands(num(m.count))} records</Mono>
                        <Table headers={["Field", "Unit"]} rows={arr(m.fields).map(obj).map((f) => [str(f.name), <span className="text-text-helper">{str(f.unit)}</span>])}/>
                    </div>
                );
            }
            return (
                <Table
                    headers={["Message", "Rate", "Records"]}
                    right={[1, 2]}
                    rows={messages.map((m) => [str(m.name), `${fmt(m.rate, 1)} Hz`, thousands(num(m.count))])}
                />
            );
        }
        case "logs events":
            return <MessageList messages={arr(d.events).map(obj)}/>;
        case "logs segments":
            return <Segments data={d}/>;
        case "logs series":
            return <SeriesReply data={d}/>;
        case "logs stats":
            return <StatsReply data={d}/>;
        case "logs fft":
            return <SpectrumReply data={d} view={view}/>;
        case "logs track-error":
            return (
                <KeyValue
                    rows={[
                        ["RMS", `${fmt(d.rms, 2)} ${str(d.units)}`],
                        ["Max", `${fmt(d.max, 2)} ${str(d.units)}`],
                        ["Mean", `${fmt(d.mean, 2)} ${str(d.units)}`],
                        ["Lag", `${fmt(d.lagMs, 0)} ms`],
                        ["Samples", thousands(num(d.samples))],
                    ]}
                />
            );
        case "logs eval":
            if (d.sampleRate !== undefined) return <SpectrumReply data={d} view={view}/>;
            if (d.columns !== undefined) return <SeriesReply data={d}/>;
            return <StatsReply data={d}/>;
        case "logs export":
            return <KeyValue rows={[["Rows", thousands(arr(d.rows).length || num(d.rows))], ["File", str(d.path)]]}/>;
        case "reboot":
            return (
                <KeyValue
                    rows={[
                        ["Link", d.reconnected ? `back after ${fmt(d.seconds, 1)} s` : "not waited for"],
                        ["Params", d.params === null || d.params === undefined ? "" : `${fmt(d.params)} loaded`],
                    ]}
                />
            );
        case "requests ls":
            return (
                <Table
                    headers={["ID", "Time", "State", "Command"]}
                    rows={arr(d.requests).map(obj).map((r) => [str(r.id), str(r.time), str(r.state), str(r.command)])}
                />
            );
        case "requests stop":
            return <KeyValue rows={[["Stopped", str(d.stopped)]]}/>;
        default:
            return <pre className="m-0 overflow-x-auto font-mono whitespace-pre-wrap">{JSON.stringify(data, null, 2)}</pre>;
    }
}

/** Something to draw for `data`, unless it's empty. */
export function hasData(data: unknown): boolean {
    return data !== null && data !== undefined && !(typeof data === "object" && Object.keys(data as object).length === 0);
}

export function ErrorView({record}: {record: CliRecord}) {
    const error = record.result?.error;
    if (!error) return null;
    const exits: Record<string, number> = {
        vehicle_error: 1, link_lost: 1, script_error: 1, io_error: 1, usage: 2, unknown_param: 2, invalid_value: 2,
        out_of_range: 2, not_found: 2, bad_file: 2, not_enough_data: 2, app_unavailable: 3, version_mismatch: 3,
        no_vehicle: 4, rejected: 5, blocked: 6, expired: 7, stopped: 8, pending: 9,
    };
    const approval = obj(record.approval);
    return (
        <div className="flex flex-col gap-2">
            <Mono className="break-words text-red-40">{error.code}: {error.message}</Mono>
            <KeyValue
                rows={[
                    ["Exit", record.state === "cancelled" ? "" : String(exits[error.code] ?? 1)],
                    ["Setting", error.reason === "armed" ? "While armed · Block" : error.reason === "setting" ? "Category · Block" : ""],
                ]}
            />
            {typeof approval.kind === "string" && approval.kind !== "command" && (
                <div className="flex flex-col gap-1">
                    <span className="text-micro text-text-helper uppercase">Asked</span>
                    <ApprovalView record={record}/>
                </div>
            )}
        </div>
    );
}
