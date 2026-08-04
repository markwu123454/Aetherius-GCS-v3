/**
 * One 2-axis stick position, drawn the same way `RadioStickDiagram` (the
 * calibration wizard's cue diagram) draws a stick — same bezel, crosshair,
 * and dot styling — so a joystick reads the same visual language everywhere
 * in the app. That one only ever shows a single fixed extreme; this one
 * takes a continuous `-1..1` position on each axis instead.
 */
export default function StickBall({x, y}: {x: number | null; y: number | null}) {
    const active = x !== null && y !== null;
    const cx = 50 + (x ?? 0) * 32;
    // SVG y grows downward — "up"/positive on the vertical axis has to move
    // the dot to a smaller y, same sign flip `RadioStickDiagram` applies.
    const cy = 50 - (y ?? 0) * 32;

    return (
        <svg viewBox="0 0 100 100" className="h-full w-full">
            <circle cx={50} cy={50} r={46} className="fill-layer-02 stroke-border-subtle" strokeWidth={1.5}/>
            <line x1={50} y1={8} x2={50} y2={20} className="stroke-border-subtle" strokeWidth={1.5}/>
            <line x1={50} y1={80} x2={50} y2={92} className="stroke-border-subtle" strokeWidth={1.5}/>
            <line x1={8} y1={50} x2={20} y2={50} className="stroke-border-subtle" strokeWidth={1.5}/>
            <line x1={80} y1={50} x2={92} y2={50} className="stroke-border-subtle" strokeWidth={1.5}/>
            <circle cx={cx} cy={cy} r={9} className={active ? "fill-state-info" : "fill-text-helper"}/>
        </svg>
    );
}
