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

const WIDTH = 100;
const HEIGHT = 24;

/** A bare trend line — no axes, no ticks. Color comes from the caller via
 * `currentColor`, so it can carry the same tone as the reading beside it. */
export default function Sparkline({values, className, min, max}: SparklineProps) {
    const span = max - min || 1;

    const points =
        values.length < 2
            ? ""
            : values
                  .map((value, index) => {
                      const x = (index / (values.length - 1)) * WIDTH;
                      const clamped = Math.min(max, Math.max(min, value));
                      const y = HEIGHT - ((clamped - min) / span) * HEIGHT;
                      return `${x.toFixed(2)},${y.toFixed(2)}`;
                  })
                  .join(" ");

    return (
        <svg
            className={className}
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            preserveAspectRatio="none"
            aria-hidden="true"
        >
            {points && (
                <polyline
                    points={points}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                />
            )}
        </svg>
    );
}
