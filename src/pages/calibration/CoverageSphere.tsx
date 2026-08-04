import {useEffect, useMemo, useRef} from "react";
import * as THREE from "three";
import {MAG_CAL_SECTIONS, MAG_CAL_SECTION_COUNT} from "@/lib/calibration/magCalGrid.ts";
import {bodyRotationEuler, PlaneRotationDeg} from "./PlaneModel.tsx";

const SPHERE_RADIUS = 2.2;
const DOT_RADIUS = 0.07;

// Mirrors theme.css's --color-state-ok / --color-border-strong — hardcoded
// because three.js materials take real color values, not CSS custom
// properties, and this app has no light-theme variant to track.
const COVERED_COLOR = new THREE.Color("#42be65");
const UNCOVERED_COLOR = new THREE.Color("#6f6f6f");

const DUMMY = new THREE.Object3D();

interface CoverageSphereProps {
    /** Length `MAG_CAL_SECTION_COUNT`, index-aligned with `MAG_CAL_SECTIONS`. */
    coveredMask: boolean[];
    /** `completion_mask` is body-frame, same as the model — rotated
     * identically (via `bodyRotationEuler`, the same helper `PlaneModel`
     * uses) so the dots stay fixed relative to the vehicle rather than the
     * world as it's turned. */
    rotationDeg: PlaneRotationDeg;
}

/**
 * The 80 sections of ArduPilot's compass-calibration coverage sphere (see
 * `magCalGrid.ts`), rendered as dots around the vehicle model — green once
 * `MAG_CAL_PROGRESS` has reported that direction sampled, gray otherwise.
 * QGroundControl only shows a completion percentage during compass cal;
 * this answers the question a bare percentage can't — which way to keep
 * rotating.
 */
export default function CoverageSphere({coveredMask, rotationDeg}: CoverageSphereProps) {
    const meshRef = useRef<THREE.InstancedMesh>(null);
    const rotation = useMemo(
        () => bodyRotationEuler(rotationDeg),
        [rotationDeg.roll, rotationDeg.pitch, rotationDeg.yaw],
    );

    const positions = useMemo(
        () =>
            MAG_CAL_SECTIONS.map(({direction}) =>
                new THREE.Vector3(direction.x, direction.y, direction.z).multiplyScalar(SPHERE_RADIUS),
            ),
        [],
    );

    useEffect(() => {
        const mesh = meshRef.current;
        if (!mesh) {
            return;
        }
        positions.forEach((position, i) => {
            DUMMY.position.copy(position);
            DUMMY.updateMatrix();
            mesh.setMatrixAt(i, DUMMY.matrix);
            mesh.setColorAt(i, coveredMask[i] ? COVERED_COLOR : UNCOVERED_COLOR);
        });
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) {
            mesh.instanceColor.needsUpdate = true;
        }
    }, [positions, coveredMask]);

    return (
        <group rotation={rotation}>
            <instancedMesh ref={meshRef} args={[undefined, undefined, MAG_CAL_SECTION_COUNT]}>
                <sphereGeometry args={[DOT_RADIUS, 8, 8]} />
                <meshStandardMaterial roughness={0.6} />
            </instancedMesh>
        </group>
    );
}
