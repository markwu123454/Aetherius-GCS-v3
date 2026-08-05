import {useMemo} from "react";
import {useRcChannels} from "@/lib/calibration/useRcChannels.ts";
import {useLiveParams} from "@/lib/params/useLiveParams.ts";
import {LEFT_STICK, RIGHT_STICK, resolveStick, reversedParamIsBool} from "@/lib/calibration/stickMapping.ts";
import StickBall from "./StickBall.tsx";
import FitBox from "./FitBox.tsx";

/** Natural size the two stick balls (each `STICK_SIZE` square) plus their
 * own "Throttle / Yaw"/"Pitch / Roll" captions, the "RC Input" label, and
 * the "RC not connected" warning line settle into — `text-label`/`text-micro`
 * both have a 1rem line-height (see theme.css), and the gaps are
 * `gap-2`/`gap-1`/`gap-4` below. The warning line is always reserved space
 * (see `invisible` below) rather than only counted here and then not
 * actually present — a fixed ratio can't flex between "with warning" and
 * "without" depending on connection state. Only used to compute `RATIO`;
 * nothing here is an actual rendering constraint, since every piece scales
 * via flex sizing, not this constant directly. */
const STICK_SIZE = 112;
const LABEL_LINE = 16;
const RATIO = (STICK_SIZE * 2 + 16) / (LABEL_LINE + 8 + STICK_SIZE + 4 + LABEL_LINE + 8 + LABEL_LINE);

/**
 * Where the transmitter's sticks actually are right now, read straight off
 * live RC_CHANNELS + the vehicle's own `RCMAP_*`/`RCx_MIN`/`MAX`/`TRIM`/
 * `REVERSED` — the same data `RadioCalibrationPanel`'s channel monitor uses,
 * just distilled to two stick positions instead of a per-channel bar list.
 *
 * Fixed-aspect-ratio like `Pfd` (see `FitBox`) — the two balls scale
 * together as one rigid unit via `flex-1` (not a percentage height, which
 * would need this box's own height to already be definite before it's been
 * resolved) rather than getting stretched into ovals independently.
 */
export default function JoystickDisplay() {
    const channels = useRcChannels();
    const {values: live} = useLiveParams();
    const boolScheme = useMemo(() => reversedParamIsBool(live), [live]);
    const left = useMemo(() => resolveStick(LEFT_STICK, channels, live, boolScheme), [channels, live, boolScheme]);
    const right = useMemo(() => resolveStick(RIGHT_STICK, channels, live, boolScheme), [channels, live, boolScheme]);

    return (
        <FitBox ratio={RATIO} className="flex flex-col items-center gap-2">
            <span className="text-label text-text-helper">RC Input</span>
            <div className="flex min-h-0 flex-1 gap-4">
                <div className="flex min-h-0 min-w-0 flex-col items-center gap-1">
                    <div className="aspect-square w-auto min-h-0 flex-1">
                        <StickBall x={left.x} y={left.y}/>
                    </div>
                    <span className="text-micro text-text-helper">Throttle / Yaw</span>
                </div>
                <div className="flex min-h-0 min-w-0 flex-col items-center gap-1">
                    <div className="aspect-square w-auto min-h-0 flex-1">
                        <StickBall x={right.x} y={right.y}/>
                    </div>
                    <span className="text-micro text-text-helper">Pitch / Roll</span>
                </div>
            </div>
            <span className={`text-micro ${channels ? "invisible" : "text-state-warn"}`}>RC not connected</span>
        </FitBox>
    );
}
