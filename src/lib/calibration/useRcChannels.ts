import {useState} from "react";
import {useTauriEvent} from "@/lib/tauriEvent.ts";

interface RcChannelsEvent {
    /** Raw microsecond PWM per channel, index 0 = channel 1. Only the
     * channels the vehicle actually reported (`link.rs`'s `on_rc_channels`
     * clamps to `chancount`), not a fixed 18-wide array. */
    channels: number[];
}

/**
 * Latest raw RC channel values, or `null` before the first packet arrives —
 * or if RC_CHANNELS keeps reporting a `chancount` of zero, which is what
 * ArduPilot sends when no receiver is bound at all, so an empty packet reads
 * the same as no packet rather than as "zero channels of live data".
 * Requested at 20Hz alongside attitude/position (see `request_data_streams`
 * in `link.rs`) so this feels live while a calibration panel is open.
 */
export function useRcChannels(): number[] | null {
    const [channels, setChannels] = useState<number[] | null>(null);
    useTauriEvent<RcChannelsEvent>("rc-channels", (event) => setChannels(event.channels.length > 0 ? event.channels : null));
    return channels;
}
