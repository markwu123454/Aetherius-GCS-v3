use mavlink::dialects::ardupilotmega::AUTOPILOT_VERSION_DATA;

use super::VehicleSnapshot;

/// AUTOPILOT_VERSION isn't part of ArduPilot's normal telemetry stream — it's
/// requested once via `MAV_CMD_REQUEST_MESSAGE` right after the first
/// HEARTBEAT (see `link::request_autopilot_version`) and answered once, so
/// these fields fill in a beat after everything else and then hold steady.
///
/// `flight_sw_version` packs major/minor/patch/`FIRMWARE_VERSION_TYPE` into
/// one `u32`, MSB to LSB. The `*_custom_version` fields are git hashes —
/// shown as hex since that's how ArduPilot's own changelogs reference a
/// build.
pub fn apply(snapshot: &mut VehicleSnapshot, data: &AUTOPILOT_VERSION_DATA) {
    let v = data.flight_sw_version;
    snapshot.flight_sw_major = Some((v >> 24) as u8);
    snapshot.flight_sw_minor = Some((v >> 16) as u8);
    snapshot.flight_sw_patch = Some((v >> 8) as u8);
    snapshot.flight_sw_version_type = Some(v as u8);
    snapshot.board_version = Some(data.board_version);
    snapshot.board_vendor_id = Some(data.vendor_id);
    snapshot.board_product_id = Some(data.product_id);
    // A board that doesn't build its git hash into the firmware reports all
    // zero bytes here — `None` rather than showing "00000000".
    snapshot.flight_custom_version = (!data.flight_custom_version.iter().all(|&b| b == 0))
        .then(|| data.flight_custom_version.iter().map(|b| format!("{b:02x}")).collect());

    // `uid2` supersedes `uid` per the spec ("if this is non-zero, use this
    // field, otherwise use uid") — most current ArduPilot boards populate
    // it with the full 96-bit STM32 chip ID; `uid` is the older 64-bit
    // field kept for boards/firmware that never adopted `uid2`.
    snapshot.board_uid = if data.uid2.iter().any(|&b| b != 0) {
        Some(data.uid2.iter().map(|b| format!("{b:02x}")).collect())
    } else if data.uid != 0 {
        Some(format!("{:016x}", data.uid))
    } else {
        None
    };
}
