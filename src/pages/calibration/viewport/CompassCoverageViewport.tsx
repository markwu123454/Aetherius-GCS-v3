import {Suspense, useEffect, useRef, useState} from "react";
import {Canvas} from "@react-three/fiber";
import * as THREE from "three";
import type {MagField} from "@/lib/calibration/useCompassCalibration.ts";
import PlaneModel, {PlaneRotationDeg} from "./PlaneModel.tsx";
import CoverageSphere from "./CoverageSphere.tsx";
import {CameraRig, useOrbitDrag} from "./OrbitCamera.tsx";

const LEVEL_ROTATION: PlaneRotationDeg = {roll: 0, pitch: 0, yaw: 0};

interface CompassCoverageViewportProps {
    /** Live attitude, `null` until telemetry has actually arrived. */
    rotationDeg: PlaneRotationDeg | null;
    coveredMask: boolean[];
    /** Live body-frame field while calibrating, for the coverage arrow. */
    field: MagField | null;
}

/**
 * Drag-to-orbit viewport showing the coverage sphere and field arrow around
 * the vehicle model (see `CoverageSphere`).
 */
export default function CompassCoverageViewport({rotationDeg, coveredMask, field}: CompassCoverageViewportProps) {
    const [viewYaw, setViewYaw] = useState(0);
    const drag = useOrbitDrag(viewYaw, setViewYaw);
    const rotation = rotationDeg ?? LEVEL_ROTATION;

    // Yaw here is absolute heading, so a camera fixed looking north showed
    // the model turned by however far the operator happened to be facing
    // from north. Start it behind the vehicle instead — the view the accel
    // panel always has — on the first real attitude; yaw turns the model
    // from there, and dragging still orbits freely.
    const alignedRef = useRef(false);
    useEffect(() => {
        if (alignedRef.current || rotationDeg === null) return;
        alignedRef.current = true;
        setViewYaw(-THREE.MathUtils.degToRad(rotationDeg.yaw ?? 0));
    }, [rotationDeg]);

    return (
        <div
            className="relative h-[560px] w-full touch-none border border-border-subtle bg-layer-01 [cursor:grab] active:[cursor:grabbing]"
            {...drag}
        >
            <Canvas dpr={[1, 2]} gl={{antialias: true}}>
                <ambientLight intensity={0.7} />
                <directionalLight position={[3, 5, 2]} intensity={1.2} />
                <directionalLight position={[-3, -2, -4]} intensity={0.3} />
                <CameraRig viewYaw={viewYaw} />
                <Suspense fallback={null}>
                    <PlaneModel rotationDeg={rotation} />
                </Suspense>
                <CoverageSphere rotationDeg={rotation} coveredMask={coveredMask} field={field} />
            </Canvas>
        </div>
    );
}
