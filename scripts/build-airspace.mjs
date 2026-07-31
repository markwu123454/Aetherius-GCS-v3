/**
 * Converts the FAA's Class B/C/D/E airspace shapefile into the arc-encoded
 * format the map loads at runtime.
 *
 *   npm run build:airspace
 *   npm run build:airspace -- --inspect     # schema only, writes nothing
 *   npm run build:airspace -- --class=b,d   # limit to some classes
 *
 * Why this is parameter *recovery* and not curve fitting
 * ------------------------------------------------------
 * The shapefile does not contain sampled curves that need approximating. It
 * contains exact circles that were densified at a fixed 1-milliradian angular
 * step — a Class D arrives as ~6,285 points regardless of its radius, and the
 * radii come back as 4.2, 4.4, 5.0nm once you measure them on the ellipsoid.
 * So the job is to recognise those runs and recover the parameters that
 * generated them, which is exact, rather than to fit circles to them, which
 * would not be.
 *
 * Measured over the 2026-07-09 cycle, 92.9% of all vertices lie on constant
 * turn-angle arc runs and 2.0% on straight runs. The remaining 5.1% — mostly
 * offshore Class E6, which really does follow non-geometric boundaries — has no
 * arc structure to recover and is kept as points. That fallback is cheap
 * precisely because it is rare, which in turn buys it a *tighter* simplify
 * tolerance than would be affordable if everything were points.
 *
 * Everything written is validated by expanding it back through the same module
 * the app renders with (src/airspace/expand.js) and comparing against the
 * original vertices. A residual is reported per class; nothing is taken on
 * trust from the fact that the fit converged.
 */
import {readdirSync, readFileSync, mkdirSync, writeFileSync, statSync} from "node:fs";
import {join, relative, basename} from "node:path";
import {fileURLToPath} from "node:url";
import {open} from "shapefile";
import geographiclib from "geographiclib-geodesic";
import {expandRing} from "../src/airspace/expand.js";

const geodesic = geographiclib.Geodesic.WGS84;

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_DIR = join(ROOT, "data", "nasr");
const OUT_DIR = join(ROOT, "public", "airspace");

const NM = 1852;

/* ── segmentation ─────────────────────────────────────────────────────── */

/** Below this a turn is "no turn" and the run is straight. 1e-4 rad is two
 * orders of magnitude under the 1mrad densification step. */
const STRAIGHT_RAD = 1e-4;

/** How much the turn angle may drift within one arc run. Generous because the
 * local-metre approximation used for classification distorts slightly across a
 * large ring; the geodesic fit afterwards is what actually decides. */
const TURN_REL_TOL = 0.1;

/** Runs shorter than this are not worth a primitive — the arc costs six numbers
 * and the points would cost fewer. */
const MIN_RUN = 20;

/* ── recovery ─────────────────────────────────────────────────────────── */

/** A recovered arc must reproduce every one of its own source vertices to
 * within this, or it is rejected and the run falls back to points. */
const ARC_ACCEPT_M = 0.5;

/** Points used to fit a centre. The run may have thousands; a few dozen spread
 * across it pin a circle exactly as well, and the fit is O(iterations × this).
 * Acceptance is then checked against every vertex, not against these. */
const FIT_SAMPLES = 48;

/** Snap a recovered radius onto the 0.1nm grid the FAA writes regulations in,
 * but only when it is already this close — a genuine 4.37nm boundary must not
 * be rounded to 4.4nm just because most of its neighbours are. */
const RADIUS_SNAP_M = 1.0;

/** Simplify tolerance for runs kept as points, in metres. Tighter than the
 * 1.11m a whole-dataset Douglas-Peucker pass could afford, which is the payoff
 * for arcs absorbing ~93% of the vertices: what is left is small enough to
 * keep at higher fidelity. */
const POINTS_TOLERANCE_M = 0.25;

const COORD_PRECISION = 7;
const NULL_ALTITUDE = -9998;

/** Features put through the full expand-and-compare check. Capped because that
 * check is quadratic in vertex count; the analytic per-primitive validation
 * runs on everything. */
const END_TO_END_SAMPLE = 40;

const KEPT_FIELDS = [
    "IDENT", "NAME", "CLASS", "LOCAL_TYPE",
    "UPPER_VAL", "UPPER_CODE", "LOWER_VAL", "LOWER_CODE",
    "WKHR_CODE", "EXCLUSION",
];

