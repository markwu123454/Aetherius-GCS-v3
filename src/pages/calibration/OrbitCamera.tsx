import {useCallback, useRef} from "react";
import type {PointerEvent as ReactPointerEvent} from "react";
import {useFrame, useThree} from "@react-three/fiber";

const CAMERA_DISTANCE = 6;
const CAMERA_HEIGHT = 2.2;
/** Radians of orbit per pixel dragged, tuned so a comfortable drag across the
 * viewport's width is roughly a half turn rather than a twitchy full spin. */
const DRAG_SENSITIVITY = 0.012;

/** Orbits the camera around the origin at a fixed radius/elevation, purely
 * from `viewYaw` — there's no `OrbitControls` here because a viewport's yaw
 * is plain lifted state, shareable across multiple `<Canvas>` instances
 * rather than owned by one scene's own camera. */
export function CameraRig({viewYaw}: {viewYaw: number}) {
    const {camera} = useThree();
    useFrame(() => {
        camera.position.set(CAMERA_DISTANCE * Math.sin(viewYaw), CAMERA_HEIGHT, CAMERA_DISTANCE * Math.cos(viewYaw));
        camera.lookAt(0, 0, 0);
    });
    return null;
}

/** Pointer handlers that turn a horizontal drag into `onViewYawChange` calls
 * — shared by every drag-to-orbit viewport so they all use the same feel. */
export function useOrbitDrag(viewYaw: number, onViewYawChange: (yaw: number) => void) {
    const dragRef = useRef<{startX: number; startYaw: number} | null>(null);

    const onPointerDown = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            dragRef.current = {startX: event.clientX, startYaw: viewYaw};
        },
        [viewYaw],
    );

    const onPointerMove = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            const drag = dragRef.current;
            if (!drag) {
                return;
            }
            // Negated: dragging right should turn the model to follow the
            // pointer (as if grabbing its surface), not spin it away from it.
            onViewYawChange(drag.startYaw - (event.clientX - drag.startX) * DRAG_SENSITIVITY);
        },
        [onViewYawChange],
    );

    const endDrag = useCallback(() => {
        dragRef.current = null;
    }, []);

    return {onPointerDown, onPointerMove, onPointerUp: endDrag, onPointerCancel: endDrag};
}
