use mavlink::dialects::ardupilotmega::GLOBAL_POSITION_INT_DATA;

use super::VehicleSnapshot;

/// HDG_UNKNOWN. Everything else is centidegrees.
const HEADING_UNKNOWN: u16 = 65_535;

pub fn apply(snapshot: &mut VehicleSnapshot, data: &GLOBAL_POSITION_INT_DATA) {
    snapshot.lat = Some(data.lat as f64 / 1e7);
    snapshot.lon = Some(data.lon as f64 / 1e7);
    snapshot.relative_alt = Some(data.relative_alt as f32 / 1000.0);
    snapshot.heading = if data.hdg == HEADING_UNKNOWN {
        None
    } else {
        Some(data.hdg as f32 / 100.0)
    };
}