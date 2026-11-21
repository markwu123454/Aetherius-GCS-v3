import {useEffect, useState} from "react";

/**
 * Whole seconds since `since`, re-rendering when that count turns over.
 *
 * `useNow` doesn't fit this. It ticks on its own schedule, so when `since`
 * moves forward between two ticks, the clock's last reading is older than
 * `since` and the age comes out negative until the next tick. Here the clock
 * restarts whenever `since` changes and then ticks on whole seconds after it,
 * so the count reads 0 when `since` lands and turns over on time after that.
 */
export function useSecondsSince(since: number | null): number | null {
    const [now, setNow] = useState(() => Date.now());
    const [anchor, setAnchor] = useState(since);

    // Done during render rather than in the effect, so no frame is ever drawn
    // measuring the new `since` against the previous clock reading.
    if (since !== anchor) {
        setAnchor(since);
        setNow(Date.now());
    }

    useEffect(() => {
        if (since === null) {
            return;
        }
        let timer: number;
        const schedule = () => {
            const untilNextSecond = 1_000 - ((Date.now() - since) % 1_000);
            timer = window.setTimeout(() => {
                setNow(Date.now());
                schedule();
            }, untilNextSecond);
        };
        schedule();
        return () => window.clearTimeout(timer);
    }, [since]);

    return since === null ? null : Math.floor((now - since) / 1_000);
}
