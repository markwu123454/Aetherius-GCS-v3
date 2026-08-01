import {useLayoutEffect, useRef, useState} from "react";

interface SparklineProps {
    values: number[];
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

const HEIGHT = 24;

/**
 * A bare trend line — no axes, no ticks. Color comes from the caller via
 * `currentColor`, so it can carry the same tone as the reading beside it.
 *
 * The viewBox is set to the element's own measured pixel width rather than a
 * fixed unit (with `preserveAspectRatio="none"` stretching it to fit) —
 * stretching by a different factor on each axis is exactly what made the
 * stroke render at an inconsistent thickness depending on a segment's local
 * angle. Matching the viewBox to real pixels 1:1 removes the scaling
 * mismatch instead of trying to compensate for it.
 */
export default function Sparkline({values, className, min, max}: SparklineProps) {
    const ref = useRef<SVGSVGElement>(null);
    const [width, setWidth] = useState(0);

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) {
            return;
        }
        const observer = new ResizeObserver((entries) => {
            const measured = entries[0]?.contentRect.width;
            if (measured) {
                setWidth(measured);
            }
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    const span = max - min || 1;

    const points =
        values.length < 2 || width === 0
            ? ""
            : values
                  .map((value, index) => {
                      const x = (index / (values.length - 1)) * width;
                      const clamped = Math.min(max, Math.max(min, value));
                      const y = HEIGHT - ((clamped - min) / span) * HEIGHT;
                      return `${x.toFixed(2)},${y.toFixed(2)}`;
                  })
                  .join(" ");

    return (
        <svg ref={ref} className={className} viewBox={`0 0 ${width || 1} ${HEIGHT}`} aria-hidden="true">
            {points && (
                <polyline
                    points={points}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                />
            )}
        </svg>
    );
}
