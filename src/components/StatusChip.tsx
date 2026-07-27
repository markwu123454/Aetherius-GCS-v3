export type Tone = "ok" | "warn" | "danger" | "info" | "neutral";

const TONE_TEXT: Record<Tone, string> = {
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
    /** Age in seconds, shown alongside a stale value. */
    staleFor?: number;
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
    onClick,
}: StatusChipProps) {
    const shown = compact && compactValue !== undefined ? compactValue : value;

    return (
        <button
            type="button"
            onClick={onClick}
            title={stale ? `${label} — no data for ${staleFor ?? "?"}s` : `${label} ${value}`}
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
                    stale ? "text-text-disabled line-through decoration-1" : TONE_TEXT[tone],
                ].join(" ")}
            >
                {shown}
            </span>
            {stale && staleFor !== undefined && (
                <span className="text-micro text-state-danger">{staleFor}s</span>
            )}
        </button>
    );
}
