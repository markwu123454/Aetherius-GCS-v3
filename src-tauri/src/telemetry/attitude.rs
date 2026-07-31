use mavlink::dialects::ardupilotmega::ATTITUDE_DATA;

use super::VehicleSnapshot;

/// Converted to degrees here, matching every other angle already on
/// `VehicleSnapshot` (`heading`) — nothing downstream should have to know
/// MAVLink reports this one in radians.
pub fn apply(snapshot: &mut VehicleSnapshot, data: &ATTITUDE_DATA) {
    snapshot.roll_deg = Some(data.roll.to_degrees());
    snapshot.pitch_deg = Some(data.pitch.to_degrees());
}