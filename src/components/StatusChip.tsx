export type Tone = "ok" | "warn" | "danger" | "info" | "neutral";

export const TONE_TEXT: Record<Tone, string> = {
    ok: "text-state-ok",
    warn: "text-state-warn",
    danger: "text-state-danger",
    info: "text-state-info",
    neutral: "text-text-primary",
};

interface StatusChipProps {
    label: string;
    /** Shown when there is room. */
    value: string;
    /** Shown when the application menu is taking up the row. */
    compactValue?: string;
    compact?: boolean;
    tone?: Tone;
    /**
     * A reading with no recent packet behind it. Frozen telemetry that still
     * looks live is the most dangerous thing a status strip can do, so stale
     * values are rendered unmistakably differently rather than just dimmed.
     */
    stale?: boolean;
    /**
     * Age in seconds of the last packet, shown beside a stale value. Only
     * meaningful once something has actually arrived — while a link has never
     * carried data there is no age to report, and showing one would be
     * measuring against the epoch rather than against a real packet.
     */
    staleFor?: number | null;
    /**
     * Nothing has been reported for this reading. Distinct from stale: stale
     * means "this was true and may no longer be", unknown means "this was
     * never known". Neither is allowed to look like a live value.
     */
    unknown?: boolean;
    /**
     * The silence has gone on long enough to stop being ordinary. Only the age
     * changes weight — the reading itself is equally untrustworthy either way,
     * so escalating it too would be saying something the data does not support.
     */
    severe?: boolean;
    onClick?: () => void;
}

export default function StatusChip({
    label,
    value,
    compactValue,
    compact = false,
    tone = "neutral",
    stale = false,
    staleFor,
    unknown = false,
    severe = false,
    onClick,
}: StatusChipProps) {
    const shown = unknown ? "—" : compact && compactValue !== undefined ? compactValue : value;
    const showAge = stale && typeof staleFor === "number";

    const title = unknown
        ? `${label} — not reported`
        : showAge
          ? `${label} — no data for ${staleFor}s`
          : `${label} ${value}`;

    return (
        <button
            type="button"
            onClick={onClick}
            title={title}
            className={[
                "flex h-full shrink-0 items-center gap-2 border-l border-border-subtle px-3",
                "text-left whitespace-nowrap transition-colors duration-100",
                onClick ? "hover:bg-layer-hover-01" : "cursor-default",
            ].join(" ")}
        >
            <span className="text-micro text-text-helper uppercase">{label}</span>
            <span
                className={[
                    "font-mono text-label tabular-nums",
                    unknown
                        ? "text-text-helper"
                        : stale
                          ? "text-text-disabled line-through decoration-1"
                          : TONE_TEXT[tone],
                ].join(" ")}
            >
                {shown}
            </span>
            {showAge && (
                <span className={`text-micro ${severe ? "text-state-danger" : "text-state-warn"}`}>
                    {staleFor}s
                </span>
            )}
        </button>
    );
}
