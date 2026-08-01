/**
 * Expands the arc-encoded airspace format back into GeoJSON polygons.
 *
 * Plain JavaScript with a hand-written `expand.d.ts` beside it, rather than
 * TypeScript, because `scripts/build-airspace.mjs` imports this same file under
 * Node to validate its own output. A TypeScript port for the app would be a
 * second implementation of the one thing that must not drift: if the encoder's
 * idea of an arc and the renderer's ever disagree, every boundary on the map is
 * quietly wrong and nothing errors.
 *
 * The format is documented in data/nasr/README.md. In short, a ring is a start
 * position plus an ordered list of primitives, each of which appends points
 * *after* the current cursor:
 *
 *   ["a", centreLon, centreLat, radiusMetres, startBearing, sweep]  arc
 *   ["l", lon, lat]                                                 straight
 *   ["p", lon, lat, lon, lat, …]                                    polyline
 *
 * Because a primitive never restates its own start, joins are continuous by
 * construction rather than by the encoder and decoder agreeing to round the
 * shared vertex the same way.
 */
import geographiclib from "geographiclib-geodesic";

const geodesic = geographiclib.Geodesic.WGS84;

/**
 * Sagitta budget for tessellating an arc, in metres. The deviation of a chord
 * from its arc is ~R·dθ²/8, so this fixes the angular step per radius rather
 * than using one step for every circle — a 4nm Class D and a 30nm Class B
 * shelf should not get the same vertex count.
 */
const DEFAULT_SAGITTA_M = 0.5;

/** Guardrails on the per-arc vertex count: enough that a small arc still reads
 * as curved, few enough that a huge one cannot blow up the geometry. */
const MIN_ARC_STEPS = 8;
const MAX_ARC_STEPS = 720;

function arcSteps(radiusMetres, sweepDegrees, sagittaMetres) {
    // dθ = 2·√(2e/R), then spread the sweep over a whole number of steps.
    const step = 2 * Math.sqrt((2 * sagittaMetres) / Math.max(radiusMetres, 1));
    const sweep = Math.abs(sweepDegrees) * (Math.PI / 180);
    return Math.min(MAX_ARC_STEPS, Math.max(MIN_ARC_STEPS, Math.ceil(sweep / step)));
}

/**
 * Appends the arc's points to `out`, excluding its first — the cursor is
 * already there. The final point is emitted from the exact end bearing rather
 * than from `start + steps × increment`, so a full circle closes on itself
 * instead of landing a rounding error short.
 */
function appendArc(out, primitive, sagittaMetres) {
    const [, centreLon, centreLat, radius, startBearing, sweep] = primitive;
    const steps = arcSteps(radius, sweep, sagittaMetres);

    for (let i = 1; i <= steps; i++) {
        const bearing = i === steps ? startBearing + sweep : startBearing + (sweep * i) / steps;
        const point = geodesic.Direct(centreLat, centreLon, bearing, radius);
        out.push([point.lon2, point.lat2]);
    }
}

function appendPolyline(out, primitive) {
    for (let i = 1; i < primitive.length; i += 2) {
        out.push([primitive[i], primitive[i + 1]]);
    }
}

/** Expands one encoded ring into a closed GeoJSON linear ring. */
export function expandRing(ring, sagittaMetres = DEFAULT_SAGITTA_M) {
    const out = [ring.s];
    for (const primitive of ring.d) {
        switch (primitive[0]) {
            case "a":
                appendArc(out, primitive, sagittaMetres);
                break;
            case "l":
                out.push([primitive[1], primitive[2]]);
                break;
            case "p":
                appendPolyline(out, primitive);
                break;
            default:
                throw new Error(`unknown airspace primitive "${primitive[0]}"`);
        }
    }

    // Close by construction. The last primitive's endpoint should already be
    // the start, but forcing it means a ring can never render as an open sliver
    // because of a sub-millimetre disagreement.
    const last = out[out.length - 1];
    if (last[0] !== ring.s[0] || last[1] !== ring.s[1]) {
        out.push([ring.s[0], ring.s[1]]);
    }
    return out;
}

/** Expands one encoded feature into a GeoJSON Feature. */
export function expandFeature(feature, sagittaMetres = DEFAULT_SAGITTA_M) {
    const polygons = feature.g.map((rings) => rings.map((ring) => expandRing(ring, sagittaMetres)));
    return {
        type: "Feature",
        properties: feature.p,
        geometry: feature.m
            ? {type: "MultiPolygon", coordinates: polygons}
            : {type: "Polygon", coordinates: polygons[0]},
    };
}

/** Expands a whole encoded file into a GeoJSON FeatureCollection. */
export function expandCollection(encoded, sagittaMetres = DEFAULT_SAGITTA_M) {
    return {
        type: "FeatureCollection",
        features: encoded.features.map((feature) => expandFeature(feature, sagittaMetres)),
    };
}
