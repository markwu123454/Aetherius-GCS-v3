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
 * a plain box. `ManualPanel`'s grid gives every cell a real `minmax(0, 1fr)`
 * track on both axes (rows stacked, columns side-by-side), and
 * `RcOverridePanel` a single cell that fills the panel.
 *
 * The outer div fills that cell and is a size container, so the box is sized
 * from the *cell* — `min(100cqw, ratio × 100cqh)`, the widest box of this
 * ratio that fits both axes — never from its own content. Leaving both axes
 * `auto` and capping them with `max-width`/`max-height` (tried before) made
 * the box's size depend on its content's intrinsic size instead: it only
 * grew because an inner SVG happened to report a large default one, and any
 * content without that collapsed the box to its minimum.
 *
 * Forwards its ref and spreads any other div props straight onto the inner,
 * sized box — `JoystickInput` needs `tabIndex`/`onFocus`/`onBlur`/`onKeyDown`
 * on the exact element that's sized and centered, not a wrapper around it.
 */
const FitBox = forwardRef<HTMLDivElement, FitBoxProps>(function FitBox({ratio, className = "", style, ...rest}, ref) {
    return (
        <div className="flex h-full min-h-0 w-full min-w-0 items-center justify-center [container-type:size]">
            <div
                ref={ref}
                style={{aspectRatio: ratio, width: `min(100cqw, ${ratio} * 100cqh)`, ...style}}
                className={`min-h-0 min-w-0 ${className}`}
                {...rest}
            />
        </div>
    );
});

export default FitBox;
