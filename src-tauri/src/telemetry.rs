use serde::Serialize;

use mavlink::dialects::ardupilotmega::MavMessage;

mod global_position;
mod gps_raw;
mod heartbeat;
mod sys_status;

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum VehicleKind {
    Plane,
    Multirotor,
    Other,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VehicleSnapshot {
    pub armed: Option<bool>,
    pub custom_mode: Option<u32>,
    pub prearm_pass: Option<bool>,
    pub battery_voltage: Option<f32>,
    pub battery_current: Option<f32>,
    pub battery_percent: Option<i8>,
    pub gps_fix: Option<u8>,
    pub satellites: Option<u8>,
    /// Resolved from HEARTBEAT's `mavtype`. `None` until the first heartbeat.
    pub vehicle_kind: Option<VehicleKind>,
    pub hdop: Option<f32>,
    /// Degrees, decimal. `None` until the first GLOBAL_POSITION_INT arrives —
    /// distinct from a real 0,0 fix, which is a legitimate place on Earth.
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    /// Meters above the home/origin altitude, not above sea level.
    pub relative_alt: Option<f32>,
    /// Degrees, 0-359. `None` when the vehicle hasn't reported a heading yet.
    pub heading: Option<f32>,
    /// Milliseconds since the last heartbeat, so the UI can go stale on its own.
    pub since_heartbeat_ms: Option<u64>,
}

/// Fold one message into the snapshot. Only the messages the status strip
/// actually needs are handled; everything else is ignored rather than stored.
/// Each arm hands off to the file that owns that message type, so no two
/// files ever need to agree on how to fill in the same field.
pub fn apply(snapshot: &mut VehicleSnapshot, message: &MavMessage) {
    match message {
        MavMessage::HEARTBEAT(data) => heartbeat::apply(snapshot, data),
        MavMessage::SYS_STATUS(data) => sys_status::apply(snapshot, data),
        MavMessage::GPS_RAW_INT(data) => gps_raw::apply(snapshot, data),
        MavMessage::GLOBAL_POSITION_INT(data) => global_position::apply(snapshot, data),
        _ => {}
    }
}