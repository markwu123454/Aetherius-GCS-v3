import {useMemo} from "react";
import {useLoader} from "@react-three/fiber";
import {STLLoader} from "three/examples/jsm/loaders/STLLoader.js";
import * as THREE from "three";
import {bodyRotationEuler, PlaneRotationDeg} from "./PlaneModel.tsx";

const MODEL_URL = "/models/rc_drone/drone-assem.stl";

/**
 * The STL is in millimetres, +Y up, with its camera — the nose — toward -Z:
 * already the nose-along--Z, right-along-+X layout `bodyRotationEuler`
 * assumes, so unlike the plane it needs no correction rotation. Measured from
 * the file: the frame without props is centred here, which is also the middle
 * of the four motors; the prop tips reach 194 mm from it.
 */
const MODEL_CENTER = new THREE.Vector3(132.4, 69.3, 161.0);

/** Prop tips at ~2.1, just inside the compass coverage sphere (radius 2.2). */
const MODEL_SCALE = 0.011;

const BODY_COLOR = new THREE.Color("#8d8d8d");
const ARROW_COLOR = new THREE.Color("#fa4d56");

/**
 * The forward arrow on the top and belly, in mm from `MODEL_CENTER`: along
 * the centre line, forward toward the nose. Sized to the belly's flat channel
 * (X 119–145, Z 85–195), the narrower of the two surfaces.
 */
const ARROW = {tip: 66, headBase: 32, tail: -24, headHalfWidth: 12, shaftHalfWidth: 4.5};

/** Upward faces above this (mm from the centre) are the top, from Y 80; the
 * body's top is a dome at Y 87–91 there, the arms' tops lie outside the arrow. */
const TOP_ABOVE = 10.7;
/** Downward faces below this are the belly, from Y 61; it sits at Y 57–60. */
const BELLY_BELOW = -8.3;

/**
 * Paints the arrow per fragment from the model-space position, so it follows
 * the domed top exactly — a separate flat arrow mesh would float over it or
 * sink in — and doesn't depend on how coarsely the STL is triangulated.
 */
function quadMaterial(): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial({color: BODY_COLOR, roughness: 0.6, metalness: 0.1});
    const num = (v: number) => v.toFixed(2);
    const headLength = ARROW.tip - ARROW.headBase;
    material.onBeforeCompile = (shader) => {
        shader.uniforms.arrowColor = {value: ARROW_COLOR};
        shader.vertexShader = shader.vertexShader
            .replace("#include <common>", "#include <common>\nvarying vec3 vBodyPos;\nvarying vec3 vBodyNormal;")
            .replace("#include <begin_vertex>", "#include <begin_vertex>\nvBodyPos = position;\nvBodyNormal = normal;");
        shader.fragmentShader = shader.fragmentShader
            .replace("#include <common>", "#include <common>\nuniform vec3 arrowColor;\nvarying vec3 vBodyPos;\nvarying vec3 vBodyNormal;")
            .replace(
                "#include <color_fragment>",
                `#include <color_fragment>
                {
                    // Signed distance to the arrow outline (negative inside):
                    // across from the centre line, and forward (the nose is -Z).
                    float across = abs(vBodyPos.x);
                    float forward = -vBodyPos.z;
                    float shaft = max(across - ${num(ARROW.shaftHalfWidth)}, max(${num(ARROW.tail)} - forward, forward - ${num(ARROW.headBase + 1)}));
                    float side = (across * ${num(headLength)} + (forward - ${num(ARROW.headBase)}) * ${num(ARROW.headHalfWidth)}
                        - ${num(ARROW.headHalfWidth * headLength)}) / ${num(Math.hypot(headLength, ARROW.headHalfWidth))};
                    float head = max(${num(ARROW.headBase)} - forward, side);
                    float d = min(shaft, head);
                    float edge = fwidth(d);
                    float inside = 1.0 - smoothstep(-edge, edge, d);
                    float top = step(${num(TOP_ABOVE)}, vBodyPos.y) * step(0.5, vBodyNormal.y);
                    float belly = step(vBodyPos.y, ${num(BELLY_BELOW)}) * step(vBodyNormal.y, -0.5);
                    diffuseColor.rgb = mix(diffuseColor.rgb, arrowColor, inside * max(top, belly));
                }`,
            );
    };
    return material;
}

/** One material for every viewport; each renderer compiles its own program. */
const QUAD_MATERIAL = quadMaterial();

/**
 * The loaded geometry centred on the frame, made once and shared by every
 * viewport — one geometry can back several meshes, unlike the plane's single
 * `Object3D`.
 */
const prepared = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();

function prepare(source: THREE.BufferGeometry): THREE.BufferGeometry {
    const cached = prepared.get(source);
    if (cached) {
        return cached;
    }
    const geometry = source.clone();
    geometry.translate(-MODEL_CENTER.x, -MODEL_CENTER.y, -MODEL_CENTER.z);
    prepared.set(source, geometry);
    return geometry;
}

/**
 * "RC Drone" by rukshans (https://www.cadcrowd.com/3d-models/rc-drone),
 * licensed CC BY 4.0 — see `public/models/rc_drone/license.txt`. Attribution
 * is shown in the About page.
 */
export default function QuadModel({rotationDeg}: {rotationDeg: PlaneRotationDeg}) {
    const source = useLoader(STLLoader, MODEL_URL);
    const geometry = useMemo(() => prepare(source), [source]);
    const rotation = useMemo(
        () => bodyRotationEuler(rotationDeg),
        [rotationDeg.roll, rotationDeg.pitch, rotationDeg.yaw],
    );

    return (
        <group rotation={rotation}>
            <mesh geometry={geometry} material={QUAD_MATERIAL} scale={MODEL_SCALE} />
        </group>
    );
}
