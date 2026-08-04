import type {ReactNode} from "react";

/**
 * Hand-drawn diagrams for the 5 frame classes ArduPilot's own docs have no
 * usable diagram for (only a raster clip-art sketch for SingleCopter, real
 * hardware photos for CoaxCopter, and swashplate wiring diagrams — a
 * different thing entirely — for the Heli family). These intentionally reuse
 * ArduPilot's own diagram palette (motor green/blue, frame purple-gray, board
 * plate light gray) rather than this app's Carbon tokens, so they sit
 * consistently next to the 39 bundled ArduPilot SVGs in the same grid instead
 * of looking like a mismatched second style.
 */
const CW = "#33cc33";
const CCW = "#00b8e6";
const FRAME = "#60507f";
const BOARD = "#ebebeb";
const HALO = "#c4c4c4";
const LABEL = "#c6c6c6";

/** The little flight-controller board glyph from ArduPilot's own diagrams —
 * same path data, reused here so the center of a hand-drawn icon matches the
 * center of a bundled one exactly. */
function BoardGlyph() {
    const half = "M 1 64 L -30 64 A 12 12 0 0 1 -42 52 L -42 -28 A 12 12 0 0 1 -38 -36 L -5 -62 A 12 12 0 0 1 0 -63 L 1 -63";
    return (
        <g transform="translate(100 96) scale(0.22)">
            <g fill={BOARD}>
                <path d={half} strokeWidth={12} />
                <circle cx={-17} cy={-29} r={5} strokeWidth={0} fill={FRAME} />
                <line x1={-17} y1={-29} x2={1} y2={-29} strokeWidth={10} />
            </g>
            <g fill={BOARD} transform="scale(-1 1)">
                <path d={half} strokeWidth={12} />
                <circle cx={-17} cy={-29} r={5} strokeWidth={0} fill={FRAME} />
                <line x1={-17} y1={-29} x2={1} y2={-29} strokeWidth={10} />
            </g>
        </g>
    );
}

function MotorDot({cx, cy, spin}: {cx: number; cy: number; spin: "cw" | "ccw"}) {
    const color = spin === "cw" ? CW : CCW;
    return (
        <g>
            <circle cx={cx} cy={cy} r={17} fill={HALO} opacity={0.5} />
            <circle cx={cx} cy={cy} r={9} fill={color} />
        </g>
    );
}

/** A rotor disc (ring, not a filled dot) — used for the Heli family so a
 * variable-pitch rotor head reads as visually distinct from a fixed motor. */
function RotorDisc({cx, cy, r = 22}: {cx: number; cy: number; r?: number}) {
    return (
        <g>
            <circle cx={cx} cy={cy} r={r} fill="none" stroke={FRAME} strokeWidth={3} />
            <circle cx={cx} cy={cy} r={3.5} fill={FRAME} />
        </g>
    );
}

function Arm({x2, y2}: {x2: number; y2: number}) {
    return <line x1={100} y1={96} x2={x2} y2={y2} stroke={FRAME} strokeWidth={6} />;
}

function FlapArm({x2, y2}: {x2: number; y2: number}) {
    const dx = x2 - 100;
    const dy = y2 - 96;
    const len = Math.hypot(dx, dy);
    const nx = -dy / len;
    const ny = dx / len;
    const w = 9;
    return (
        <g>
            <line x1={100} y1={96} x2={x2} y2={y2} stroke={FRAME} strokeWidth={4} />
            <line x1={x2 - nx * w} y1={y2 - ny * w} x2={x2 + nx * w} y2={y2 + ny * w} stroke={LABEL} strokeWidth={5} />
        </g>
    );
}

// The label is left to the caller (Tile / big preview both already show the
// class name next to the icon) rather than baked into the SVG — unlike the
// bundled ArduPilot diagrams, which are loaded via <img> and so never surface
// their own internal text to the surrounding page.
function IconFrame({children}: {children: ReactNode}) {
    return (
        <svg viewBox="0 0 200 200" width="100%" height="100%">
            {children}
        </svg>
    );
}

export function SingleCopterIcon() {
    return (
        <IconFrame>
            <FlapArm x2={100} y2={40} />
            <FlapArm x2={100} y2={152} />
            <FlapArm x2={40} y2={96} />
            <FlapArm x2={160} y2={96} />
            <BoardGlyph />
            <MotorDot cx={100} cy={96} spin="cw" />
        </IconFrame>
    );
}

export function CoaxCopterIcon() {
    return (
        <IconFrame>
            <FlapArm x2={100} y2={40} />
            <FlapArm x2={100} y2={152} />
            <FlapArm x2={40} y2={96} />
            <FlapArm x2={160} y2={96} />
            <BoardGlyph />
            <MotorDot cx={94} cy={90} spin="ccw" />
            <MotorDot cx={106} cy={102} spin="cw" />
        </IconFrame>
    );
}

export function HeliIcon() {
    return (
        <IconFrame>
            <Arm x2={100} y2={160} />
            <BoardGlyph />
            <RotorDisc cx={100} cy={96} r={34} />
            <RotorDisc cx={100} cy={160} r={9} />
        </IconFrame>
    );
}

export function HeliDualIcon() {
    return (
        <IconFrame>
            <line x1={100} y1={62} x2={100} y2={130} stroke={FRAME} strokeWidth={6} />
            <BoardGlyph />
            <RotorDisc cx={100} cy={54} r={26} />
            <RotorDisc cx={100} cy={138} r={26} />
        </IconFrame>
    );
}

export function HeliQuadIcon() {
    return (
        <IconFrame>
            <Arm x2={146} y2={50} />
            <Arm x2={54} y2={50} />
            <Arm x2={54} y2={142} />
            <Arm x2={146} y2={142} />
            <BoardGlyph />
            <RotorDisc cx={146} cy={50} r={18} />
            <RotorDisc cx={54} cy={50} r={18} />
            <RotorDisc cx={54} cy={142} r={18} />
            <RotorDisc cx={146} cy={142} r={18} />
        </IconFrame>
    );
}
