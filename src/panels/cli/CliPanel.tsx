import {RefObject, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore} from "react";
import {ChevronDown, ChevronRight, Copy, Pause, Play, TrashCan} from "@carbon/icons-react";
import {
    clearCliRequests,
    cliStore,
    CliRecord,
    isFinished,
    loadCliRequests,
    resolveRequest,
    setCliPaused,
    stopRequest,
} from "@/lib/cli/cli.ts";
import {useNavigation} from "@/lib/navigation/useNavigation.tsx";
import {ApprovalView, ErrorView, hasData, MessageList, Mono, ReplyView, WatchPushes} from "./replies.tsx";

type Filter = "all" | "writes" | "waiting";

const WRITE_CATEGORIES = ["params", "scripts", "reboot"];

function clock(ms: number): string {
    return new Date(ms).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false});
}

function duration(ms: number): string {
    if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function isStream(record: CliRecord): boolean {
    return record.argv.includes("--watch") || (record.command === "console" && record.argv.includes("--follow"));
}

function chip(record: CliRecord): {label: string; className: string} {
    switch (record.state) {
        case "waiting":
            return {label: "Waiting", className: "border-purple-40 text-purple-40"};
        case "held":
            return {label: "Held", className: "border-purple-40 text-purple-40"};
        case "running":
            return {
                label: record.argv.includes("--watch") ? "Watching" : record.command === "console" ? "Following" : "Running",
                className: "border-blue-40 text-blue-40",
            };
        case "done":
            return {label: "Done", className: "border-border-subtle text-text-helper"};
        case "cancelled":
            return {label: "Cancelled", className: "border-border-subtle text-text-helper"};
        default:
            return {label: record.state[0].toUpperCase() + record.state.slice(1), className: "border-red-40 text-red-40"};
    }
}

/** The caller's folder and its process chain, outermost first, without
 * the CLI itself. */
function Caller({record}: {record: CliRecord}) {
    const chain = record.process.slice(1, 4).reverse().join(" › ");
    return (
        <div className="border-t border-border-subtle-base pt-1.5 font-mono break-all text-text-helper">
            {[record.folder, chain].filter(Boolean).join(" · ")}
        </div>
    );
}

function Button({kind, onClick, children}: {kind: "primary" | "secondary" | "ghost"; onClick: () => void; children: string}) {
    const classes = {
        primary: "bg-blue-60 text-text-on-color hover:bg-[#0050e6] px-4 text-body",
        secondary: "bg-gray-60 text-text-on-color hover:bg-[#606060] px-4 text-body",
        ghost: "ml-auto px-2 text-label text-blue-40 hover:bg-background-hover",
    }[kind];
    return (
        <button type="button" onClick={onClick} className={`h-control-sm ${classes}`}>
            {children}
        </button>
    );
}

/** Whether the element's text is cut off, kept current as it resizes. */
function useTruncated<T extends HTMLElement>(): [RefObject<T | null>, boolean] {
    const ref = useRef<T>(null);
    const [truncated, setTruncated] = useState(false);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const check = () => setTruncated(el.scrollWidth > el.clientWidth);
        check();
        const observer = new ResizeObserver(check);
        observer.observe(el);
        return () => observer.disconnect();
    }, []);
    return [ref, truncated];
}

