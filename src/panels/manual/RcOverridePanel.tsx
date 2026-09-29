import JoystickInput from "./JoystickInput.tsx";

/**
 * Standalone home for the keyboard RC override — split out of `ManualPanel`
 * so an engaged override can never be silently unmounted by tabbing away
 * from a dock. This panel can't dock at all (see `panels.ts`), only float,
 * so it's never a background tab a dock could unmount out from under a live
 * override, and its screen position stays put — worth having for a control
 * the operator is driving by feel.
 *
 * Same single-grid-cell fit as `ManualPanel` gives each of its instruments
 * (see `FitBox`): `JoystickInput` needs a container with a real, definite
 * size on both axes to scale itself into, which a bare flex child sized from
 * its own content wouldn't give it. No `@container` breakpoint here, unlike
 * `ManualPanel` — there's only ever the one instrument, so nothing ever
 * needs to reflow.
 */
export default function RcOverridePanel() {
    return (
        <div className="flex h-full min-h-0 w-full items-stretch justify-center-safe overflow-auto bg-background p-3">
            <div className="grid min-w-0 flex-1 grid-cols-1 grid-rows-1">
                <JoystickInput/>
            </div>
        </div>
    );
}
