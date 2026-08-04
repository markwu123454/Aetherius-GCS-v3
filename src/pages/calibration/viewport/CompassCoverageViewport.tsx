import {Suspense, useState} from "react";
import {Canvas} from "@react-three/fiber";
import PlaneModel, {PlaneRotationDeg} from "./PlaneModel.tsx";
import CoverageSphere from "./CoverageSphere.tsx";
import {CameraRig, useOrbitDrag} from "./OrbitCamera.tsx";

interface CompassCoverageViewportProps {
    /** The vehicle's live attitude — the plane model and the coverage dots
     * rotate together, since `MAG_CAL_PROGRESS`'s coverage mask is anchored
     * to the vehicle body, not the world. */
    rotationDeg: PlaneRotationDeg;
    /** Length 80, index-aligned with `compassCalGrid.ts`'s `COMPASS_CAL_SECTIONS`. */
    coveredMask: boolean[];
}

/**
 * A single drag-to-orbit viewport (see `OrientationViewport`, which this
 * mirrors) showing the vehicle model wrapped in its compass-calibration
 * coverage sphere. Unlike accel calibration there's no separate "target"
 * pose to compare against — compass cal has no fixed position sequence, just
 * "keep rotating until the sphere fills in" — so one viewport is enough.
 */
export default function CompassCoverageViewport({rotationDeg, coveredMask}: CompassCoverageViewportProps) {
    const [viewYaw, setViewYaw] = useState(0);
    const drag = useOrbitDrag(viewYaw, setViewYaw);

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
                    <PlaneModel rotationDeg={rotationDeg} />
                </Suspense>
                <CoverageSphere rotationDeg={rotationDeg} coveredMask={coveredMask} />
            </Canvas>
        </div>
    );
}