function Body({record, showArgv}: {record: CliRecord; showArgv: boolean}) {
    const navigation = useNavigation();
    const progress = record.progress ?? {};
    const received = Number(progress.received);
    const total = Number(progress.total);

    return (
        <div className="mr-2 mb-2 ml-7 flex flex-col gap-2 bg-layer-01 p-2 text-label">
            {showArgv && <Mono className="break-all text-text-secondary">{record.argv}</Mono>}

            {record.state === "waiting" && <ApprovalView record={record}/>}

            {(record.state === "running" || record.state === "held") && (
                <>
                    {record.argv.includes("--watch") && <ApprovalView record={record}/>}
                    {record.reason && <span className="text-text-secondary">{record.reason}</span>}
                    {typeof progress.text === "string" && (
                        <div className="flex flex-col gap-1">
                            <Mono>{progress.text}</Mono>
                            {Number.isFinite(received) && Number.isFinite(total) && total > 0 && (
                                <div
                                    role="progressbar"
                                    aria-label="Progress"
                                    aria-valuemin={0}
                                    aria-valuemax={100}
                                    aria-valuenow={Math.round((received / total) * 100)}
                                    className="h-1 bg-layer-02"
                                >
                                    <div className="h-1 bg-blue-50" style={{width: `${(received / total) * 100}%`}}/>
                                </div>
                            )}
                        </div>
                    )}
                    {record.argv.includes("--watch") && <WatchPushes items={record.items}/>}
                    {record.command === "console" && <MessageList messages={record.items}/>}
                </>
            )}

            {isFinished(record.state) && record.result && (
                <>
                    {!record.result.ok && <ErrorView record={record}/>}
                    {(record.result.ok || hasData(record.result.data)) && <ReplyView record={record} data={record.result.data}/>}
                </>
            )}

            <Caller record={record}/>

            {record.state === "waiting" && (
                <div className="flex flex-wrap items-center gap-px">
                    <Button kind="primary" onClick={() => void resolveRequest(record.id, true)}>Approve</Button>
                    <Button kind="secondary" onClick={() => void resolveRequest(record.id, false)}>Reject</Button>
                    {record.category === "params" && <Button kind="ghost" onClick={() => navigation.openPage("parameters")}>Open in Parameters</Button>}
                    {record.category === "scripts" && <Button kind="ghost" onClick={() => navigation.openPage("scripting")}>Open in Scripting</Button>}
                </div>
            )}
            {(record.state === "running" || record.state === "held") && (
                <div className="flex flex-wrap items-center gap-px">
                    <Button kind="secondary" onClick={() => void stopRequest(record.id)}>Stop</Button>
                    {record.argv.includes("--watch") && <Button kind="ghost" onClick={() => navigation.openPage("scripting")}>Open in Scripting</Button>}
                </div>
            )}
        </div>
    );
}

function Row({record, expanded, onToggle, now}: {record: CliRecord; expanded: boolean; onToggle: () => void; now: number}) {
    const {label, className} = chip(record);
    const elapsed = (record.endedAt ?? now) - record.startedAt;
    const [argvRef, argvTruncated] = useTruncated<HTMLSpanElement>();
    return (
        <div className="border-b border-border-subtle/40">
            <button
                type="button"
                aria-expanded={expanded}
                onClick={onToggle}
                className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-background-hover"
            >
                {expanded ? <ChevronDown size={12} className="shrink-0 text-text-secondary"/> : <ChevronRight size={12} className="shrink-0 text-text-secondary"/>}
                <span className="shrink-0 font-mono text-label text-text-helper tabular-nums">{clock(record.startedAt)}</span>
                <span ref={argvRef} className="min-w-0 flex-1 truncate font-mono text-label text-text-primary">{record.argv}</span>
                <span className={`shrink-0 border px-1 text-micro uppercase ${className}`}>{label}</span>
                <span className="w-12 shrink-0 text-right font-mono text-label whitespace-nowrap text-text-helper tabular-nums">{duration(elapsed)}</span>
            </button>
            {expanded && <Body record={record} showArgv={argvTruncated}/>}
        </div>
    );
}

function Section({title, count, tone}: {title: string; count?: number; tone?: string}) {
    return (
        <div className="flex items-center gap-2 px-2 pt-3 pb-1 text-micro text-text-helper uppercase">
            {title}
            {count !== undefined && <span className={`font-mono ${tone ?? ""}`}>{count}</span>}
        </div>
    );
}

