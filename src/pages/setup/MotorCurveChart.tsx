import {useEffect, useRef, useState} from "react";

/** A horizontal reference line across the plot, labelled in the right margin. */
export interface ChartLine {
    y: number;
    label: string;
}

/** A marked point on the curve. */
export interface ChartPoint {
    x: number;
    y: number;
    label: string;
}

interface MotorCurveChartProps {
    xDomain: [number, number];
    xTicks: number[];
    xLabel: string;
    formatX: (x: number) => string;
    yDomain: [number, number];
    curve: (x: number) => number;
    lines: ChartLine[];
    points: ChartPoint[];
}

const H = 280;
const M = {left: 48, right: 120, top: 28, bottom: 38};
const PLOT_H = H - M.top - M.bottom;
const SAMPLES = 160;
const LABEL_GAP = 14;
const FONT = 11;

/** Round tick spacing (1, 2, 2.5 or 5 × 10ⁿ) giving about `count` ticks. */
function niceTicks(lo: number, hi: number, count: number): number[] {
    const raw = (hi - lo) / count;
    if (!(raw > 0)) return [lo];
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((f) => f * magnitude).find((s) => s >= raw) ?? raw;
    const ticks: number[] = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(Number(v.toFixed(6)));
    return ticks;
}

/** Spreads right-margin labels so none overlap, keeping each as close to its
 * line as the others allow. */
function spreadLabels(ys: number[]): number[] {
    const order = ys.map((y, i) => ({y, i})).sort((a, b) => a.y - b.y);
    for (let k = 1; k < order.length; k++) {
        order[k].y = Math.max(order[k].y, order[k - 1].y + LABEL_GAP);
    }
    const overflow = order.length > 0 ? order[order.length - 1].y - (M.top + PLOT_H) : 0;
    if (overflow > 0) {
        for (const o of order) o.y -= overflow;
        for (let k = order.length - 2; k >= 0; k--) {
            order[k].y = Math.min(order[k].y, order[k + 1].y - LABEL_GAP);
        }
    }
    const out: number[] = [];
    for (const o of order) out[o.i] = o.y;
    return out;
}

/**
 * Input → PWM for one output, with reference lines for the fixed points the
 * firmware pins (spin levels, throttle limits) and a hover readout. Pure SVG:
 * one curve, a handful of lines, no charting library for it.
 *
 * The viewBox is the element's own measured width at a fixed height, so text
 * stays at its real size however wide the page is. While a resize is in
 * flight the browser scales the previous viewBox uniformly (`meet`) for a
 * frame — text shifts size slightly, nothing stretches.
 */
