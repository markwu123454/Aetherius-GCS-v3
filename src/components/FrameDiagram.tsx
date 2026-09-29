import type {FrameLayout, FrameLine, FrameSchematic} from "@/lib/frames/motorLayouts.ts";

/*
 * Proportions are ArduPilot's own, from build_motor_diagrams.py, so a frame
 * here sits in its box the way the official diagram does: the frame radius
 * grows with the number of distinct motor positions, and the rotor ring and
 * arrow shape are the same size relative to it.
 */
const FRAME_BASE_RADIUS = 385;
const DIAGRAM_SCALING: Record<number, number> = {2: 1.1, 3: 1.25, 4: 1, 5: 1.1, 6: 1.25, 7: 1.6, 8: 1.6, 9: 1.66, 10: 1.8};
const DODECAHEXA_MULTIPLIER = 1.2;

const MARK_RADIUS = 42;
const SERVO_SIZE: [number, number] = [44, 64];
/** Outer edge of the spin ring; its band runs from 91 to 101. */
const RING_RADIUS = 101;
/** Radius of the single arc drawn around a highlighted motor. */
const HIGHLIGHT_RADIUS = 66;
/** A coaxial pair shares one position; top-down, the two marks are drawn
 * this far apart, the top one above and over the bottom one. Where the data
 * doesn't say which is on top (Coax), the lower motor number goes up. */
const STACK_OFFSET = 30;
const PADDING = 16;

/** One half of ArduPilot's prop arc: a band over the top of the rotor ending
 * in an arrowhead, in the clockwise direction. Two of these, the second
 * turned 180°, are the whole ring. */
const PROP_HALF_ARC = "M -90 -6 A 91 91 0 0 1 89 -23 L 74 -21 L 101 4 A 101 101 0 0 0 -100 -14 Z";

/** Spin colours, from the app's palette: green clockwise, cyan
 * counter-clockwise, purple where the direction doesn't matter (no yaw
 * torque) or isn't stated. */
const SPIN_COLORS: Record<"CW" | "CCW" | "Either", string> = {
    CW: "var(--color-green-40)",
    CCW: "var(--color-cyan-40)",
    Either: "var(--color-purple-40)",
};

interface Mark {
    kind: "motor" | "servo" | "rotor";
    x: number;
    y: number;
    spin: "CW" | "CCW" | "Either" | null;
    /** What's written in the mark — the MotorN number, or a schematic label. */
    label?: string;
    number?: number;
    testOrder?: number;
    stack?: "top" | "bottom";
    cant?: [number, number];
    size?: number;
    /** Other MotorN numbers this mark also stands for (Single's Motor6). */
    alsoNumbers?: number[];
}

/** Marks to draw. An output that duplicates another's signal (`sameAs`)
 * isn't a separate thing on the frame, so it folds into that mark's label. */
function marksOf(frame: FrameLayout | FrameSchematic): Mark[] {
    if (!("motors" in frame)) return frame.marks;
    return frame.motors.filter((m) => m.sameAs === undefined).map((m) => {
        const also = frame.motors.filter((o) => o.sameAs === m.number).map((o) => o.number);
        return {...m, label: [m.number, ...also].join("/"), alsoNumbers: also};
    });
}

/** Up (-1) or down (+1) for a mark sharing its position with another: the
 * data's own top/bottom where it has one, else lower number up. */
function stackSide(m: Mark, marks: Mark[]): number {
    if (m.stack) return m.stack === "top" ? -1 : 1;
    const twins = marks.filter((o) => o.kind !== "rotor" && o.x === m.x && o.y === m.y);
    if (twins.length < 2) return 0;
    const lowest = Math.min(...twins.map((o) => o.number ?? Infinity));
    return (m.number ?? Infinity) === lowest ? -1 : 1;
}

/** The same foreshortening as `cantMatrix`, applied to a point: ArduPilot
 * tilts a canted rotor about an axis through the diagram's center, so the
 * tilt moves the rotor as well as squashing it — onto the end of its rod. */
function cantPoint([ax, ay]: [number, number], x: number, y: number): [number, number] {
    const t = Math.atan2(ay, ax);
    const k = Math.cos(Math.PI / 4);
    const c = Math.cos(t);
    const s = Math.sin(t);
    const b = (1 - k) * s * c;
    return [(c * c + k * s * s) * x + b * y, b * x + (s * s + k * c * c) * y];
}

/** R(θ)·S(1, cos45°)·R(-θ): squashes a rotor across its cant axis, which is
 * how a rotor tilted 45° about that axis looks from straight above. */
function cantMatrix([ax, ay]: [number, number]): string {
    const t = Math.atan2(ay, ax);
    const k = Math.cos(Math.PI / 4);
    const c = Math.cos(t);
    const s = Math.sin(t);
    const a = c * c + k * s * s;
    const d = s * s + k * c * c;
    const b = (1 - k) * s * c;
    return `matrix(${a} ${b} ${b} ${d} 0 0)`;
}

