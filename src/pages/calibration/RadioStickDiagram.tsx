import {StickFunction} from "@/lib/calibration/useRadioCalibration.ts";

export type RadioMode = 1 | 2;

interface StickLayout {
    vertical: StickFunction;
    horizontal: StickFunction;
}

/**
 * Which function pair lives on which physical stick, for the two transmitter
 * modes that cover the vast majority of real transmitters (QGroundControl
 * also supports Modes 3/4, rarer reversed-throttle variants of these two —
 * left out here). Throttle and Yaw are always paired on one stick, Pitch and
 * Roll on the other; the mode only decides which stick gets which pair.
 */
const MODE_LAYOUT: Record<RadioMode, {left: StickLayout; right: StickLayout}> = {
    1: {left: {vertical: "pitch", horizontal: "yaw"}, right: {vertical: "throttle", horizontal: "roll"}},
    2: {left: {vertical: "throttle", horizontal: "yaw"}, right: {vertical: "pitch", horizontal: "roll"}},
};

const FUNCTION_LABEL: Record<StickFunction, string> = {
    throttle: "Throttle",
    yaw: "Yaw",
    roll: "Roll",
    pitch: "Pitch",
};

export interface StickDirection {
    axis: "vertical" | "horizontal";
    sign: 1 | -1;
}

function StickCircle({layout, direction}: {layout: StickLayout; direction: StickDirection | null}) {
    let dx = 0;
    let dy = 0;
    if (direction) {
        if (direction.axis === "vertical") {
            dy = -direction.sign; // "up" is negative Y in SVG space
        } else {
            dx = direction.sign;
        }
    }
    const active = dx !== 0 || dy !== 0;
    const cx = 50 + dx * 32;
    const cy = 50 + dy * 32;

    return (
        <div className="flex flex-col items-center gap-1">
            <svg viewBox="0 0 100 100" className="h-36 w-36">
                <circle cx={50} cy={50} r={46} className="fill-layer-02 stroke-border-subtle" strokeWidth={1.5}/>
                <line x1={50} y1={8} x2={50} y2={20} className="stroke-border-subtle" strokeWidth={1.5}/>
                <line x1={50} y1={80} x2={50} y2={92} className="stroke-border-subtle" strokeWidth={1.5}/>
                <line x1={8} y1={50} x2={20} y2={50} className="stroke-border-subtle" strokeWidth={1.5}/>
                <line x1={80} y1={50} x2={92} y2={50} className="stroke-border-subtle" strokeWidth={1.5}/>
                <circle cx={cx} cy={cy} r={9} className={active ? "fill-state-info" : "fill-text-helper"}/>
            </svg>
            <span className="text-micro text-text-helper">
                {FUNCTION_LABEL[layout.vertical]} / {FUNCTION_LABEL[layout.horizontal]}
            </span>
        </div>
    );
}

interface RadioStickDiagramProps {
    mode: RadioMode;
    /** The function and direction the current step is asking for — `null`
     * shows both sticks centered (the "neutral"/"switches"/"save" steps). */
    direction: {function: StickFunction; axis: "vertical" | "horizontal"; sign: 1 | -1} | null;
}

/**
 * The one piece of QGC's Radio Setup screen that isn't just a live readout —
 * a plain legend disambiguating which physical stick movement corresponds to
 * which function, since "Roll" and "Yaw" mean nothing to an operator who
 * hasn't memorized the convention.
 */
export default function RadioStickDiagram({mode, direction}: RadioStickDiagramProps) {
    const layout = MODE_LAYOUT[mode];
    const forStick = (stick: StickLayout): StickDirection | null =>
        direction && (direction.function === stick.vertical || direction.function === stick.horizontal)
            ? {axis: direction.axis, sign: direction.sign}
            : null;

    return (
        <div className="flex items-start gap-6">
            <StickCircle layout={layout.left} direction={forStick(layout.left)}/>
            <StickCircle layout={layout.right} direction={forStick(layout.right)}/>
        </div>
    );
}
