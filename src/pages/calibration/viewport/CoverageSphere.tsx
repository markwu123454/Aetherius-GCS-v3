import {useEffect, useMemo} from "react";
import * as THREE from "three";
import {COMPASS_CAL_FACES, COMPASS_CAL_SECTION_COUNT} from "@/lib/calibration/compassCalGrid.ts";
import {bodyRotationEuler, PlaneRotationDeg} from "./PlaneModel.tsx";

const SPHERE_RADIUS = 2.2;
/** Shrink each triangular face toward its centroid so the seams between faces
 * are visible — makes the icosahedral structure obvious. */
const FACE_SHRINK = 0.88;

const COVERED_RGB: [number, number, number] = [0.259, 0.745, 0.396]; // #42be65
const UNCOVERED_RGB: [number, number, number] = [0.18, 0.18, 0.18];

/**
 * The 6 principal body-frame directions as they sit in the THREE.js group
 * space (after bodyRotationEuler is applied). At zero rotation the model's
 * nose points toward THREE.js -Z, top toward +Y, right toward +X — so these
 * directions are fixed relative to the vehicle model, not the world.
 *
 * Exported so CompassCoverageViewport can build a matching HTML legend and
 * compute axis-aware hint text without duplicating the direction data.
 */
export const BODY_AXES = [
    {id: "nose",   dir: [ 0,  0, -1] as const, color: "#ef4444", label: "Nose"},
    {id: "top",    dir: [ 0,  1,  0] as const, color: "#22d3ee", label: "Top"},
    {id: "right",  dir: [ 1,  0,  0] as const, color: "#facc15", label: "Right"},
    {id: "tail",   dir: [ 0,  0,  1] as const, color: "#6b7280", label: "Tail"},
    {id: "bottom", dir: [ 0, -1,  0] as const, color: "#6b7280", label: "Bottom"},
    {id: "left",   dir: [-1,  0,  0] as const, color: "#6b7280", label: "Left"},
] as const;

// Pre-compute marker positions (just outside the sphere surface) at module
// load — these never change, so no reason to recompute in component code.
const MARKER_POSITIONS = BODY_AXES.map(
    ({dir}) =>
        [dir[0] * SPHERE_RADIUS * 1.18, dir[1] * SPHERE_RADIUS * 1.18, dir[2] * SPHERE_RADIUS * 1.18] as const,
);

// Pre-build the static face position buffer once — 80 faces × 3 verts × 3 coords.
const FACE_POSITIONS = (() => {
    const buf = new Float32Array(COMPASS_CAL_SECTION_COUNT * 9);
    for (const {index, v0, v1, v2} of COMPASS_CAL_FACES) {
        const cx = (v0.x + v1.x + v2.x) / 3;
        const cy = (v0.y + v1.y + v2.y) / 3;
        const cz = (v0.z + v1.z + v2.z) / 3;
        const sh = (v: {x: number; y: number; z: number}) =>
            [(cx + (v.x - cx) * FACE_SHRINK) * SPHERE_RADIUS,
             (cy + (v.y - cy) * FACE_SHRINK) * SPHERE_RADIUS,
             (cz + (v.z - cz) * FACE_SHRINK) * SPHERE_RADIUS] as const;
        const [x0, y0, z0] = sh(v0);
        const [x1, y1, z1] = sh(v1);
        const [x2, y2, z2] = sh(v2);
        const b = index * 9;
        buf[b]     = x0; buf[b + 1] = y0; buf[b + 2] = z0;
        buf[b + 3] = x1; buf[b + 4] = y1; buf[b + 5] = z1;
        buf[b + 6] = x2; buf[b + 7] = y2; buf[b + 8] = z2;
    }
    return buf;
})();

export interface CoverageSphereProps {
    /** Length 80, index-aligned with COMPASS_CAL_SECTIONS. */
    coveredMask: boolean[];
    /** Rotates sphere + markers with the vehicle body. */
    rotationDeg: PlaneRotationDeg;
}

/**
 * 80 triangular faces of ArduPilot's compass-calibration geodesic sphere,
 * colored green once sampled and dark otherwise.
 *
 * Six colored axis markers rotate with the vehicle to show which direction is
 * the nose, top, and right side — grounding the abstract sphere faces in
 * concrete physical orientations the operator can match to their vehicle.
 *
 * A pulsing white indicator appears at the centroid of all uncovered faces so
 * the operator has a visible target to chase rather than hunting by trial and
 * error.
 */
export default function CoverageSphere({coveredMask, rotationDeg}: CoverageSphereProps) {
    const rotation = useMemo(
        () => bodyRotationEuler(rotationDeg),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [rotationDeg.roll, rotationDeg.pitch, rotationDeg.yaw],
    );

    // ── Face geometry ─────────────────────────────────────────────────────────

    const geometry = useMemo(() => {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(FACE_POSITIONS.slice(), 3));
        geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(COMPASS_CAL_SECTION_COUNT * 9), 3));
        geo.computeVertexNormals();
        return geo;
    }, []);

    useEffect(() => () => geometry.dispose(), [geometry]);

    useEffect(() => {
        const colorAttr = geometry.attributes.color as THREE.BufferAttribute;
        const cols = colorAttr.array as Float32Array;
        for (let i = 0; i < COMPASS_CAL_SECTION_COUNT; i++) {
            const [r, g, b] = coveredMask[i] ? COVERED_RGB : UNCOVERED_RGB;
            const base = i * 9;
            cols[base]     = r; cols[base + 1] = g; cols[base + 2] = b;
            cols[base + 3] = r; cols[base + 4] = g; cols[base + 5] = b;
            cols[base + 6] = r; cols[base + 7] = g; cols[base + 8] = b;
        }
        colorAttr.needsUpdate = true;
    }, [geometry, coveredMask]);

    return (
        <group rotation={rotation}>
            {/* 80 triangular face patches */}
            <mesh geometry={geometry}>
                <meshStandardMaterial vertexColors side={THREE.DoubleSide} roughness={0.55} metalness={0.05} />
            </mesh>
        </group>
    );
}
