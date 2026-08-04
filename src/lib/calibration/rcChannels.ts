/** MAVLink's own sentinel for "no receiver output on this channel" —
 * `RC_CHANNELS`' documented `invalid` value. Never a real PWM width, so it's
 * filtered out everywhere a channel's value is read rather than treated as
 * an actual 65535us pulse. */
export const RC_CHANNEL_UNUSED = 65535;
