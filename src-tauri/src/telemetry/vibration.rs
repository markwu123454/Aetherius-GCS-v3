use mavlink::dialects::ardupilotmega::VIBRATION_DATA;

use super::VehicleSnapshot;

/// The worst of the three axes, matching how other ground stations summarize
/// vibration as one number — shaking on just one axis is still a problem.
pub fn apply(snapshot: &mut VehicleSnapshot, data: &VIBRATION_DATA) {
    snapshot.vibe = Some(data.vibration_x.max(data.vibration_y).max(data.vibration_z));
}