export default function MotorCurveChart({xDomain, xTicks, xLabel, formatX, yDomain, curve, lines, points}: MotorCurveChartProps) {
    const svgRef = useRef<SVGSVGElement>(null);
    const [width, setWidth] = useState(640);
    const [hoverX, setHoverX] = useState<number | null>(null);

    useEffect(() => {
        const svg = svgRef.current;
        if (!svg) return;
        const observer = new ResizeObserver(([entry]) => {
            const next = Math.round(entry.contentRect.width);
            if (next > 0) setWidth(next);
        });
        observer.observe(svg);
        return () => observer.disconnect();
    }, []);

    const plotW = Math.max(40, width - M.left - M.right);
    const [x0, x1] = xDomain;
    const [y0, y1] = yDomain;
    const sx = (x: number) => M.left + ((x - x0) / (x1 - x0 || 1)) * plotW;
    const sy = (y: number) => M.top + (1 - (Math.min(y1, Math.max(y0, y)) - y0) / (y1 - y0 || 1)) * PLOT_H;

    const path = Array.from({length: SAMPLES + 1}, (_, i) => {
        const x = x0 + ((x1 - x0) * i) / SAMPLES;
        return `${i === 0 ? "M" : "L"}${sx(x).toFixed(2)},${sy(curve(x)).toFixed(2)}`;
    }).join("");

    const yTicks = niceTicks(y0, y1, 5);
    const visibleLines = lines.filter((line) => line.y >= y0 && line.y <= y1);
    const labelYs = spreadLabels(visibleLines.map((line) => sy(line.y)));

    const handlePointer = (event: React.PointerEvent<SVGRectElement>) => {
        const rect = svgRef.current?.getBoundingClientRect();
        if (!rect || rect.width === 0) return;
        const vx = ((event.clientX - rect.left) / rect.width) * width;
        const x = x0 + ((vx - M.left) / plotW) * (x1 - x0);
        setHoverX(Math.min(x1, Math.max(x0, x)));
    };

    const hoverY = hoverX === null ? null : curve(hoverX);

    return (
        <svg
            ref={svgRef}
            viewBox={`0 0 ${width} ${H}`}
            height={H}
            className="block w-full font-mono select-none"
            role="img"
            aria-label={xLabel}
        >
            {yTicks.map((y) => (
                <g key={`y${y}`}>
                    <line x1={M.left} x2={M.left + plotW} y1={sy(y)} y2={sy(y)} className="stroke-border-subtle-base" strokeWidth={1}/>
                    <text x={M.left - 8} y={sy(y) + 4} textAnchor="end" fontSize={FONT} className="fill-text-helper">
                        {Math.round(y)}
                    </text>
                </g>
            ))}
            {xTicks.map((x) => (
                <g key={`x${x}`}>
                    <line x1={sx(x)} x2={sx(x)} y1={M.top} y2={M.top + PLOT_H} className="stroke-border-subtle-base" strokeWidth={1}/>
                    <text x={sx(x)} y={M.top + PLOT_H + 16} textAnchor="middle" fontSize={FONT} className="fill-text-helper">
                        {formatX(x)}
                    </text>
                </g>
            ))}
            <text x={M.left - 8} y={M.top - 12} textAnchor="end" fontSize={FONT} className="fill-text-helper">µs</text>
            <text x={M.left + plotW / 2} y={H - 4} textAnchor="middle" fontSize={FONT} className="fill-text-helper">{xLabel}</text>

            {visibleLines.map((line, i) => (
                <g key={`l${line.label}`}>
                    <line
                        x1={M.left}
                        x2={M.left + plotW}
                        y1={sy(line.y)}
                        y2={sy(line.y)}
                        className="stroke-border-strong"
                        strokeWidth={1}
                        strokeDasharray="4 3"
                    />
                    <text x={M.left + plotW + 8} y={labelYs[i] + 4} fontSize={FONT} className="fill-text-secondary">
                        {line.label} {Math.round(line.y)}
                    </text>
                </g>
            ))}

            <path d={path} fill="none" className="stroke-blue-40" strokeWidth={2} strokeLinejoin="round"/>

            {points.map((point) => (
                <g key={`p${point.label}`}>
                    <circle cx={sx(point.x)} cy={sy(point.y)} r={4} className="fill-text-primary"/>
                    <text x={sx(point.x) + 8} y={sy(point.y) - 8} fontSize={FONT} className="fill-text-primary">
                        {point.label} {Math.round(point.y)}
                    </text>
                </g>
            ))}

            {hoverX !== null && hoverY !== null && (
                <g pointerEvents="none">
                    <line x1={sx(hoverX)} x2={sx(hoverX)} y1={M.top} y2={M.top + PLOT_H} className="stroke-text-helper" strokeWidth={1}/>
                    <circle cx={sx(hoverX)} cy={sy(hoverY)} r={4} className="fill-blue-40"/>
                    <text x={M.left + 4} y={M.top - 12} fontSize={12} className="fill-text-primary">
                        {formatX(hoverX)} → {Math.round(hoverY)} µs
                    </text>
                </g>
            )}

            <rect
                x={M.left}
                y={M.top}
                width={plotW}
                height={PLOT_H}
                fill="transparent"
                onPointerMove={handlePointer}
                onPointerLeave={() => setHoverX(null)}
            />
        </svg>
    );
}