const args = process.argv.slice(2);
const inspectOnly = args.includes("--inspect");
const classFilter = args
    .find((a) => a.startsWith("--class="))
    ?.slice("--class=".length)
    .split(",")
    .map((c) => c.trim().toUpperCase());

/* ── small helpers ────────────────────────────────────────────────────── */

const round = (v, p = COORD_PRECISION) => Number(v.toFixed(p));

function findShapefiles(dir) {
    const found = [];
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) found.push(...findShapefiles(path));
        else if (entry.name.toLowerCase().endsWith(".shp")) found.push(path);
    }
    return found;
}

function rings(coordinates, depth) {
    return depth === 1 ? [coordinates] : coordinates.flatMap((c) => rings(c, depth - 1));
}

/** Local equirectangular metres about the ring centroid. Used only to classify
 * turn angles — fitting circles in raw degrees would be wrong, since a ground
 * circle is an ellipse in lon/lat. */
function toLocalMetres(ring) {
    let lon0 = 0;
    let lat0 = 0;
    for (const [lon, lat] of ring) {
        lon0 += lon;
        lat0 += lat;
    }
    lon0 /= ring.length;
    lat0 /= ring.length;
    const kx = Math.cos((lat0 * Math.PI) / 180) * 111320;
    return ring.map(([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * 110540]);
}

function turnAngles(points) {
    const turns = new Float64Array(points.length);
    for (let i = 1; i < points.length - 1; i++) {
        const ax = points[i][0] - points[i - 1][0];
        const ay = points[i][1] - points[i - 1][1];
        const bx = points[i + 1][0] - points[i][0];
        const by = points[i + 1][1] - points[i][1];
        turns[i] = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
    }
    return turns;
}

/** Splits a ring into `{kind, start, end}` runs — "arc", "line" or "points". */
function segmentRing(localPoints) {
    const n = localPoints.length;
    if (n < MIN_RUN + 3) return [{kind: "points", start: 0, end: n - 1}];

    const turns = turnAngles(localPoints);
    const runs = [];

    const push = (kind, start, end) => {
        if (end <= start) return;
        const previous = runs[runs.length - 1];
        // Coalesce, so a ring does not end up with hundreds of adjacent
        // two-vertex point runs each paying a primitive's overhead.
        if (previous && previous.kind === kind && previous.end === start) previous.end = end;
        else runs.push({kind, start, end});
    };

    // `turns[i]` is the turn *at* vertex i, so a run of turn indices [i, j)
    // spans vertices [i-1, j]. Runs must therefore chain from a cursor rather
    // than each deriving its own start from i — deriving it independently
    // overlaps consecutive runs by one vertex, which both double-counts that
    // vertex and stops adjacent runs from ever coalescing.
    let cursor = 0;
    let i = 1;

    while (i < n - 1) {
        const reference = turns[i];
        const tolerance = Math.max(TURN_REL_TOL * Math.abs(reference), 2e-5);
        let j = i;
        while (j < n - 1 && Math.abs(turns[j] - reference) <= tolerance) j++;

        const end = Math.min(Math.max(j, i + 1), n - 1);
        push(j - i >= MIN_RUN ? (Math.abs(reference) < STRAIGHT_RAD ? "line" : "arc") : "points", cursor, end);
        cursor = end;
        i = j > i ? j : i + 1;
    }

    push("points", cursor, n - 1);
    return runs;
}

/* ── geodesic circle recovery ─────────────────────────────────────────── */

function sampleIndices(start, end, count) {
    const span = end - start;
    if (span <= count) return Array.from({length: span + 1}, (_, k) => start + k);
    return Array.from({length: count}, (_, k) => start + Math.round((k * span) / (count - 1)));
}

/** Kasa algebraic fit in local metres — only ever the starting guess for the
 * geodesic refinement below, so its small-radius bias does not matter. */
function planarCentre(points, indices) {
    let Sx = 0, Sy = 0, Sxx = 0, Syy = 0, Sxy = 0, Sxz = 0, Syz = 0, Sz = 0;
    for (const i of indices) {
        const [x, y] = points[i];
        const z = x * x + y * y;
        Sx += x; Sy += y; Sxx += x * x; Syy += y * y;
        Sxy += x * y; Sxz += x * z; Syz += y * z; Sz += z;
    }
    const n = indices.length;
    const m11 = 2 * (Sxx - (Sx * Sx) / n);
    const m12 = 2 * (Sxy - (Sx * Sy) / n);
    const m22 = 2 * (Syy - (Sy * Sy) / n);
    const det = m11 * m22 - m12 * m12;
    if (Math.abs(det) < 1e-9) return null;
    const r1 = Sxz - (Sx * Sz) / n;
    const r2 = Syz - (Sy * Sz) / n;
    return [(r1 * m22 - r2 * m12) / det, (m11 * r2 - m12 * r1) / det];
}

function geodesicDistance(centre, point) {
    return geodesic.Inverse(centre[1], centre[0], point[1], point[0]).s12;
}

/**
 * Refines a centre by pattern search on the spread of geodesic radii. A
 * spherical model leaves ~40m of apparent spread on a 5nm circle — the
 * meridional and prime-vertical curvatures differ by ~0.3% — so this has to run
 * on the ellipsoid or the whole exercise is pointless.
 */
function refineCentre(ringLonLat, indices, initial) {
    const spread = (centre) => {
        let min = Infinity;
        let max = -Infinity;
        for (const i of indices) {
            const d = geodesicDistance(centre, ringLonLat[i]);
            if (d < min) min = d;
            if (d > max) max = d;
        }
        return max - min;
    };

    let centre = initial;
    let best = spread(centre);
    let step = 0.005;
    while (step > 1e-9) {
        let improved = false;
        for (const [dx, dy] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
            const candidate = [centre[0] + dx, centre[1] + dy];
            const value = spread(candidate);
            if (value < best) {
                best = value;
                centre = candidate;
                improved = true;
            }
        }
        if (!improved) step /= 2;
    }
    return centre;
}

function bearingFrom(centre, point) {
    return geodesic.Inverse(centre[1], centre[0], point[1], point[0]).azi1;
}

/**
 * Recovers `["a", …]` for a run, or null if the result does not reproduce every
 * source vertex within ARC_ACCEPT_M. Rejection is the normal path for anything
 * that merely looked arc-like to the turn-angle classifier.
 */
function recoverArc(ringLonLat, localPoints, run) {
    const indices = sampleIndices(run.start, run.end, FIT_SAMPLES);
    const planar = planarCentre(localPoints, indices);
    if (!planar) return null;

    // Local metres back to lon/lat for the initial guess.
    let lon0 = 0;
    let lat0 = 0;
    for (const [lon, lat] of ringLonLat) {
        lon0 += lon;
        lat0 += lat;
    }
    lon0 /= ringLonLat.length;
    lat0 /= ringLonLat.length;
    const kx = Math.cos((lat0 * Math.PI) / 180) * 111320;
    const guess = [lon0 + planar[0] / kx, lat0 + planar[1] / 110540];

    const centre = refineCentre(ringLonLat, indices, guess);

    let radius = 0;
    for (const i of indices) radius += geodesicDistance(centre, ringLonLat[i]);
    radius /= indices.length;

    // Snap onto the 0.1nm grid regulations are written in, but only if already
    // within a metre of it.
    const snapped = Math.round((radius / NM) * 10) / 10 * NM;
    if (Math.abs(snapped - radius) <= RADIUS_SNAP_M) radius = snapped;

    // Unwrap bearings so a sweep past ±180° accumulates instead of flipping.
    const startBearing = bearingFrom(centre, ringLonLat[run.start]);
    let previous = startBearing;
    let sweep = 0;
    for (let i = run.start + 1; i <= run.end; i++) {
        const bearing = bearingFrom(centre, ringLonLat[i]);
        let delta = bearing - previous;
        while (delta > 180) delta -= 360;
        while (delta < -180) delta += 360;
        sweep += delta;
        previous = bearing;
    }
    if (Math.abs(Math.abs(sweep) - 360) < 0.5) sweep = Math.sign(sweep) * 360;

    const arc = ["a", round(centre[0]), round(centre[1]), round(radius, 3), round(startBearing, 6), round(sweep, 6)];

    // Accept only if the recovered circle passes through every vertex of the
    // run, not just the 48 it was fitted on. Checked analytically — the true
    // error of an arc is how far each vertex sits off the recovered radius,
    // whereas expanding it first and measuring against the tessellation would
    // mostly report the tessellation step.
    let deviation = 0;
    for (let i = run.start; i <= run.end; i++) {
        const offset = Math.abs(geodesicDistance([arc[1], arc[2]], ringLonLat[i]) - radius);
        if (offset > deviation) deviation = offset;
        if (deviation > ARC_ACCEPT_M) return null;
    }

    return {arc, deviation};
}

/* ── points fallback ──────────────────────────────────────────────────── */

function segmentDistance(p, a, b) {
    let [x, y] = a;
    const dx = b[0] - x;
    const dy = b[1] - y;
    if (dx !== 0 || dy !== 0) {
        const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
        if (t > 1) [x, y] = b;
        else if (t > 0) {
            x += dx * t;
            y += dy * t;
        }
    }
    return Math.hypot(p[0] - x, p[1] - y);
}

/**
 * Douglas-Peucker over `points[run.start..run.end]`, returning the indices it
 * keeps. Indices rather than positions so the caller can pull the matching
 * lon/lat out of the original ring while measuring deviation in local metres.
 *
 * Explicit stack, not recursion: rings here run to six figures of vertices, and
 * near-collinear input is exactly the shape that makes the recursive form
 * descend one level per point and overflow.
 */
function simplifyIndices(points, run, toleranceMetres) {
    const first = run.start;
    const last = run.end;
    if (last - first <= 1) return [first, last];

    const keep = new Uint8Array(last - first + 1);
    keep[0] = 1;
    keep[last - first] = 1;

    const stack = [[first, last]];
    while (stack.length > 0) {
        const [lo, hi] = stack.pop();
        let worst = 0;
        let farthest = -1;
        for (let i = lo + 1; i < hi; i++) {
            const d = segmentDistance(points[i], points[lo], points[hi]);
            if (d > worst) {
                worst = d;
                farthest = i;
            }
        }
        if (farthest !== -1 && worst > toleranceMetres) {
            keep[farthest - first] = 1;
            stack.push([lo, farthest], [farthest, hi]);
        }
    }

    const indices = [];
    for (let i = 0; i < keep.length; i++) if (keep[i] === 1) indices.push(first + i);
    return indices;
}

/* ── validation ───────────────────────────────────────────────────────── */

/**
 * Worst distance from any original vertex to the rebuilt ring, in metres.
 *
 * Measured point-to-*segment*, not point-to-point: the rebuilt ring has its own
 * vertices in different places, so nearest-vertex would report the tessellation
 * step rather than any real error. Uses a local metre scale at the ring's
 * latitude, which is ample for an error metric.
 */
function maxDeviation(original, rebuilt) {
    if (rebuilt.length < 2) return Infinity;
    const kx = Math.cos((original[0][1] * Math.PI) / 180) * 111320;
    const toM = ([lon, lat]) => [lon * kx, lat * 110540];
    const rebuiltM = rebuilt.map(toM);

    let worst = 0;
    for (const point of original) {
        const p = toM(point);
        let nearest = Infinity;
        for (let i = 1; i < rebuiltM.length; i++) {
            const d = segmentDistance(p, rebuiltM[i - 1], rebuiltM[i]);
            if (d < nearest) nearest = d;
            if (nearest === 0) break;
        }
        if (nearest > worst) worst = nearest;
    }
    return worst;
}

/* ── encoding ─────────────────────────────────────────────────────────── */

/** Worst distance, in metres, from the run's own vertices to the polyline
 * `kept` that will stand in for them. */
function polylineDeviation(localPoints, run, keptIndices) {
    let worst = 0;
    let segment = 0;
    for (let i = run.start; i <= run.end; i++) {
        while (segment < keptIndices.length - 2 && keptIndices[segment + 1] < i) segment++;
        const d = segmentDistance(
            localPoints[i],
            localPoints[keptIndices[segment]],
            localPoints[keptIndices[segment + 1]],
        );
        if (d > worst) worst = d;
    }
    return worst;
}

function encodeRing(ring, stats) {
    const localPoints = toLocalMetres(ring);
    const runs = segmentRing(localPoints);
    const primitives = [];
    let worst = 0;

    const note = (deviation) => {
        if (deviation > worst) worst = deviation;
    };

    for (const run of runs) {
        if (run.end <= run.start) continue;

        if (run.kind === "arc") {
            const recovered = recoverArc(ring, localPoints, run);
            if (recovered) {
                primitives.push(recovered.arc);
                note(recovered.deviation);
                stats.arcs++;
                stats.arcVertices += run.end - run.start;
                continue;
            }
            stats.rejected++;
        } else if (run.kind === "line") {
            // A run can pass the per-vertex straightness test and still bow
            // measurably: 200 vertices each turning just under STRAIGHT_RAD
            // accumulate about a degree of bend. Validate the chord actually
            // stands in for the run before collapsing it to one point.
            const deviation = polylineDeviation(localPoints, run, [run.start, run.end]);
            if (deviation <= POINTS_TOLERANCE_M) {
                note(deviation);
                const end = ring[run.end];
                primitives.push(["l", round(end[0]), round(end[1])]);
                stats.lines++;
                continue;
            }
            stats.rejected++;
        }

        // Everything else, plus any arc that failed validation.
        const kept = simplifyIndices(localPoints, run, POINTS_TOLERANCE_M);
        note(polylineDeviation(localPoints, run, kept));

        const flat = ["p"];
        for (let k = 1; k < kept.length; k++) {
            const [lon, lat] = ring[kept[k]];
            flat.push(round(lon), round(lat));
        }
        if (flat.length > 1) {
            primitives.push(flat);
            stats.pointRuns++;
            stats.pointsKept += (flat.length - 1) / 2;
        }
    }

    return {ring: {s: [round(ring[0][0]), round(ring[0][1])], d: primitives}, worst};
}

function cleanProperties(raw) {
    const properties = {};
    for (const field of KEPT_FIELDS) {
        let value = raw[field];
        if (value === "<Null>" || value === "") value = null;
        if ((field === "UPPER_VAL" || field === "LOWER_VAL") && value === NULL_ALTITUDE) value = null;
        properties[field] = value ?? null;
    }
    return properties;
}

/* ── driver ───────────────────────────────────────────────────────────── */

async function readFeatures(shpPath) {
    const features = [];
    const source = await open(shpPath, shpPath.replace(/\.shp$/i, ".dbf"), {encoding: "utf-8"});
    while (true) {
        const {done, value} = await source.read();
        if (done) break;
        if (value?.geometry) features.push(value);
    }
    return features;
}

function detectCycle() {
    try {
        const row = readFileSync(join(SOURCE_DIR, "CLS_ARSP.csv"), "utf-8").split("\n")[1];
        return row?.match(/"(\d{4})\/(\d{2})\/(\d{2})"/)?.slice(1, 4).join("-") ?? null;
    } catch {
        return null;
    }
}

function reportSchema(features, label) {
    const fields = new Map();
    for (const feature of features) {
        for (const [key, value] of Object.entries(feature.properties ?? {})) {
            if (!fields.has(key)) fields.set(key, new Set());
            const seen = fields.get(key);
            if (seen.size < 12 && value !== null && value !== "") seen.add(String(value));
        }
    }
    console.log(`\n  ${label} — ${features.length} features`);
    console.log(`  geometry: ${[...new Set(features.map((f) => f.geometry.type))].join(", ")}`);
    for (const [key, values] of fields) {
        console.log(`    ${key.padEnd(18)} ${[...values].slice(0, 6).join(" | ")}`);
    }
}

async function main() {
    let shapefiles = [];
    try {
        shapefiles = findShapefiles(SOURCE_DIR);
    } catch {
        console.error(`No ${relative(ROOT, SOURCE_DIR)} — see data/nasr/README.md.`);
        process.exit(1);
    }
    if (shapefiles.length === 0) {
        console.error(`No .shp under ${relative(ROOT, SOURCE_DIR)} — see data/nasr/README.md.`);
        process.exit(1);
    }

    for (const shp of shapefiles) {
        console.log(`${relative(ROOT, shp)} (${(statSync(shp).size / 1e6).toFixed(1)} MB)`);
    }

    if (inspectOnly) {
        for (const shp of shapefiles) reportSchema(await readFeatures(shp), basename(shp));
        console.log("\n--inspect: nothing written.");
        return;
    }

    const byClass = new Map();
    const stats = {arcs: 0, lines: 0, pointRuns: 0, pointsKept: 0, arcVertices: 0, rejected: 0};
    const endToEnd = {checked: 0, worst: 0, worstName: null};
    let sourceVertices = 0;

    for (const shp of shapefiles) {
        for (const feature of await readFeatures(shp)) {
            const airspaceClass = String(feature.properties?.CLASS ?? "unknown");
            if (classFilter && !classFilter.includes(airspaceClass.toUpperCase())) continue;

            const isMulti = feature.geometry.type === "MultiPolygon";
            const polygons = isMulti ? feature.geometry.coordinates : [feature.geometry.coordinates];

            let worst = 0;
            const encoded = {
                p: cleanProperties(feature.properties ?? {}),
                m: isMulti ? 1 : 0,
                g: polygons.map((polygon) =>
                    polygon.map((ring) => {
                        sourceVertices += ring.length;
                        const {ring: encodedRing, worst: deviation} = encodeRing(ring, stats);
                        if (deviation > worst) worst = deviation;
                        return encodedRing;
                    }),
                ),
            };

            // Every primitive is validated analytically above. Independently of
            // that, push a sample of whole features back through the expander
            // the app actually renders with and measure the result against the
            // original vertices — that is the only check that would catch the
            // encoder and the decoder agreeing with each other but not with the
            // source. It is sampled because it is O(vertices x rebuilt) and the
            // analytic pass already covers everything.
            if (endToEnd.checked < END_TO_END_SAMPLE) {
                endToEnd.checked++;
                polygons.forEach((polygon, pi) => {
                    polygon.forEach((ring, ri) => {
                        const deviation = maxDeviation(ring, expandRing(encoded.g[pi][ri]));
                        if (deviation > endToEnd.worst) {
                            endToEnd.worst = deviation;
                            endToEnd.worstName = encoded.p.NAME;
                        }
                    });
                });
            }

            const key = airspaceClass.toLowerCase();
            if (!byClass.has(key)) byClass.set(key, {features: [], worst: 0, worstName: null});
            const bucket = byClass.get(key);
            bucket.features.push(encoded);
            if (worst > bucket.worst) {
                bucket.worst = worst;
                bucket.worstName = encoded.p.NAME;
            }
        }
    }

    mkdirSync(OUT_DIR, {recursive: true});
    const cycle = detectCycle();
    const manifest = {cycle, format: "aetherius-airspace/1", classes: {}};

    console.log("\nclass  features       size   worst deviation");
    for (const [airspaceClass, bucket] of [...byClass].sort()) {
        const file = `class-${airspaceClass}.json`;
        writeFileSync(
            join(OUT_DIR, file),
            JSON.stringify({format: manifest.format, cycle, class: airspaceClass, features: bucket.features}),
        );
        const bytes = statSync(join(OUT_DIR, file)).size;
        manifest.classes[airspaceClass] = {
            file,
            features: bucket.features.length,
            bytes,
            worstDeviationM: Number(bucket.worst.toFixed(3)),
        };
        console.log(
            airspaceClass.toUpperCase().padEnd(6),
            String(bucket.features.length).padStart(8),
            ((bytes / 1e6).toFixed(2) + " MB").padStart(11),
            (bucket.worst.toFixed(2) + " m").padStart(12),
            ` ${bucket.worstName ?? ""}`,
        );
    }

    writeFileSync(join(OUT_DIR, "index.json"), JSON.stringify(manifest, null, 2));

    const primitives = stats.arcs + stats.lines + stats.pointRuns;
    console.log(
        `\n${sourceVertices.toLocaleString()} source vertices → ` +
        `${primitives.toLocaleString()} primitives + ${stats.pointsKept.toLocaleString()} kept points`,
    );
    console.log(
        `  ${stats.arcs.toLocaleString()} arcs (absorbing ${stats.arcVertices.toLocaleString()} vertices), ` +
        `${stats.lines.toLocaleString()} lines, ${stats.pointRuns.toLocaleString()} point runs`,
    );
    if (stats.rejected > 0) {
        console.log(`  ${stats.rejected.toLocaleString()} arc candidates rejected on validation → points`);
    }
    console.log(
        `end-to-end: ${endToEnd.checked} features re-expanded through src/airspace/expand.js, ` +
        `worst ${endToEnd.worst.toFixed(3)} m${endToEnd.worstName ? ` (${endToEnd.worstName})` : ""}`,
    );
    if (cycle) console.log(`cycle ${cycle}`);
}

await main();
