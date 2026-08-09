/**
 * Canvas drawing helpers shared by every timeline row. Plain canvas rather
 * than a charting library or SVG — matches how the app's other data-dense
 * widgets (the PFD, HUD) are hand-rolled against Carbon tokens rather than
 * pulled from a component library, and gives direct control over redraw
 * cost at the sample counts a dataflash log can produce.
 */

/** Reads a CSS custom property's resolved value off `el` — respects
 * whichever theme is active, since `getComputedStyle` resolves `var()`
 * indirection through the cascade rather than needing it done again here.
 * Canvas's `strokeStyle`/`fillStyle` don't understand `var(...)` directly,
 * so this is the one indirection needed to keep row colors on theme
 * tokens instead of hardcoded hex. */
export function cssVar(el: Element, name: string, fallback: string): string {
    const value = getComputedStyle(el).getPropertyValue(name).trim();
    return value || fallback;
}

/** A small categorical cycle for user-added rows, built from the same
 * palette `theme.css` already defines (`--color-blue-*`/`green-*`/etc.) —
 * not a new set of colors invented for this page. */
const ROW_COLOR_TOKENS = [
    "--color-blue-50",
    "--color-green-40",
    "--color-yellow-30",
    "--color-orange-40",
    "--color-red-40",
    "--color-blue-40",
    "--color-green-50",
    "--color-red-50",
];

export function rowColorToken(index: number): string {
    return ROW_COLOR_TOKENS[index % ROW_COLOR_TOKENS.length];
}

/** Fixed pixel widths of `TimelineRow`'s label column (`w-40`) and
 * right-side button column (`w-8`) — kept here so the page's pointer/wheel
 * interaction math (which needs to know where each row's canvas region
 * starts and ends) stays in sync with the Tailwind classes actually used,
 * rather than two places independently guessing the same numbers. */
export const ROW_LABEL_WIDTH_PX = 160;
export const ROW_BUTTON_COL_WIDTH_PX = 32;

export interface TimeScale {
    startUs: number;
    endUs: number;
    width: number;
}

export function toX(scale: TimeScale, timeUs: number): number {
    const span = Math.max(1, scale.endUs - scale.startUs);
    return ((timeUs - scale.startUs) / span) * scale.width;
}

/** Draws a continuous line for one field, autoscaled to its own min/max
 * over the visible window — each row scales independently since two
 * fields sharing a row (not yet supported, but the draw routine doesn't
 * assume otherwise) rarely share a natural range. A `NaN` value breaks the
 * line rather than interpolating through it — that's a record which
 * didn't decode this field, not a real zero.
 *
 * Before the first valid sample and after the last, there's no data at
 * all — rather than leaving that stretch blank (easy to mistake for "flat
 * and boring" instead of "nothing was ever recorded here"), it's drawn as
 * a flat `neutral`-colored line held at the first/last known value, same
 * idiom as `drawState`'s leading/trailing fill. */
export function drawLine(
    ctx: CanvasRenderingContext2D,
    scale: TimeScale,
    height: number,
    times: number[],
    values: number[],
    color: string,
    neutral: string,
) {
    let min = Infinity;
    let max = -Infinity;
    let firstIdx = -1;
    let lastIdx = -1;
    for (let i = 0; i < values.length; i++) {
        if (Number.isNaN(values[i])) continue;
        if (values[i] < min) min = values[i];
        if (values[i] > max) max = values[i];
        if (firstIdx === -1) firstIdx = i;
        lastIdx = i;
    }
    if (firstIdx === -1) {
        return; // no valid sample anywhere in the visible window
    }
    if (min === max) {
        min -= 1;
        max += 1;
    }
    const pad = 4;
    const toY = (v: number) => height - pad - ((v - min) / (max - min)) * (height - pad * 2);

    if (times[firstIdx] > scale.startUs) {
        const y = toY(values[firstIdx]);
        ctx.strokeStyle = neutral;
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(toX(scale, times[firstIdx]), y);
        ctx.stroke();
    }

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    let drawing = false;
    for (let i = 0; i < times.length; i++) {
        const v = values[i];
        if (Number.isNaN(v)) {
            drawing = false;
            continue;
        }
        const x = toX(scale, times[i]);
        const y = toY(v);
        if (!drawing) {
            ctx.moveTo(x, y);
            drawing = true;
        } else {
            ctx.lineTo(x, y);
        }
    }
    ctx.stroke();

    if (times[lastIdx] < scale.endUs) {
        const y = toY(values[lastIdx]);
        ctx.strokeStyle = neutral;
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.moveTo(toX(scale, times[lastIdx]), y);
        ctx.lineTo(scale.width, y);
        ctx.stroke();
    }
}

/** Draws a value that holds until it changes as solid colored segments
 * rather than a line — the arm-state/mode idiom: you see *when* the value
 * changed and how long it held, not a jagged staircase line implying
 * interpolation between discrete states. `colorFor` maps a value to a
 * fill color.
 *
 * Only a segment *bounded by two records* is actually confirmed — the
 * state might have changed again at any point after the last one this log
 * happens to have, and nothing here knows what it was before the first.
 * Both of those (plus any `NaN` sample — a record that didn't decode this
 * field) render as `neutral` rather than assuming the nearest known value
 * already held or kept holding: "no data" reads as unknown, not as a
 * confident answer. */
export function drawState(
    ctx: CanvasRenderingContext2D,
    scale: TimeScale,
    height: number,
    times: number[],
    values: number[],
    colorFor: (value: number) => string,
    neutral: string,
) {
    if (times.length === 0) {
        return;
    }
    if (times[0] > scale.startUs) {
        ctx.fillStyle = neutral;
        ctx.fillRect(0, 2, toX(scale, times[0]), height - 4);
    }
    for (let i = 0; i < times.length; i++) {
        const x0 = toX(scale, times[i]);
        const hasNext = i + 1 < times.length;
        const x1 = hasNext ? toX(scale, times[i + 1]) : scale.width;
        ctx.fillStyle = !hasNext || Number.isNaN(values[i]) ? neutral : colorFor(values[i]);
        ctx.fillRect(x0, 2, Math.max(1, x1 - x0), height - 4);
    }
}

/** The vertical line every row (plus the console row) draws at the current
 * scrub position — the one thing tying every row's rendering to the same
 * instant. */
export function drawPlayhead(ctx: CanvasRenderingContext2D, scale: TimeScale, height: number, playheadUs: number, color: string) {
    if (playheadUs < scale.startUs || playheadUs > scale.endUs) {
        return;
    }
    const x = toX(scale, playheadUs);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, height);
    ctx.stroke();
}

/** Resizes `canvas`'s backing store to its CSS size × device pixel ratio
 * (crisp on HiDPI) and returns a context already scaled so callers draw in
 * CSS pixels. Called every redraw — cheap relative to the drawing itself,
 * and avoids a stale backing-store size after the row stack itself
 * resizes (window resize, dock resize). */
export function prepareCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    const targetW = Math.max(1, Math.round(width * dpr));
    const targetH = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        return null;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    return ctx;
}
