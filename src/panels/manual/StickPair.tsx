import StickBall from "./StickBall.tsx";

interface Stick {
    x: number | null;
    y: number | null;
}

/**
 * The two stick balls side by side with a caption under each — shared by
 * `JoystickDisplay` and `JoystickInput` so both lay out identically.
 *
 * Two equal grid columns rather than a flex row of content-sized columns: a
 * flex column takes its width from its caption, not its ball, so the balls
 * sat wherever the captions put them — pushed apart when the box was small
 * and the text outgrew the balls, overlapping when it was big and the balls
 * outgrew the text. Here each ball owns exactly half the row, and the gap is
 * a percentage of the row's width, so the spacing scales with the box.
 *
 * Each ball's slot is a size container, so the ball can be sized to
 * `min(100cqw, 100cqh)` — the largest square that fits its half on both
 * axes — without depending on flex/aspect-ratio intrinsic sizing, which is
 * what let the ball overflow its column in the first place.
 */
export default function StickPair({
    left,
    right,
    leftLabel,
    rightLabel,
}: {
    left: Stick;
    right: Stick;
    leftLabel: string;
    rightLabel: string;
}) {
    return (
        <div className="grid min-h-0 w-full flex-1 grid-cols-2 grid-rows-[minmax(0,1fr)_auto] gap-x-[6%] gap-y-1">
            {[left, right].map((stick, index) => (
                <div key={index} className="min-h-0 min-w-0 [container-type:size]">
                    {/* Pushed against the center gap rather than centered in
                        its half, so a ball that's height-limited (smaller than
                        its column is wide) doesn't drift away from the other. */}
                    <div className={`${index === 0 ? "ml-auto" : "mr-auto"} aspect-square w-[min(100cqw,100cqh)]`}>
                        <StickBall x={stick.x} y={stick.y}/>
                    </div>
                </div>
            ))}
            <span className="text-center text-micro text-text-helper">{leftLabel}</span>
            <span className="text-center text-micro text-text-helper">{rightLabel}</span>
        </div>
    );
}