function HighlightArrow() {
    const r = HIGHLIGHT_RADIUS;
    const a0 = -Math.PI / 2 + 0.5;
    const a1 = a0 + 4.3;
    const [sx, sy] = [r * Math.cos(a0), r * Math.sin(a0)];
    const [ex, ey] = [r * Math.cos(a1), r * Math.sin(a1)];
    const tangent = a1 + Math.PI / 2;
    const head = (spread: number) => [ex - 18 * Math.cos(tangent + spread), ey - 18 * Math.sin(tangent + spread)];
    const [h1x, h1y] = head(-0.5);
    const [h2x, h2y] = head(0.9);
    return (
        <g fill="none" stroke="var(--color-state-info)" strokeWidth={7} strokeLinecap="round" strokeLinejoin="round">
            <path d={`M${sx} ${sy} A${r} ${r} 0 1 1 ${ex} ${ey}`}/>
            <path d={`M${h1x} ${h1y} L${ex} ${ey} L${h2x} ${h2y}`}/>
        </g>
    );
}

function SpinRing({spin}: {spin: "CW" | "CCW" | "Either"}) {
    const color = SPIN_COLORS[spin];
    if (spin === "Either") {
        return <circle r={96} fill="none" stroke={color} strokeWidth={10}/>;
    }
    return (
        <g fill={color} transform={spin === "CCW" ? "scale(-1 1)" : undefined}>
            <path d={PROP_HALF_ARC}/>
            <path d={PROP_HALF_ARC} transform="rotate(180)"/>
        </g>
    );
}

interface FrameDiagramProps {
    frame: FrameLayout | FrameSchematic;
    /** Ring and arrows around every motor, coloured by spin direction. */
    spin?: boolean;
    /** MotorN numbers (or schematic labels) in the marks. */
    numbers?: boolean;
    /** ArduPilot's motor test letters (A = first tested) beside each motor. */
    letters?: boolean;
    /** Motor number to draw emphasised — which one, and when, is the caller's
     * call; this only knows how it looks. */
    highlight?: number | null;
    className?: string;
}

/**
 * Any frame, top-down, from its layout data: frame lines, the body with a
 * nose chevron, and a mark per motor (circle), servo (outlined rectangle) or
 * helicopter rotor (disc outline — no hub, so the body and nose chevron
 * under a centered rotor stay visible). Everything past the frame itself is an opt-in
 * layer, so each page draws only what it needs from the one drawing.
 *
 * Every frame comes from motorLayouts.json (generated and checked against
 * ArduPilot's official diagrams by `npm run build:motor-layouts`), so there's
 * no per-frame drawing code — a new frame type is a rebuild of that data.
 */
