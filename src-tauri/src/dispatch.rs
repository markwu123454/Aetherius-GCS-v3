use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

use mavlink::{dialects::ardupilotmega::{MavMessage, STATUSTEXT_DATA}};
use num_traits::ToPrimitive;
use tauri::{AppHandle, Emitter, Manager};

use crate::{commands, mission, params, scripting, telemetry, telemetry::VehicleSnapshot};

/// How long a full-length STATUSTEXT chunk waits for a continuation before
/// being shown standalone. ArduPilot sends split chunks back-to-back with no
/// meaningful gap, so this only ever fires for a chunk that really was
/// complete and simply happened to measure exactly 50 bytes — a rare false
/// positive on the length heuristic below, worth a bounded display delay
/// rather than losing the "same severity → probably a continuation" signal
/// entirely.
const STATUSTEXT_CHUNK_TIMEOUT: Duration = Duration::from_millis(250);

struct PendingStatustext {
    severity: u8,
    text: String,
    since: Instant,
}

/// This crate's `STATUSTEXT_DATA` has no `id`/`chunk_seq` fields — the
/// MAVLink2 extension that would let a receiver reassemble a message
/// ArduPilot split across multiple STATUSTEXT sends because it didn't fit the
/// 50-byte field. `pending` is the fallback: a chunk that fills the full
/// field is held here until either a same-severity chunk continues it or the
/// timeout above elapses.
#[derive(Default)]
pub struct DispatchState {
    pending_statustext: Mutex<Option<PendingStatustext>>,
}

/// Every inbound message type is routed here, and only here — read this top
/// to bottom and you know exactly what happens to each MAVLink message.
pub fn route(app: &AppHandle, snapshot: &mut VehicleSnapshot, message: &MavMessage) {
    flush_stale_statustext(app);
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
        MavMessage::FILE_TRANSFER_PROTOCOL(data) => {
            scripting::on_ftp_reply(app, data);
            true
        }
        _ => false,
    };
}

/// STATUSTEXT carries the vehicle's own log lines. `text` is a fixed 50-byte
/// field terminated by NUL when shorter, and `to_str` handles that — it stops
/// at the first NUL and returns an error rather than panicking on malformed
/// UTF-8, which a noisy link can produce.
///
/// A chunk that fills the full 50 bytes (no NUL, so `to_str` returns exactly
/// 50 characters) may be the first part of a longer message ArduPilot had to
/// split — see `DispatchState`. Concatenation happens on the untrimmed text,
/// since the split can land mid-word or mid-space and trimming each half
/// separately would eat whatever whitespace the join actually needs; the
/// combined message is only trimmed once, right before it's shown.
fn on_statustext(app: &AppHandle, data: &STATUSTEXT_DATA) {
    let Ok(raw) = data.text.to_str() else {
        return;
    };
    let full = raw.len() == 50;
    let severity = data.severity.to_u8().unwrap_or(6);

    let state = app.state::<DispatchState>();
    let mut pending = state.pending_statustext.lock().unwrap_or_else(|e| e.into_inner());

    let text = match pending.take() {
        Some(previous) if previous.severity == severity => previous.text + raw,
        Some(previous) => {
            // A different severity arrived mid-assembly: the held chunk was
            // never continued, so show it on its own before starting fresh.
            emit_statustext(app, previous.severity, &previous.text);
            raw.to_string()
        }
        None => raw.to_string(),
    };

    if full {
        *pending = Some(PendingStatustext { severity, text, since: Instant::now() });
    } else {
        emit_statustext(app, severity, &text);
    }
}

/// Flushes a held chunk that never got its continuation — called on every
/// inbound message, not just STATUSTEXT, so a chunk left pending after the
/// vehicle goes quiet still surfaces on the next heartbeat or telemetry
/// packet rather than being lost.
fn flush_stale_statustext(app: &AppHandle) {
    let state = app.state::<DispatchState>();
    let mut pending = state.pending_statustext.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(previous) = pending.as_ref() {
        if previous.since.elapsed() > STATUSTEXT_CHUNK_TIMEOUT {
            emit_statustext(app, previous.severity, &previous.text);
            *pending = None;
        }
    }
}

fn emit_statustext(app: &AppHandle, severity: u8, text: &str) {
    let text = text.trim();
    if text.is_empty() {
        return;
    }
    let _ = app.emit(
        "statustext",
        // MAV_SEVERITY is repr(u32) but only ever 0-7. Falling back to 6
        // (INFO) rather than dropping the line: a message with an
        // unreadable severity is still worth showing.
        serde_json::json!({"severity": severity, "text": text}),
    );
}
