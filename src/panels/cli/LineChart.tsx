import {useLayoutEffect, useMemo, useRef, useState} from "react";

/** Validated against the dark surface for colour-blind separation and
 * contrast. More series than this aren't drawn — the table shows them. */
export const SERIES_COLORS = ["#4589ff", "#eb6200", "#a56eff", "#009d9a"];

export interface ChartSeries {
    label: string;
    values: number[];
}

export interface ChartMarker {
    x: number;
    y: number;
    label: string;
}

const HEIGHT = 140;
const PAD = {left: 34, right: 8, top: 10, bottom: 20};

function niceStep(span: number, count: number): number {
    const raw = span / Math.max(1, count);
    const power = Math.pow(10, Math.floor(Math.log10(raw)));
    const scaled = raw / power;
    return (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10) * power;
}

function ticks(lo: number, hi: number, count: number): number[] {
    if (!(hi > lo)) return [lo];
    const step = niceStep(hi - lo, count);
    const out: number[] = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    return out;
}

function short(value: number): string {
    const abs = Math.abs(value);
    if (abs >= 1000) return value.toFixed(0);
    if (abs >= 10) return value.toFixed(0);
    if (abs >= 1) return value.toFixed(1);
    return value.toPrecision(2);
}

/**
 * A small multi-series line chart sized to its container, with a crosshair
 * readout on hover. Shared by the series and spectrum reply layouts.
 */
export default function LineChart({
    x,
    series,
    xFormat,
    unit,
    markers = [],
    ariaLabel,
}: {
    x: number[];
    series: ChartSeries[];
    xFormat: (value: number) => string;
    unit?: string;
    markers?: ChartMarker[];
    ariaLabel: string;
}) {
    const wrapRef = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(360);
    const [hover, setHover] = useState<number | null>(null);

    useLayoutEffect(() => {
        const el = wrapRef.current;
        if (!el) return;
        const observer = new ResizeObserver(() => setWidth(Math.max(160, el.clientWidth)));
        observer.observe(el);
        setWidth(Math.max(160, el.clientWidth));
        return () => observer.disconnect();
    }, []);

    const shown = series.slice(0, SERIES_COLORS.length);
    const geometry = useMemo(() => {
        const finite = shown.flatMap((s) => s.values.filter(Number.isFinite));
        let lo = finite.length ? Math.min(...finite) : 0;
        let hi = finite.length ? Math.max(...finite) : 1;
        if (lo === hi) {
            lo -= 1;
            hi += 1;
        }
        const pad = (hi - lo) * 0.06;
        lo -= pad;
        hi += pad;
        const x0 = x.length ? x[0] : 0;
        const x1 = x.length ? x[x.length - 1] : 1;
        const plotW = width - PAD.left - PAD.right;
        const plotH = HEIGHT - PAD.top - PAD.bottom;
        const sx = (v: number) => PAD.left + ((v - x0) / (x1 - x0 || 1)) * plotW;
        const sy = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * plotH;
        return {lo, hi, x0, x1, sx, sy, plotW};
    }, [shown, x, width]);

    const paths = shown.map((s) => {
        let d = "";
        let pen = false;
        s.values.forEach((v, i) => {
            if (!Number.isFinite(v)) {
                pen = false;
                return;
            }
            d += `${pen ? "L" : "M"}${geometry.sx(x[i]).toFixed(1)},${geometry.sy(v).toFixed(1)}`;
            pen = true;
        });
        return d;
    });

    const onMove = (event: React.MouseEvent<SVGSVGElement>) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const px = event.clientX - rect.left;
        const target = geometry.x0 + ((px - PAD.left) / geometry.plotW) * (geometry.x1 - geometry.x0);
        let best = 0;
        for (let i = 1; i < x.length; i++) if (Math.abs(x[i] - target) < Math.abs(x[best] - target)) best = i;
        setHover(x.length ? best : null);
    };

    return (
        <div ref={wrapRef} className="flex w-full flex-col gap-1">
            {shown.length > 1 && (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-label text-text-secondary">
                    {shown.map((s, i) => (
                        <span key={s.label} className="flex items-center gap-1.5">
                            <span aria-hidden="true" className="inline-block h-0.5 w-3" style={{background: SERIES_COLORS[i]}}/>
                            {s.label}
                        </span>
                    ))}
                    {unit && <span className="ml-auto text-text-helper">{unit}</span>}
                </div>
            )}
            <svg
                width={width}
                height={HEIGHT}
                role="img"
                aria-label={ariaLabel}
                onMouseMove={onMove}
                onMouseLeave={() => setHover(null)}
                className="block"
            >
                {ticks(geometry.lo, geometry.hi, 3).map((v) => (
                    <g key={`y${v}`}>
                        <line x1={PAD.left} x2={width - PAD.right} y1={geometry.sy(v)} y2={geometry.sy(v)} stroke="#393939"/>
                        <text x={PAD.left - 6} y={geometry.sy(v) + 3} textAnchor="end" fontSize={10} fill="#a8a8a8" fontFamily="IBM Plex Mono, monospace">
                            {short(v)}
                        </text>
                    </g>
                ))}
                {ticks(geometry.x0, geometry.x1, 4).map((v) => (
                    <text key={`x${v}`} x={geometry.sx(v)} y={HEIGHT - 6} textAnchor="middle" fontSize={10} fill="#a8a8a8" fontFamily="IBM Plex Mono, monospace">
                        {xFormat(v)}
                    </text>
                ))}
                {paths.map((d, i) => (
                    <path key={shown[i].label} d={d} fill="none" stroke={SERIES_COLORS[i]} strokeWidth={1.5} strokeLinejoin="round"/>
                ))}
                {markers.map((m) => (
                    <g key={`${m.x}-${m.label}`}>
                        <circle cx={geometry.sx(m.x)} cy={geometry.sy(m.y)} r={4} fill={SERIES_COLORS[0]} stroke="#262626" strokeWidth={2}/>
                        <text x={geometry.sx(m.x) + 7} y={geometry.sy(m.y) - 4} fontSize={10} fill="#c6c6c6" fontFamily="IBM Plex Mono, monospace">
                            {m.label}
                        </text>
                    </g>
                ))}
                {hover !== null && (
                    <line x1={geometry.sx(x[hover])} x2={geometry.sx(x[hover])} y1={PAD.top} y2={HEIGHT - PAD.bottom} stroke="#8d8d8d" strokeDasharray="2 2"/>
                )}
            </svg>
            <div className="flex min-h-4 flex-wrap gap-x-3 font-mono text-label text-text-helper">
                {hover !== null && (
                    <>
                        <span>{xFormat(x[hover])}</span>
                        {shown.map((s, i) => (
                            <span key={s.label} className="flex items-center gap-1 text-text-secondary">
                                <span aria-hidden="true" className="inline-block h-0.5 w-2" style={{background: SERIES_COLORS[i]}}/>
                                {Number.isFinite(s.values[hover]) ? short(s.values[hover]) : "—"}
                            </span>
                        ))}
                    </>
                )}
            </div>
        </div>
    );
}
