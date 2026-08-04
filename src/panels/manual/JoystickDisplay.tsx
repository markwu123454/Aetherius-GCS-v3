import {useMemo} from "react";
import {useRcChannels} from "@/lib/calibration/useRcChannels.ts";
import {useLiveParams} from "@/lib/params/useLiveParams.ts";
import {LEFT_STICK, RIGHT_STICK, resolveStick, reversedParamIsBool} from "@/lib/calibration/stickMapping.ts";
import StickBall from "./StickBall.tsx";

/**
 * Where the transmitter's sticks actually are right now, read straight off
 * live RC_CHANNELS + the vehicle's own `RCMAP_*`/`RCx_MIN`/`MAX`/`TRIM`/
 * `REVERSED` — the same data `RadioCalibrationPanel`'s channel monitor uses,
 * just distilled to two stick positions instead of a per-channel bar list.
 */
export default function JoystickDisplay() {
    const channels = useRcChannels();
    const {values: live} = useLiveParams();
    const boolScheme = useMemo(() => reversedParamIsBool(live), [live]);
    const left = useMemo(() => resolveStick(LEFT_STICK, channels, live, boolScheme), [channels, live, boolScheme]);
    const right = useMemo(() => resolveStick(RIGHT_STICK, channels, live, boolScheme), [channels, live, boolScheme]);

    return (
        <div className="flex flex-col items-center gap-2">
            <span className="text-label text-text-helper">RC Input</span>
            <div className="flex gap-4">
                <div className="flex flex-col items-center gap-1">
                    <div className="h-28 w-28">
                        <StickBall x={left.x} y={left.y}/>
                    </div>
                    <span className="text-micro text-text-helper">Throttle / Yaw</span>
                </div>
                <div className="flex flex-col items-center gap-1">
                    <div className="h-28 w-28">
                        <StickBall x={right.x} y={right.y}/>
                    </div>
                    <span className="text-micro text-text-helper">Pitch / Roll</span>
                </div>
            </div>
            {!channels && <span className="text-micro text-state-warn">RC not connected</span>}
        </div>
    );
}
