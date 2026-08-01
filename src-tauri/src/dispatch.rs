use mavlink::{dialects::ardupilotmega::{MavMessage, STATUSTEXT_DATA}};
use num_traits::ToPrimitive;
use tauri::{AppHandle, Emitter};

use crate::{commands, mission, params, telemetry, telemetry::VehicleSnapshot};

/// Every inbound message type is routed here, and only here — read this top
/// to bottom and you know exactly what happens to each MAVLink message.
pub fn route(app: &AppHandle, snapshot: &mut VehicleSnapshot, message: &MavMessage) {
    match message {
        MavMessage::HEARTBEAT(_)
        | MavMessage::SYS_STATUS(_)
        | MavMessage::GPS_RAW_INT(_)
        | MavMessage::GLOBAL_POSITION_INT(_)
        | MavMessage::RADIO_STATUS(_)
        | MavMessage::EKF_STATUS_REPORT(_)
        | MavMessage::VIBRATION(_)
        | MavMessage::BATTERY_STATUS(_)
        | MavMessage::ATTITUDE(_)
        | MavMessage::VFR_HUD(_)
        => {
            telemetry::apply(snapshot, message);
            true
        }
        MavMessage::COMMAND_ACK(data) => {
            commands::on_ack(app, data);
            true
        }
        MavMessage::PARAM_VALUE(data) => {
            params::on_value(app, data);
            true
        }
        MavMessage::STATUSTEXT(data) => {
            on_statustext(app, data);
            true
        }
        MavMessage::MISSION_REQUEST_INT(data) => {
            mission::on_request_int(app, data);
            true
        }
        MavMessage::MISSION_REQUEST(data) => {
            mission::on_request(app, data);
            true
        }
        MavMessage::MISSION_ACK(data) => {
            mission::on_ack(app, data);
            true
        }
        _ => false,
    };
}

/// STATUSTEXT carries the vehicle's own log lines. `text` is a fixed 50-byte
/// field terminated by NUL when shorter, and `to_str` handles that — it stops
/// at the first NUL and returns an error rather than panicking on malformed
/// UTF-8, which a noisy link can produce.
fn on_statustext(app: &AppHandle, data: &STATUSTEXT_DATA) {
    let Ok(text) = data.text.to_str() else {
        return;
    };
    let text = text.trim();
    if text.is_empty() {
        return;
    }

    let _ = app.emit(
        "statustext",
        serde_json::json!({
            // MAV_SEVERITY is repr(u32) but only ever 0-7. Falling back to 6
            // (INFO) rather than dropping the line: a message with an
            // unreadable severity is still worth showing.
            "severity": data.severity.to_u8().unwrap_or(6),
            "text": text,
        }),
    );
}
