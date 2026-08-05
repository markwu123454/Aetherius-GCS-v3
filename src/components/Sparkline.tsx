import {Tone, TONE_TEXT} from "@/components/topmenu/StatusChip.tsx";

type SparklineProps = {
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
} & (
    | {
          /**
           * Auto-scale to the data's actual extent. The tone color carries the
           * health signal; the y-axis shows relative change within the window.
           *
           * `minRange` sets a floor on the visible span so that sensor noise on
           * an otherwise flat signal doesn't blow up to fill the full height —
           * when the data range is smaller than `minRange`, the window is
           * expanded symmetrically around the data midpoint so the line stays
           * centered rather than pinned to one edge.
           *
           * 8% padding is always added above and below the resolved range so
           * the line never sits flush on the SVG edge (which causes half the
           * stroke to be clipped at min/max).
           */
          autoScale: true;
          minRange?: number;
          min?: never;
          max?: never;
      }
    | {
          /**
           * Fixed range — the line is plotted against a known instrument
           * scale rather than the data's own extent. Use when the absolute
           * position within the range carries meaning (e.g. battery voltage
           * against a 13–17.5 V scale shows headroom at a glance).
           */
          autoScale?: false;
          min: number;
          max: number;
          minRange?: never;
      }
);

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
export default function Sparkline(props: SparklineProps) {
    const {values, tones, className} = props;

    let lo: number, hi: number;
    if (props.autoScale) {
        if (values.length === 0) {
            lo = 0; hi = 1;
        } else {
            lo = values[0]; hi = values[0];
            for (const v of values) {
                if (v < lo) lo = v;
                if (v > hi) hi = v;
            }
            const floor = props.minRange ?? 0;
            if (hi - lo < floor) {
                const mid = (lo + hi) / 2;
                lo = mid - floor / 2;
                hi = mid + floor / 2;
            }
            // 8% padding so the line never sits flush on the SVG edge.
            const pad = (hi - lo || 1) * 0.08;
            lo -= pad;
            hi += pad;
        }
    } else {
        lo = props.min;
        hi = props.max;
    }

    const span = hi - lo || 1;

    const points =
        values.length < 2
            ? []
            : values.map((value, index) => {
                  const x = (index / (values.length - 1)) * 100;
                  const clamped = Math.min(hi, Math.max(lo, value));
                  const y = 100 - ((clamped - lo) / span) * 100;
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
