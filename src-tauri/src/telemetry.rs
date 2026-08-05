use serde::Serialize;

use mavlink::dialects::ardupilotmega::{MavMessage, MavSysStatusSensor};

mod ekf_status;
mod global_position;
mod heartbeat;

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
    pub battery_consumed_mah: Option<f32>,
    pub comm_drop_percent: Option<f32>,
    pub radio_rssi: Option<u8>,
    pub ekf_ok: Option<bool>,
    pub vibe: Option<f32>,
    pub roll_deg: Option<f32>,
    pub pitch_deg: Option<f32>,
    pub groundspeed: Option<f32>,
    /// True airspeed from the pitot sensor, meters/second. Only meaningful on planes.
    pub airspeed: Option<f32>,
    /// Meters/second, positive climbing.
    pub climb_rate: Option<f32>,
    pub home_lat: Option<f64>,
    pub home_lon: Option<f64>,
    /// Raw MAV_SYS_STATUS_SENSOR bitmasks, forwarded as-is — the frontend
    /// decodes individual bits into a named checklist.
    pub sensors_present: Option<u32>,
    pub sensors_enabled: Option<u32>,
    pub sensors_health: Option<u32>,
    /// Degrees/second, from ATTITUDE's rollspeed/pitchspeed/yawspeed — how fast
    /// the vehicle is currently rotating on each axis. Used to gate gyro
    /// calibration on the vehicle actually being still.
    pub yaw_deg: Option<f32>,
    pub roll_rate_dps: Option<f32>,
    pub pitch_rate_dps: Option<f32>,
    pub yaw_rate_dps: Option<f32>,
    /// WIND: estimated wind direction (degrees, the direction the wind is coming
    /// FROM) and horizontal speed (m/s). ArduPilot-specific message.
    pub wind_dir: Option<f32>,
    pub wind_speed: Option<f32>,
    /// NAV_CONTROLLER_OUTPUT: distance to the active waypoint (meters) and
    /// lateral cross-track deviation from the intended track (meters, signed).
    pub wp_dist: Option<u16>,
    pub xtrack_error: Option<f32>,
    /// POWER_STATUS: FC board 5V rail (volts) and servo rail (volts). A Vcc
    /// sag below ~4.8V is a sign the BEC is struggling; below ~4.5V the FC
    /// itself may brownout.
    pub board_voltage: Option<f32>,
    pub servo_voltage: Option<f32>,
    /// MISSION_CURRENT: sequence number of the currently active mission item.
    pub current_wp: Option<u16>,
}

/// Fold one message into the snapshot. Only the messages the status strip
/// actually needs are handled; everything else is ignored rather than stored.
/// Each arm hands off to the file that owns that message type, so no two
/// files ever need to agree on how to fill in the same field.
pub fn apply(snapshot: &mut VehicleSnapshot, message: &MavMessage) {
    match message {
        MavMessage::HEARTBEAT(data) => heartbeat::apply(snapshot, data),
        MavMessage::GLOBAL_POSITION_INT(data) => global_position::apply(snapshot, data),
        MavMessage::EKF_STATUS_REPORT(data) => ekf_status::apply(snapshot, data),
        MavMessage::RADIO_STATUS(data) => snapshot.radio_rssi = Some(data.rssi),
        MavMessage::HOME_POSITION(data) => {
            snapshot.home_lat = Some(data.latitude as f64 / 1e7);
            snapshot.home_lon = Some(data.longitude as f64 / 1e7);
        }
        MavMessage::VFR_HUD(data) => {
            snapshot.groundspeed = Some(data.groundspeed);
            snapshot.airspeed = Some(data.airspeed);
            snapshot.climb_rate = Some(data.climb);
        }
        MavMessage::GPS_RAW_INT(data) => {
            snapshot.gps_fix = Some(data.fix_type as u8);
            snapshot.satellites = Some(data.satellites_visible);
            snapshot.hdop = Some(data.eph as f32 / 100.0);
        }
        MavMessage::VIBRATION(data) => {
            snapshot.vibe = Some(data.vibration_x.max(data.vibration_y).max(data.vibration_z))
        }
        MavMessage::BATTERY_STATUS(data) => {
            snapshot.battery_consumed_mah =
                (data.current_consumed >= 0).then_some(data.current_consumed as f32)
        }
        MavMessage::ATTITUDE(data) => {
            snapshot.roll_deg = Some(data.roll.to_degrees());
            snapshot.pitch_deg = Some(data.pitch.to_degrees());
            snapshot.yaw_deg = Some(data.yaw.to_degrees());
            snapshot.roll_rate_dps = Some(data.rollspeed.to_degrees());
            snapshot.pitch_rate_dps = Some(data.pitchspeed.to_degrees());
            snapshot.yaw_rate_dps = Some(data.yawspeed.to_degrees());
        }
        MavMessage::WIND(data) => {
            snapshot.wind_dir = Some(data.direction);
            snapshot.wind_speed = Some(data.speed);
        }
        MavMessage::NAV_CONTROLLER_OUTPUT(data) => {
            snapshot.wp_dist = Some(data.wp_dist);
            snapshot.xtrack_error = Some(data.xtrack_error);
        }
        MavMessage::POWER_STATUS(data) => {
            snapshot.board_voltage = Some(data.Vcc as f32 / 1000.0);
            snapshot.servo_voltage = Some(data.Vservo as f32 / 1000.0);
        }
        MavMessage::MISSION_CURRENT(data) => {
            snapshot.current_wp = Some(data.seq);
        }
        MavMessage::SYS_STATUS(data) => {
            snapshot.battery_voltage = Some(data.voltage_battery as f32 / 1000.0);
            snapshot.battery_current = Some(data.current_battery as f32 / 100.0);
            snapshot.battery_percent = Some(data.battery_remaining);
            snapshot.comm_drop_percent = Some(data.drop_rate_comm as f32 / 100.0);
            snapshot.sensors_present = Some(data.onboard_control_sensors_present.bits());
            snapshot.sensors_enabled = Some(data.onboard_control_sensors_enabled.bits());
            snapshot.sensors_health = Some(data.onboard_control_sensors_health.bits());
            snapshot.prearm_pass = Some(
                data.onboard_control_sensors_health
                    .contains(MavSysStatusSensor::MAV_SYS_STATUS_PREARM_CHECK),
            );
        }
        _ => {}
    }
}
