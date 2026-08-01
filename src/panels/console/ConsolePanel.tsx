import {useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore} from "react";
import {Copy, Filter, TrashCan} from "@carbon/icons-react";
import {
    CONSOLE_LEVEL_CLASSES,
    CONSOLE_LEVEL_LABELS,
    CONSOLE_LEVELS,
    ConsoleLevel,
    DEFAULT_VISIBLE_LEVELS,
    formatConsoleTime,
} from "@/lib/console/console.ts";
import {clearConsole, getConsoleSnapshot, subscribeConsole} from "@/lib/console/consoleStore.ts";

/** How close to the bottom still counts as "following". Anything less and a
 * one-pixel rounding difference would silently stop autoscroll. */
const AUTOSCROLL_SLACK_PX = 24;

export default function ConsolePanel() {
    const entries = useSyncExternalStore(subscribeConsole, getConsoleSnapshot);

    const [visibleLevels, setVisibleLevels] = useState<Set<ConsoleLevel>>(
        () => new Set(DEFAULT_VISIBLE_LEVELS),
    );
    const [query, setQuery] = useState("");
    const [following, setFollowing] = useState(true);

    const listRef = useRef<HTMLDivElement>(null);

    const events = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return entries.filter(
            (entry) =>
                visibleLevels.has(entry.level) &&
                (needle === "" || entry.text.toLowerCase().includes(needle)),
        );
    }, [entries, visibleLevels, query]);

    // Before paint, not after: scrolling in a passive effect lets the browser
    // show the pre-scroll frame first, which reads as a jitter on every line.
    useLayoutEffect(() => {
        const list = listRef.current;
        if (list && following) list.scrollTop = list.scrollHeight;
    }, [events, following]);

    // Scrolling up pauses the follow; returning to the bottom resumes it. The
    // operator reading back through a failure should not be yanked away by the
    // next heartbeat.
    useEffect(() => {
        const list = listRef.current;
        if (!list) return;

        const onScroll = () => {
            const distance = list.scrollHeight - list.scrollTop - list.clientHeight;
            setFollowing(distance <= AUTOSCROLL_SLACK_PX);
        };
        list.addEventListener("scroll", onScroll, {passive: true});
        return () => list.removeEventListener("scroll", onScroll);
    }, []);

    const toggleLevel = (level: ConsoleLevel) =>
        setVisibleLevels((current) => {
            const next = new Set(current);
            if (next.has(level)) next.delete(level);
            else next.add(level);
            return next;
        });

    const copyAll = () => {
        const line = (entry: (typeof events)[number]) =>
            `${formatConsoleTime(entry.at)}  ${entry.source.padEnd(8)} ${entry.text}` +
            (entry.count > 1 ? `  (x${entry.count})` : "");

        void navigator.clipboard?.writeText(events.map(line).join("\n"));
    };

    return (
        // `@container`, not viewport breakpoints: this panel can be a 300px
        // left dock or a full-width bottom dock in the same session, and it is
        // its own width that decides what fits, not the window's.
        <div className="@container flex h-full min-h-0 w-full flex-col bg-background">
            <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border-subtle px-2 py-1">
                {CONSOLE_LEVELS.map((level) => {
                    const on = visibleLevels.has(level);
                    return (
                        <button
                            key={level}
                            type="button"
                            aria-pressed={on}
                            title={`${CONSOLE_LEVEL_LABELS[level]} messages`}
                            onClick={() => toggleLevel(level)}
                            className={[
                                "border px-1.5 py-0.5 text-label whitespace-nowrap",
                                on
                                    ? `border-border-strong bg-layer-01 ${CONSOLE_LEVEL_CLASSES[level]}`
                                    : "border-border-subtle text-text-disabled hover:text-text-secondary",
                            ].join(" ")}
                        >
                            {/* Full word once there is room; initial before that,
                                so five filters still fit a narrow side dock. */}
                            <span className="@sm:hidden">{CONSOLE_LEVEL_LABELS[level][0]}</span>
                            <span className="hidden @sm:inline">{CONSOLE_LEVEL_LABELS[level]}</span>
                        </button>
                    );
                })}

                <div className="relative ml-auto flex items-center gap-1">
                    <div className="hidden items-center gap-1 @md:flex">
                        <Filter size={12} className="text-text-helper"/>
                        <input
                            type="text"
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder="Filter"
                            aria-label="Filter console messages"
                            className="w-24 border border-border-subtle bg-layer-01 px-1 py-0.5 text-label text-text-primary placeholder:text-text-helper"
                        />
                    </div>
                    <button
                        type="button"
                        title="Copy visible lines"
                        onClick={copyAll}
                        className="p-1 text-text-secondary hover:bg-layer-hover-01 hover:text-text-primary"
                    >
                        <Copy size={14}/>
                    </button>
                    <button
                        type="button"
                        title="Clear console"
                        onClick={clearConsole}
                        className="p-1 text-text-secondary hover:bg-layer-hover-01 hover:text-text-primary"
                    >
                        <TrashCan size={14}/>
                    </button>
                </div>
            </div>

            <div
                ref={listRef}
                role="log"
                aria-label="Console"
                aria-live="polite"
                className="min-h-0 flex-1 overflow-auto px-2 py-1 font-mono text-label leading-snug select-text"
            >
                {events.length === 0 ? (
                    <div className="p-2 text-text-helper">
                        {entries.length === 0
                            ? "No messages yet."
                            : "No events match the current filters."}
                    </div>
                ) : (
                    events.map((entry) => (
                        <div
                            key={entry.id}
                            className="flex gap-2 border-b border-border-subtle/40 py-0.5 last:border-b-0"
                        >
                            {/* First-seen, not last-seen: the row's position in
                                the list is its arrival order, and showing a
                                later time here made the log read backwards. */}
                            <span className="hidden shrink-0 tabular-nums text-text-helper @sm:inline">
                                {formatConsoleTime(entry.at)}
                            </span>
                            <span className="hidden w-16 shrink-0 truncate text-text-helper @lg:inline">
                                {entry.source}
                            </span>
                            {/* min-w-0 so a long unbroken token wraps instead of
                                forcing the row wider than the panel — the thing
                                that would otherwise break the narrow docks. */}
                            <span
                                className={`min-w-0 flex-1 break-words whitespace-pre-wrap ${CONSOLE_LEVEL_CLASSES[entry.level]}`}
                            >
                                {entry.text}
                            </span>
                            {entry.count > 1 && (
                                <span
                                    title={`Repeated ${entry.count} times`}
                                    className="shrink-0 self-start border border-border-subtle px-1 tabular-nums text-text-helper"
                                >
                                    ×{entry.count}
                                </span>
                            )}
                        </div>
                    ))
                )}
            </div>

            {!following && (
                <button
                    type="button"
                    onClick={() => setFollowing(true)}
                    className="shrink-0 border-t border-border-subtle bg-layer-01 py-1 text-label text-text-secondary hover:bg-layer-hover-01 hover:text-text-primary"
                >
                    Paused — jump to latest
                </button>
            )}
        </div>
    );
}
