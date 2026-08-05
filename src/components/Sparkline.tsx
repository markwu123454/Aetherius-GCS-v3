import {Tone, TONE_TEXT} from "@/components/topmenu/StatusChip.tsx";

interface SparklineProps {
    values: number[];
    /**
     * Parallel to `values` — the tone the line should be at that sample,
     * e.g. `vibeTone` applied to each historical vibe reading rather than
     * just the current one. Lets the trace itself show *when* a threshold
     * was crossed (and recovered from), not just what the tone is right
     * now — a value that spiked into danger three minutes ago and recovered
     * would otherwise render as a uniformly "ok"-colored line with no trace
     * of what happened.
     */
    tones: Tone[];
    /** Sizing classes only — color comes from `tones` per segment, not one
     * class for the whole line. */
    className?: string;
    /**
     * Fixed range rather than auto-fit to the data. A voltage sparkline that
     * rescales itself to whatever the last two minutes happened to span would
     * make a 0.1V wobble fill the whole height — exactly as dramatic-looking
     * as a real 2V sag. Pass the instrument's actual expected range instead.
     */
    min: number;
    max: number;
}

/**
 * A bare trend line — no axes, no ticks — drawn as one short `<line>` per
 * consecutive pair of samples rather than a single `<polyline>`, so each
 * segment can carry its own color (see `tones`). A segment is colored by the
 * tone of the sample it's arriving *at* (`tones[i]`, not `tones[i - 1]`), so
 * a color change lands exactly on the sample that crossed the threshold.
 *
 * A fixed `0 0 100 100` viewBox plus `preserveAspectRatio="none"` — not a
 * viewBox measured from the element's own rendered size — on purpose. A
 * measured viewBox was tried first: `ResizeObserver` reports the box's size,
 * React re-renders with it as the viewBox, done. It looked right at rest,
 * but flashed rapidly while a dock was actively being resized, because two
 * independent things were resizing the same box: the CSS/flex layout
 * driving the drag updates every paint frame with no JS in the loop, while
 * the viewBox only updates from a React state set inside `ResizeObserver`'s
 * callback — one render behind. For a stretch of frames mid-drag, the
 * browser was stretching *last render's* viewBox into a box that had
 * already resized again, which is precisely the "non-uniform stretch
 * distorts the stroke" failure mode, just transient instead of permanent —
 * and which fractional alignment it happened to land on the instant the
 * drag stopped (and the two finally agreed again) is what made one flat
 * line look dimmer than its neighbor despite both being the same color at
 * the same opacity.
 *
 * A fixed viewBox removes the two-clocks problem outright: the browser
 * stretches this SVG's content to fill whatever box CSS gives it as part of
 * the *same* paint the box itself resizes in, never behind. That brings
 * back actual non-uniform stretching whenever the box's aspect ratio isn't
 * exactly 100:100 — which would normally distort stroke width unevenly, the
 * original reason a measured 1:1 viewBox existed at all — except each
 * segment below sets `vector-effect="non-scaling-stroke"`, which pins
 * stroke width (and its rounded caps/joins) to real CSS pixels regardless of
 * whatever transform is stretching the coordinates it's drawn along. That
 * gets the width-consistency the measured approach was for, without the
 * JS-measurement round-trip that turned out to cause a worse problem of its
 * own.
 */
export default function Sparkline({values, tones, className, min, max}: SparklineProps) {
    const span = max - min || 1;

    const points =
        values.length < 2
            ? []
            : values.map((value, index) => {
                  const x = (index / (values.length - 1)) * 100;
                  const clamped = Math.min(max, Math.max(min, value));
                  const y = 100 - ((clamped - min) / span) * 100;
                  return {x, y};
              });

    return (
        // `overflow-visible` overrides the UA's `svg:root { overflow: hidden }`,
        // which is what made otherwise-identical flat lines render at visibly
        // different brightnesses. A value pinned at `min` maps to exactly
        // `y = 100` — the viewBox's bottom edge — so the stroke straddles the
        // clip boundary and half of it is thrown away. What survives is a
        // partial-coverage sliver whose alpha depends on where that boundary
        // falls on the device-pixel grid, and because each row's box lands on a
        // different fraction (measured: .25/.5/.75/.0 at four consecutive
        // rows), four identical traces come out four different brightnesses.
        // Since values are clamped into [min, max], any reading at or past
        // either end of an instrument's fixed range sits on an edge, so this is
        // the normal case for a flatlined metric, not an edge case. Letting the
        // stroke overhang costs nothing: it bleeds 0.75px into the row `gap-2`.
        <svg
            className={`${className ?? ""} overflow-visible`}
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
        >
            {points.slice(1).map((point, index) => {
                const prev = points[index];
                const tone = tones[index + 1] ?? "neutral";
                return (
                    <line
                        key={index}
                        x1={prev.x}
                        y1={prev.y}
                        x2={point.x}
                        y2={point.y}
                        className={TONE_TEXT[tone]}
                        stroke="currentColor"
                        strokeWidth={1.5}
                        strokeLinecap="round"
                        vectorEffect="non-scaling-stroke"
                        // `shape-rendering` defaults to `auto`, which explicitly
                        // permits the browser to trade off antialiasing for
                        // speed — exactly the trade an SVG that redraws on every
                        // new sample is liable to get. `geometricPrecision`
                        // forces real antialiasing instead of a possibly-aliased
                        // fast path.
                        shapeRendering="geometricPrecision"
                    />
                );
            })}
        </svg>
    );
}
