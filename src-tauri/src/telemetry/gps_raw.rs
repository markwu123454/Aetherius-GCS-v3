use mavlink::dialects::ardupilotmega::GPS_RAW_INT_DATA;

use super::VehicleSnapshot;

pub fn apply(snapshot: &mut VehicleSnapshot, data: &GPS_RAW_INT_DATA) {
    snapshot.gps_fix = Some(data.fix_type as u8);
    snapshot.satellites = Some(data.satellites_visible);
    snapshot.hdop = Some(data.eph as f32 / 100.0);
}