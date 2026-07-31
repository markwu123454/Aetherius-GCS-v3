use mavlink::dialects::ardupilotmega::BATTERY_STATUS_DATA;

use super::VehicleSnapshot;

/// `current_consumed` is `-1` when the vehicle has no capacity estimation
/// configured — treated as "not reported" rather than shown as literal -1 mAh.
pub fn apply(snapshot: &mut VehicleSnapshot, data: &BATTERY_STATUS_DATA) {
    snapshot.battery_consumed_mah = (data.current_consumed >= 0).then_some(data.current_consumed as f32);
}