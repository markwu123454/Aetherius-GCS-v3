import {Suspense} from "react";
import {Canvas} from "@react-three/fiber";
import PlaneModel, {PlaneRotationDeg} from "./PlaneModel.tsx";
import {CameraRig, useOrbitDrag} from "./OrbitCamera.tsx";

interface OrientationViewportProps {
    label: string;
    rotationDeg: PlaneRotationDeg;
    /** Shared camera azimuth, radians — lifted to the parent panel so
     * dragging either viewport spins both in lockstep. */
    viewYaw: number;
    onViewYawChange: (yaw: number) => void;
}

/**
 * One 3D viewport: a plane model rendered at `rotationDeg`, with a
 * drag-to-orbit camera. Two of these sit side by side in
 * `AccelCalibrationPanel` — the target pose and the vehicle's live
 * telemetry-driven pose — sharing `viewYaw` so rotating one to match how the
 * operator is physically holding their vehicle rotates both together,
 * turning the comparison into a direct shape match instead of a mental
 * rotation exercise.
 */
export default function OrientationViewport({label, rotationDeg, viewYaw, onViewYawChange}: OrientationViewportProps) {
    const drag = useOrbitDrag(viewYaw, onViewYawChange);

    return (
        <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-micro text-text-helper uppercase">{label}</span>
            <div
                className="relative h-[420px] w-full touch-none border border-border-subtle bg-layer-01 [cursor:grab] active:[cursor:grabbing]"
                {...drag}
            >
                <Canvas dpr={[1, 2]} gl={{antialias: true}}>
                    <ambientLight intensity={0.7} />
                    <directionalLight position={[3, 5, 2]} intensity={1.2} />
                    <directionalLight position={[-3, -2, -4]} intensity={0.3} />
                    <CameraRig viewYaw={viewYaw} distance={2.5} />
                    <Suspense fallback={null}>
                        <PlaneModel rotationDeg={rotationDeg} />
                    </Suspense>
                </Canvas>
            </div>
        </div>
    );
}
