import {forwardRef, type ComponentPropsWithoutRef} from "react";

interface FitBoxProps extends ComponentPropsWithoutRef<"div"> {
    /** width / height of the natural, undistorted shape — the box is never
     * stretched off this ratio, only scaled uniformly. */
    ratio: number;
}

/**
 * A fixed-aspect-ratio box that scales up to fill as much of its grid cell
 * as it can, on both axes, without being stretched off-ratio, clipped, or
 * overflowing — the standard CSS `object-fit: contain` behavior, extended to
 * a plain box via `aspect-ratio` rather than needing a single replaced
 * element. `ManualPanel`'s grid gives every cell a real `minmax(0, 1fr)`
 * track on both axes (rows stacked, columns side-by-side), so `max-w-full`/
 * `max-h-full` here always has something genuine to cap against — same rule
 * either way, nothing breakpoint-specific needed.
 *
 * The one detail that matters: `width`/`height` are both left `auto`, not
 * one of them pinned to `100%`. Pinning one axis (tried first) breaks
 * `aspect-ratio`'s own two-axis fit — once the browser treats that axis as
 * definite, capping the *other* axis with `max-width`/`max-height` doesn't
 * cascade back to shrink the pinned one too, so a box wider (or taller) than
 * its cell's own ratio silently rendered off-ratio, filling the cell as a
 * plain rectangle instead of respecting its own shape. With both axes left
 * `auto` and both capped, the browser picks whichever cap actually binds and
 * derives the other side from `aspect-ratio` — which is also why this
 * doesn't need to change between stacked and side-by-side: it's just
 * "biggest box this ratio that fits inside max-width × max-height," and
 * that's the same question regardless of which of the two happens to be the
 * tighter constraint.
 *
 * `self-center justify-self-center`, for the same underlying reason: a grid
 * item's `auto` axis normally *stretches* to fill its whole track rather
 * than sizing from content/`aspect-ratio`, which is just pinning-to-100%
 * again by another name. Centering instead of `-start` is cosmetic, not
 * load-bearing.
 *
 * Forwards its ref and spreads any other div props straight onto that same
 * box — `JoystickInput` needs `tabIndex`/`onFocus`/`onBlur`/`onKeyDown` on
 * the exact element that's sized and centered, not a wrapper around it.
 */
const FitBox = forwardRef<HTMLDivElement, FitBoxProps>(function FitBox({ratio, className = "", style, ...rest}, ref) {
    return (
        <div
            ref={ref}
            style={{aspectRatio: ratio, ...style}}
            className={`min-h-0 min-w-0 h-auto w-auto max-h-full max-w-full self-center justify-self-center ${className}`}
            {...rest}
        />
    );
});

export default FitBox;
