import {useMemo} from "react";
import {useLoader} from "@react-three/fiber";
import {GLTFLoader} from "three/examples/jsm/loaders/GLTFLoader.js";
import * as THREE from "three";

const MODEL_URL = "/models/low_poly_plane/scene.gltf";

/**
 * The model as exported rests nose-along-+Z with its own left side at +X
 * (confirmed by walking `scene.gltf`'s node transforms: `Propeller`, at the
 * nose, sits at world Z≈+4.1 while `Rudder`/`Elevator`, at the tail, sit at
 * Z≈-3.4; `LeftAileron` sits at X≈+4.1 and `RightAileron` at X≈-4.2) — the
 * mirror image of the nose-along--Z, right-wing-along-+X layout the rotation
 * math below assumes. A 180° yaw here is the whole fix: it swaps the model
 * into that assumed layout without touching `up` (rotation about Y leaves Y
 * alone), so roll/pitch below don't need their own sign flips.
 *
 * Left uncorrected, this made the "Target" viewport's left and right sides
 * the mirror of the vehicle's actual left/right — exactly the kind of mix-up
 * that can bake a mirrored roll calibration into the vehicle if the operator
 * follows it while physically placing a real vehicle in the "left"/"right"
 * steps.
 */
const MODEL_CORRECTION = new THREE.Euler(0, Math.PI, 0);

const MODEL_SCALE = 0.45;

export interface PlaneRotationDeg {
    roll: number;
    pitch: number;
    yaw?: number;
}

interface PlaneModelProps {
    rotationDeg: PlaneRotationDeg;
}

// Roll/pitch signs match ArduPilot's own `ATTITUDE` message (positive roll =
// right wing down, positive pitch = nose up) for a model resting
// nose-along--Z, right-wing-along-+X, belly-along--Y — the standard
// three.js/glTF right-handed layout. Yaw is rotation about the vertical
// (+Y) axis and carries no sign meaning here since callers either omit it
// (the fixed target poses) or feed it straight from telemetry.
//
// Exported so anything else that needs to share a model's live body-frame
// rotation — e.g. the compass coverage sphere, anchored to the vehicle
// rather than the world — applies the identical transform instead of
// re-deriving it and risking the two drifting out of sync.
export function bodyRotationEuler(rotationDeg: PlaneRotationDeg): THREE.Euler {
    return new THREE.Euler(
        THREE.MathUtils.degToRad(rotationDeg.pitch),
        THREE.MathUtils.degToRad(-(rotationDeg.yaw ?? 0)),   // negated
        THREE.MathUtils.degToRad(-rotationDeg.roll),
        "ZXY",                                               // was "XZY"
    );
}

/**
 * "Low Poly Plane" by scailman (https://sketchfab.com/scailman), licensed
 * CC-BY-4.0 — see `public/models/low_poly_plane/license.txt`. Attribution is
 * shown in the About page per the license's own request.
 */
export default function PlaneModel({rotationDeg}: PlaneModelProps) {
    const gltf = useLoader(GLTFLoader, MODEL_URL);
    // `useLoader` caches and reuses the same `gltf.scene` across every
    // consumer — two viewports (target + live) mounting it simultaneously
    // would otherwise fight over one shared Object3D's transform.
    const scene = useMemo(() => gltf.scene.clone(true), [gltf]);
    const rotation = useMemo(
        () => bodyRotationEuler(rotationDeg),
        [rotationDeg.roll, rotationDeg.pitch, rotationDeg.yaw],
    );

    return (
        <group rotation={rotation}>
            <group rotation={MODEL_CORRECTION} scale={MODEL_SCALE}>
                <primitive object={scene} />
            </group>
        </group>
    );
}