export default function CliPanel() {
    const {records, status} = useSyncExternalStore(cliStore.subscribe, cliStore.getSnapshot);
    const navigation = useNavigation();
    const [filter, setFilter] = useState<Filter>("all");
    // Rows flipped away from their default (waiting and streaming rows start
    // open, finished ones closed).
    const [flipped, setFlipped] = useState<Set<string>>(new Set());
    const [now, setNow] = useState(Date.now());

    useEffect(() => {
        void loadCliRequests();
    }, []);

    const all = [...records.values()].sort((a, b) => a.startedAt - b.startedAt);
    const live = all.some((r) => !isFinished(r.state));
    useEffect(() => {
        if (!live) return;
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [live]);

    const visible = all.filter((r) => filter !== "writes" || WRITE_CATEGORIES.includes(r.category));
    const waiting = visible.filter((r) => r.state === "waiting");
    const running = visible.filter((r) => r.state === "running" || r.state === "held");
    const activity = visible.filter((r) => isFinished(r.state));
    const held = all.filter((r) => r.state === "held").length;

    const expanded = (r: CliRecord) => (r.state === "waiting" || (!isFinished(r.state) && isStream(r))) !== flipped.has(r.id);
    const toggle = (id: string) =>
        setFlipped((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    const copy = () => {
        const shown = filter === "waiting" ? waiting : [...waiting, ...running, ...activity];
        void navigator.clipboard?.writeText(shown.map((r) => `${clock(r.startedAt)}  ${r.state.padEnd(9)} ${r.argv}`).join("\n"));
    };

    const filterButton = (value: Filter, label: string) => (
        <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
            className={[
                "border px-1.5 py-0.5 text-label whitespace-nowrap",
                filter === value ? "border-border-strong bg-layer-01 text-text-primary" : "border-border-subtle text-text-helper hover:text-text-secondary",
            ].join(" ")}
        >
            {label}
        </button>
    );

    const rows = (list: CliRecord[]) =>
        list.map((r) => <Row key={r.id} record={r} expanded={expanded(r)} onToggle={() => toggle(r.id)} now={now}/>);

    return (
        <div className="@container flex h-full min-h-0 w-full flex-col bg-background">
            <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border-subtle px-2 py-1">
                {filterButton("all", "All")}
                {filterButton("writes", "Writes")}
                {filterButton("waiting", "Waiting")}
                <div className="ml-auto flex items-center gap-0.5">
                    <button
                        type="button"
                        aria-pressed={status.paused}
                        aria-label={status.paused ? "Resume CLI requests" : "Pause CLI requests"}
                        title={status.paused ? "Resume" : "Pause"}
                        onClick={() => void setCliPaused(!status.paused)}
                        className={`p-1 hover:bg-layer-hover-01 hover:text-text-primary ${status.paused ? "bg-layer-02 text-text-primary" : "text-text-secondary"}`}
                    >
                        {status.paused ? <Play size={14}/> : <Pause size={14}/>}
                    </button>
                    <button type="button" title="Copy visible entries" aria-label="Copy visible entries" onClick={copy} className="p-1 text-text-secondary hover:bg-layer-hover-01 hover:text-text-primary">
                        <Copy size={14}/>
                    </button>
                    <button type="button" title="Clear finished" aria-label="Clear finished" onClick={() => void clearCliRequests()} className="p-1 text-text-secondary hover:bg-layer-hover-01 hover:text-text-primary">
                        <TrashCan size={14}/>
                    </button>
                </div>
            </div>

            {!status.listening && (
                <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle bg-layer-01 px-2 py-1 text-label">
                    <span className="text-text-secondary">CLI access is off</span>
                    <button type="button" onClick={() => navigation.openPage("settings")} className="ml-auto px-2 py-1 text-blue-40 hover:bg-background-hover">
                        Settings
                    </button>
                </div>
            )}
            {status.paused && (
                <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle bg-layer-01 px-2 py-1 text-label">
                    <span className="font-medium text-purple-40">Paused</span>
                    <span className="font-mono text-text-helper">{held} held</span>
                    <button type="button" onClick={() => void setCliPaused(false)} className="ml-auto px-2 py-1 text-blue-40 hover:bg-background-hover">
                        Resume
                    </button>
                </div>
            )}

            <div role="log" aria-label="CLI activity" className="min-h-0 flex-1 overflow-auto">
                {waiting.length > 0 && (
                    <>
                        <Section title="Waiting" count={waiting.length} tone="text-purple-40"/>
                        {rows(waiting)}
                    </>
                )}
                {filter === "waiting" && waiting.length === 0 && <div className="p-2 text-label text-text-helper">Nothing waiting.</div>}
                {filter !== "waiting" && running.length > 0 && (
                    <>
                        <Section title="Running" count={running.length} tone="text-blue-40"/>
                        {rows(running)}
                    </>
                )}
                {filter !== "waiting" && (
                    <>
                        <Section title="Activity"/>
                        {activity.length === 0 ? <div className="px-2 py-1 text-label text-text-helper">No requests yet.</div> : rows(activity)}
                    </>
                )}
            </div>
        </div>
    );
}
