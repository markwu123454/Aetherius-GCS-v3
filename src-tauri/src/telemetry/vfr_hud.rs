use mavlink::dialects::ardupilotmega::VFR_HUD_DATA;

use super::VehicleSnapshot;

/// Already meters/second per the MAVLink spec — no conversion needed, unlike
/// `attitude.rs`'s radians-to-degrees.
pub fn apply(snapshot: &mut VehicleSnapshot, data: &VFR_HUD_DATA) {
    snapshot.groundspeed = Some(data.groundspeed);
}