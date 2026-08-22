import type {AutoZoomMode} from "@/lib/settings/settings.ts";

/** Zoom while the vehicle is essentially stationary — close enough to watch
 * detail during taxi, takeoff roll, or a hover. Matches `FIRST_FIX_ZOOM` in
 * `MapView.tsx`, the zoom the very first fix already settles at. */
const NEAR_ZOOM = 17;
/** Zoom at or above the fast end of each curve below — wide enough that a
 * vehicle moving at pace doesn't threaten to cross the view between camera
 * updates. */
const FAR_ZOOM = 13;

/** Below this groundspeed the vehicle reads as stationary — holds `NEAR_ZOOM`
 * rather than reacting to the last couple m/s of GPS noise on the ground. */
const MIN_ZOOM_SPEED_MPS = 2;
/** Groundspeed at which the curve bottoms out at `FAR_ZOOM` — comfortably
 * above small-UAS cruise (most fixed-wing sit in the 12-25 m/s range) so the
 * view has already widened out well before a fast pass. */
const MAX_ZOOM_SPEED_MPS = 30;

/** Altitude at which the curve bottoms out at `FAR_ZOOM` — 120 m (~400 ft) is
 * the ceiling most small-UAS operate under, so this spans the full range a
 * flight normally uses rather than only the top of it. */
const MAX_ZOOM_ALT_M = 120;

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

/** Clamped linear interpolation from `NEAR_ZOOM` at `lo` down to `FAR_ZOOM`
 * at `hi`. Zoom is already a log2-of-scale quantity, so a straight linear
 * blend against speed/altitude reads as smooth rather than needing its own
 * curve on top. */
function zoomFor(value: number, lo: number, hi: number): number {
    const t = clamp((value - lo) / (hi - lo), 0, 1);
    return NEAR_ZOOM + (FAR_ZOOM - NEAR_ZOOM) * t;
}

/**
 * Target camera zoom for the given auto-zoom mode, or `null` when the mode
 * is `"off"` or its driving telemetry (groundspeed/altitude) hasn't arrived
 * yet — callers should leave the camera's current zoom alone in that case
 * rather than snapping to a default.
 */
export function autoZoomTarget(mode: AutoZoomMode, groundspeedMps: number | null, altitudeM: number | null): number | null {
    switch (mode) {
        case "off":
            return null;
        case "groundspeed":
            return groundspeedMps === null ? null : zoomFor(groundspeedMps, MIN_ZOOM_SPEED_MPS, MAX_ZOOM_SPEED_MPS);
        case "altitude":
            return altitudeM === null ? null : zoomFor(altitudeM, 0, MAX_ZOOM_ALT_M);
    }
}
