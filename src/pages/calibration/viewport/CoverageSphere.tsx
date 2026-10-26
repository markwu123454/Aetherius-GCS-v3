import {useEffect, useMemo} from "react";
import * as THREE from "three";
import {COMPASS_CAL_FACES, COMPASS_CAL_SECTION_COUNT, Vec3} from "@/lib/calibration/compassCalGrid.ts";
import type {MagField} from "@/lib/calibration/useCompassCalibration.ts";
import {bodyRotationEuler, PlaneRotationDeg} from "./PlaneModel.tsx";

const SPHERE_RADIUS = 2.2;
/** Shrink each triangular face toward its centroid so the seams between faces
 * are visible — makes the icosahedral structure obvious. */
const FACE_SHRINK = 0.88;

const COVERED_RGB: [number, number, number] = [0.259, 0.745, 0.396]; // #42be65
const UNCOVERED_RGB: [number, number, number] = [0.18, 0.18, 0.18];

/** The side of the shell facing the camera — faint enough to see the
 * vehicle and the sphere's underside through, solid enough to still read
 * its own coverage. */
const NEAR_SIDE_OPACITY = 0.3;

const ARROW_COLOR = "#f4f4f4";
/** From just off the fuselage to just short of the shell, so the tip touches
 * the face being sampled without poking through it. */
const ARROW_START = 0.35 * SPHERE_RADIUS;
const ARROW_TIP = 0.96 * SPHERE_RADIUS;
const ARROW_HEAD_LENGTH = 0.3;
const ARROW_AXIS = new THREE.Vector3(0, 1, 0);

/** ArduPilot body frame (x nose, y right wing, z belly) — the frame
 * `completion_mask` and `RAW_IMU`'s field are both in — to the model's
 * group space (x right wing, y top, z tail). Taken raw, the painted
 * coverage sat rotated away from the vehicle face it was sampled on. */
function bodyToScene(v: Vec3): THREE.Vector3 {
    return new THREE.Vector3(v.y, -v.z, -v.x);
}

// Pre-build the static face position buffer once — 80 faces × 3 verts × 3 coords.
const FACE_POSITIONS = (() => {
    const buf = new Float32Array(COMPASS_CAL_SECTION_COUNT * 9);
    for (const {index, v0, v1, v2} of COMPASS_CAL_FACES) {
        const centroid = bodyToScene({
            x: (v0.x + v1.x + v2.x) / 3,
            y: (v0.y + v1.y + v2.y) / 3,
            z: (v0.z + v1.z + v2.z) / 3,
        });
        const corner = (v: Vec3) => bodyToScene(v).lerp(centroid, 1 - FACE_SHRINK).multiplyScalar(SPHERE_RADIUS);
        const a = corner(v0);
        let b = corner(v1);
        let c = corner(v2);
        // Wind every face counter-clockwise seen from outside: ArduPilot's
        // second 10 triangles are the first 10 negated, which flips their
        // winding, and the near/far split below culls by winding.
        const normal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
        if (normal.dot(centroid) < 0) {
            [b, c] = [c, b];
        }
        buf.set([a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z], index * 9);
    }
    return buf;
})();

/** Points from the vehicle along the field it's measuring, tip on the face
 * that field passes through — the one ArduPilot is filling right now. */
function FieldArrow({direction}: {direction: THREE.Vector3}) {
    const quaternion = useMemo(() => new THREE.Quaternion().setFromUnitVectors(ARROW_AXIS, direction), [direction]);
    const shaftLength = ARROW_TIP - ARROW_HEAD_LENGTH - ARROW_START;

    return (
        <group quaternion={quaternion}>
            <mesh position={[0, ARROW_START + shaftLength / 2, 0]}>
                <cylinderGeometry args={[0.035, 0.035, shaftLength, 12]} />
                <meshBasicMaterial color={ARROW_COLOR} />
            </mesh>
            <mesh position={[0, ARROW_TIP - ARROW_HEAD_LENGTH / 2, 0]}>
                <coneGeometry args={[0.13, ARROW_HEAD_LENGTH, 20]} />
                <meshBasicMaterial color={ARROW_COLOR} />
            </mesh>
        </group>
    );
}

export interface CoverageSphereProps {
    /** Length 80, index-aligned with COMPASS_CAL_SECTIONS. */
    coveredMask: boolean[];
    /** Rotates sphere + arrow with the vehicle body. */
    rotationDeg: PlaneRotationDeg;
    /** Live body-frame field; no arrow while `null`. */
    field: MagField | null;
}

/**
 * 80 triangular faces of ArduPilot's compass-calibration geodesic sphere,
 * colored green once sampled and dark otherwise, attached to the vehicle.
 *
 * ArduPilot files each sample under the face the measured field passes
 * through, and Earth's field points one fixed way in the room — toward
 * magnetic north and steeply down in mid-latitudes. So the arrow along that
 * field stays put while the sphere turns under it, and its tip marks the one
 * face being filled: turn the vehicle until dark faces pass under it.
 *
 * That spot is always on the underside, which the camera (looking down from
 * above) can't see through a solid shell — so the side facing the camera is
 * drawn faint and the far side solid, seen from inside, where the arrow tip
 * lands.
 */
export default function CoverageSphere({coveredMask, rotationDeg, field}: CoverageSphereProps) {
    const rotation = useMemo(
        () => bodyRotationEuler(rotationDeg),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [rotationDeg.roll, rotationDeg.pitch, rotationDeg.yaw],
    );

    const fieldDirection = useMemo(() => {
        if (!field) return null;
        const direction = bodyToScene(field);
        return direction.lengthSq() > 0 ? direction.normalize() : null;
    }, [field]);

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
            {/* Far side, seen from inside */}
            <mesh geometry={geometry}>
                <meshStandardMaterial vertexColors side={THREE.BackSide} roughness={0.55} metalness={0.05} />
            </mesh>
            {/* Near side, see-through */}
            <mesh geometry={geometry}>
                <meshStandardMaterial
                    vertexColors
                    side={THREE.FrontSide}
                    transparent
                    opacity={NEAR_SIDE_OPACITY}
                    depthWrite={false}
                    roughness={0.55}
                    metalness={0.05}
                />
            </mesh>
            {fieldDirection && <FieldArrow direction={fieldDirection} />}
        </group>
    );
}
