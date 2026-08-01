use std::{collections::HashMap, sync::Mutex};

use mavlink::{dialects::ardupilotmega::{MavMessage, STATUSTEXT_DATA}, MavHeader, Message};
use num_traits::ToPrimitive;
use tauri::{AppHandle, Emitter, Manager};

use crate::{commands, mission, params, telemetry, telemetry::VehicleSnapshot};

/// Every inbound message type is routed here, and only here — read this top
/// to bottom and you know exactly what happens to each MAVLink message.
pub fn route(app: &AppHandle, snapshot: &mut VehicleSnapshot, message: &MavMessage) {
    let handled = match message {
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

    record_seen(app, message, handled);
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

/// Everything `route` does not handle. Emitted so the operator can see what the
/// vehicle sends that this app ignores — the frontend files these under `trace`,
/// which is off by default, and coalesces repeats by name.
fn on_unhandled(app: &AppHandle, header: &MavHeader, message: &MavMessage) {
    let _ = app.emit(
        "mavlink-unhandled",
        serde_json::json!({
            "name": message.message_name(),
            "system": header.system_id,
            "component": header.component_id,
        }),
    );
}

/// Running count of every MAVLink message seen since the last drain, keyed by
/// name and by whether `route` does anything with it.
///
/// A tally rather than an event per packet: the periodic streams run at ~50/s,
/// and the panel showing this is off by default. Counting costs a hash bump;
/// emitting would cost an IPC round trip per packet.
#[derive(Default)]
pub struct SeenState {
    counts: Mutex<HashMap<(&'static str, bool), u32>>,
}

fn record_seen(app: &AppHandle, message: &MavMessage, handled: bool) {
    let state = app.state::<SeenState>();
    let mut counts = state.counts.lock().unwrap_or_else(|e| e.into_inner());
    *counts.entry((message.message_name(), handled)).or_insert(0) += 1;
}

/// Takes the tally and clears it. `None` on a quiet tick so the caller can skip
/// the emit entirely, matching how `params::drain_batch` behaves.
pub fn drain_seen(app: &AppHandle) -> Option<serde_json::Value> {
    let state = app.state::<SeenState>();
    let mut counts = state.counts.lock().unwrap_or_else(|e| e.into_inner());
    if counts.is_empty() {
        return None;
    }

    let entries: Vec<_> = counts
        .drain()
        .map(|((name, handled), count)| {
            serde_json::json!({ "name": name, "count": count, "handled": handled })
        })
        .collect();

    Some(serde_json::json!({ "entries": entries }))
}