export default function FrameDiagram({
    frame,
    spin = false,
    numbers = false,
    letters = false,
    highlight = null,
    className = "",
}: FrameDiagramProps) {
    const marks = marksOf(frame);
    const positions = new Set(marks.filter((m) => m.kind !== "servo").map((m) => `${m.x},${m.y}`));
    const radius = FRAME_BASE_RADIUS * (DIAGRAM_SCALING[positions.size] ?? 1) * (marks.length === 12 ? DODECAHEXA_MULTIPLIER : 1);

    const placed = marks.map((m) => {
        const [px, py] = m.cant ? cantPoint(m.cant, m.x * radius, -m.y * radius) : [m.x * radius, -m.y * radius];
        const side = stackSide(m, marks);
        return {...m, px, py: py + side * STACK_OFFSET, side};
    });
    // The lower mark of a stacked pair first, so the upper one is drawn over it.
    const drawOrder = [...placed].sort((a, b) => b.side - a.side);
    const isHighlighted = (p: Mark) => highlight !== null && (p.number === highlight || (p.alsoNumbers?.includes(highlight) ?? false));

    const lines: FrameLine[] = frame.frameLines ?? marks.map((m) => [0, 0, m.x, m.y]);
    const svgLines = lines.map(([x1, y1, x2, y2]) => [x1 * radius, -y1 * radius, x2 * radius, -y2 * radius]);

    // Test letters sit outside the ring: radially for a lone motor, beside
    // the mark for a stacked pair (which share a direction from center).
    const letterAt = (p: (typeof placed)[number]): [number, number] => {
        if (p.kind === "servo") return [p.px + 70, p.py];
        if (p.side !== 0) return [p.px + (p.px >= 0 ? 1 : -1) * (RING_RADIUS + 40), p.py];
        const r = Math.hypot(p.px, p.py);
        // A motor at the center has no outward direction; put its letter to
        // the right of the ring rather than on top of its own number.
        if (r < 1) return [p.px + RING_RADIUS + 40, p.py];
        const out = r + RING_RADIUS + 36;
        return [(p.px / r) * out, (p.py / r) * out];
    };

    // Box every layer that could be drawn, so the frame sits in the same place
    // whichever motor is highlighted.
    const reach = (p: (typeof placed)[number]) =>
        p.kind === "rotor" ? (p.size ?? 0.3) * radius + 8 : p.kind === "servo" ? SERVO_SIZE[1] / 2 + 6 : spin ? RING_RADIUS : HIGHLIGHT_RADIUS + 12;
    const xs: number[] = [-45, 45];
    const ys: number[] = [-45, 45];
    for (const p of placed) {
        xs.push(p.px - reach(p), p.px + reach(p));
        ys.push(p.py - reach(p), p.py + reach(p));
        if (letters && p.testOrder !== undefined) {
            const [lx, ly] = letterAt(p);
            xs.push(lx - 26, lx + 26);
            ys.push(ly - 26, ly + 26);
        }
    }
    for (const [x1, y1, x2, y2] of svgLines) {
        xs.push(x1, x2);
        ys.push(y1, y2);
    }
    const minX = Math.min(...xs) - PADDING;
    const minY = Math.min(...ys) - PADDING;
    const width = Math.max(...xs) + PADDING - minX;
    const height = Math.max(...ys) + PADDING - minY;

    return (
        <svg
            viewBox={`${minX} ${minY} ${width} ${height}`}
            role="img"
            aria-label={`${frame.typeName} layout`}
            // Body letter-spacing is in px; at this viewBox's scale it would
            // still drag centered labels sideways, so turn it off.
            style={{letterSpacing: 0}}
            className={className}
        >
            <g stroke="var(--color-border-subtle)" strokeWidth={12} strokeLinecap="round">
                {svgLines.map(([x1, y1, x2, y2], i) => (
                    <line key={`line-${i}`} x1={x1} y1={y1} x2={x2} y2={y2}/>
                ))}
            </g>
            <rect x={-35} y={-35} width={70} height={70} fill="var(--color-layer-02)" stroke="var(--color-border-strong)" strokeWidth={6}/>
            <path d="M-17 9 L0 -9 L17 9" fill="none" stroke="var(--color-text-secondary)" strokeWidth={6} strokeLinecap="round" strokeLinejoin="round"/>

            {drawOrder.map((p, i) => {
                const on = isHighlighted(p);
                const spinColor = spin && p.spin ? SPIN_COLORS[p.spin] : null;
                const transform = `translate(${p.px} ${p.py})${p.cant ? ` ${cantMatrix(p.cant)}` : ""}`;
                if (p.kind === "rotor") {
                    return (
                        <g key={`mark-${i}`} transform={transform}>
                            <circle r={(p.size ?? 0.3) * radius} fill="none" stroke="var(--color-border-strong)" strokeWidth={8}/>
                        </g>
                    );
                }
                if (p.kind === "servo") {
                    const [w, h] = SERVO_SIZE;
                    return (
                        <g key={`mark-${i}`} transform={transform}>
                            <rect
                                x={-w / 2}
                                y={-h / 2}
                                width={w}
                                height={h}
                                fill={on ? "var(--color-state-info)" : "var(--color-background)"}
                                stroke={on ? "var(--color-state-info)" : "var(--color-text-secondary)"}
                                strokeWidth={6}
                            />
                        </g>
                    );
                }
                return (
                    <g key={`mark-${i}`} transform={transform}>
                        {spinColor && p.spin && <SpinRing spin={p.spin}/>}
                        <circle
                            r={MARK_RADIUS}
                            fill={on ? "var(--color-state-info)" : "var(--color-layer-02)"}
                            stroke={on ? "var(--color-state-info)" : spinColor ?? "var(--color-border-strong)"}
                            strokeWidth={6}
                        />
                        {on && !spin && (p.spin === "CW" || p.spin === "CCW") && (
                            <g transform={p.spin === "CCW" ? "scale(-1 1)" : undefined}>
                                <HighlightArrow/>
                            </g>
                        )}
                    </g>
                );
            })}

            {/* Text after every mark, so the top motor of a stacked pair can't
                paint over the bottom one's number. */}
            {numbers && drawOrder.filter((p) => p.label && p.kind !== "rotor").map((p, i) => (
                <text
                    key={`label-${i}`}
                    x={p.px}
                    y={p.py}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={38}
                    fontFamily="var(--font-mono)"
                    fill={isHighlighted(p) ? "var(--color-text-on-color)" : "var(--color-text-primary)"}
                >
                    {p.label}
                </text>
            ))}
            {letters && drawOrder.filter((p) => p.testOrder !== undefined).map((p, i) => {
                const [lx, ly] = letterAt(p);
                return (
                    <text
                        key={`letter-${i}`}
                        x={lx}
                        y={ly}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fontSize={44}
                        fontWeight={600}
                        fontFamily="var(--font-sans)"
                        fill="var(--color-text-secondary)"
                    >
                        {String.fromCharCode(64 + (p.testOrder ?? 0))}
                    </text>
                );
            })}
        </svg>
    );
}
