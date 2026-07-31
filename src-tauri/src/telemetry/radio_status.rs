use mavlink::dialects::ardupilotmega::RADIO_STATUS_DATA;

use super::VehicleSnapshot;

/// `rssi` is on the radio's own device-dependent 0-254 scale, not dBm — shown
/// as a raw number rather than converted, since the scale isn't calibrated
/// the same way across radio models. Only ever arrives over an actual radio
/// link, so it stays `None` on a direct SITL connection.
pub fn apply(snapshot: &mut VehicleSnapshot, data: &RADIO_STATUS_DATA) {
    snapshot.radio_rssi = Some(data.rssi);
}