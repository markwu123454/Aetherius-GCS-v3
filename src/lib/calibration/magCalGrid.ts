/**
 * ArduPilot's own compass-calibration coverage sphere: an icosahedron (12
 * vertices, 20 triangular faces) with each face split into 4 sub-triangles,
 * for 80 total sections — exactly matching `AP_GeodesicGrid`
 * (`libraries/AP_Math/AP_GeodesicGrid.h`/`.cpp`), which is what
 * `MAG_CAL_PROGRESS`'s 80-bit `completion_mask` is indexed against.
 *
 * The 12 vertices and 20 triangles below are ArduPilot's own table, ported
 * exactly from `libraries/AP_Math/tools/geodesic_grid/icosahedron.py`
 * (golden-ratio icosahedron; the second 10 triangles are the first 10's
 * antipodal negation, matching that script's `_first_half`/`_second_half`) —
 * so each section's *triangle* (one of 20, ~22° across) is exact. The 4-way
 * split within a triangle (a corner region per vertex, plus the inverted
 * center) is the standard geodesic subdivision scheme, not independently
 * verified bit-for-bit against ArduPilot's own `_subtriangle_index()` — so a
 * dot could occasionally land in a neighboring quadrant of its correct
 * triangle. Good enough to show which general direction still needs
 * rotating through; not survey-grade.
 */

export interface Vec3 {
    x: number;
    y: number;
    z: number;
}

export interface MagCalSection {
    /** 0-79, matches the bit index into `MAG_CAL_PROGRESS.completion_mask`. */
    index: number;
    /** Unit vector, this section's representative direction in body frame. */
    direction: Vec3;
}

function normalize(v: Vec3): Vec3 {
    const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    return {x: v.x / len, y: v.y / len, z: v.z / len};
}

function midpoint(a: Vec3, b: Vec3): Vec3 {
    return normalize({x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2});
}

function centroid(a: Vec3, b: Vec3, c: Vec3): Vec3 {
    return normalize({x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3, z: (a.z + b.z + c.z) / 3});
}

const GOLDEN_RATIO = (1 + Math.sqrt(5)) / 2;

// prettier-ignore
const VERTICES: Vec3[] = [
    {x: GOLDEN_RATIO, y: 1, z: 0}, {x: GOLDEN_RATIO, y: -1, z: 0}, {x: -GOLDEN_RATIO, y: 1, z: 0}, {x: -GOLDEN_RATIO, y: -1, z: 0},
    {x: 1, y: 0, z: GOLDEN_RATIO}, {x: -1, y: 0, z: GOLDEN_RATIO}, {x: 1, y: 0, z: -GOLDEN_RATIO}, {x: -1, y: 0, z: -GOLDEN_RATIO},
    {x: 0, y: GOLDEN_RATIO, z: 1}, {x: 0, y: GOLDEN_RATIO, z: -1}, {x: 0, y: -GOLDEN_RATIO, z: 1}, {x: 0, y: -GOLDEN_RATIO, z: -1},
].map(normalize);

/** Each of the 12 vertices above is the negation of exactly one other (the
 * icosahedron is centrally symmetric) — this is that pairing, used to build
 * the second 10 triangles from the first 10 without re-deriving coordinates. */
const ANTIPODE = [3, 2, 1, 0, 7, 6, 5, 4, 11, 10, 9, 8];

// `icosahedron.py`'s `_first_half`, as vertex indices into `VERTICES` above.
const FIRST_HALF_TRIANGLES: [number, number, number][] = [
    [2, 7, 3],
    [7, 3, 11],
    [3, 11, 10],
    [7, 11, 6],
    [11, 10, 1],
    [11, 6, 1],
    [1, 6, 0],
    [6, 0, 9],
    [6, 9, 7],
    [9, 2, 7],
];

const TRIANGLES: [number, number, number][] = [
    ...FIRST_HALF_TRIANGLES,
    ...FIRST_HALF_TRIANGLES.map(
        ([a, b, c]): [number, number, number] => [ANTIPODE[a], ANTIPODE[b], ANTIPODE[c]],
    ),
];

export const MAG_CAL_SECTION_COUNT = 80;

/** All 80 sections, index order matching `completion_mask`'s bit order. */
export const MAG_CAL_SECTIONS: MagCalSection[] = TRIANGLES.flatMap(([ia, ib, ic], triangleIndex) => {
    const a = VERTICES[ia];
    const b = VERTICES[ib];
    const c = VERTICES[ic];
    const midAB = midpoint(a, b);
    const midBC = midpoint(b, c);
    const midCA = midpoint(c, a);

    // Corner sub-triangle at each vertex, then the inverted center one —
    // section index within the triangle (j) is this array's position.
    const subDirections = [
        centroid(a, midAB, midCA),
        centroid(midAB, b, midBC),
        centroid(midCA, midBC, c),
        centroid(midAB, midBC, midCA),
    ];

    return subDirections.map((direction, j) => ({index: triangleIndex * 4 + j, direction}));
});

/** Reads bit `section` (0-79) out of `MAG_CAL_PROGRESS`'s 10-byte
 * `completionMask` — bit `section % 8` of byte `Math.floor(section / 8)`,
 * ArduPilot's own packing (`CompassCalibrator::update_completion_mask`). */
export function sectionCovered(mask: number[], section: number): boolean {
    const byte = mask[Math.floor(section / 8)] ?? 0;
    return (byte & (1 << section % 8)) !== 0;
}
