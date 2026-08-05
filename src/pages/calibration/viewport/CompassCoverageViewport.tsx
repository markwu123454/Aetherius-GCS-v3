import {Suspense, useState} from "react";
import {Canvas} from "@react-three/fiber";
import PlaneModel, {PlaneRotationDeg} from "./PlaneModel.tsx";
import CoverageSphere, {BODY_AXES} from "./CoverageSphere.tsx";
import {CameraRig, useOrbitDrag} from "./OrbitCamera.tsx";

interface CompassCoverageViewportProps {
    rotationDeg: PlaneRotationDeg;
    coveredMask: boolean[];
}

/**
 * Drag-to-orbit viewport showing the coverage sphere around the vehicle model,
 * with a HTML legend and orientation hint below the canvas so the operator
 * can always see which colored marker corresponds to which vehicle face.
 */
export default function CompassCoverageViewport({rotationDeg, coveredMask}: CompassCoverageViewportProps) {
    const [viewYaw, setViewYaw] = useState(0);
    const drag = useOrbitDrag(viewYaw, setViewYaw);

    // Distinct axes only (the 3 colored ones — nose/top/right). Tail/bottom/left
    // are gray and shown as "opposites" in the legend to keep it compact.
    const legendAxes = BODY_AXES.filter(a => a.color !== "#6b7280");

    return (
        <div className="flex flex-col gap-2">
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
                    <CoverageSphere
                        rotationDeg={rotationDeg}
                        coveredMask={coveredMask}
                    />
                </Canvas>
            </div>

            {/* Axis legend — tells the operator which colored dot on the sphere
                corresponds to which face of their physical vehicle. The sphere
                and markers rotate with the vehicle model so these labels stay
                correct regardless of how the view is orbited. */}
            <div className="flex flex-wrap gap-x-5 gap-y-1">
                {legendAxes.map((axis) => {
                    // Find the opposite axis (same position but negated direction)
                    const opposite = BODY_AXES.find(
                        a => a.dir[0] === -axis.dir[0] && a.dir[1] === -axis.dir[1] && a.dir[2] === -axis.dir[2],
                    );
                    return (
                        <span key={axis.id} className="flex items-center gap-1.5 text-micro text-text-helper">
                            <span
                                className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
                                style={{backgroundColor: axis.color}}
                            />
                            {axis.label}
                            {opposite && <span className="text-text-disabled">/ {opposite.label}</span>}
                        </span>
                    );
                })}
                </div>

        </div>
    );
}
