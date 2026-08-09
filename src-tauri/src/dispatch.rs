use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

use mavlink::dialects::ardupilotmega::{
    COMMAND_LONG_DATA, MAG_CAL_PROGRESS_DATA, MAG_CAL_REPORT_DATA, MavCmd, MavMessage,
    RC_CHANNELS_DATA, SERVO_OUTPUT_RAW_DATA, STATUSTEXT_DATA,
};
use num_traits::ToPrimitive;
use tauri::{AppHandle, Emitter, Manager};

use crate::{commands, fence, logs, mission, params, scripting, telemetry, telemetry::VehicleSnapshot};

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
        | MavMessage::AUTOPILOT_VERSION(_)
        | MavMessage::SYS_STATUS(_)
        | MavMessage::GPS_RAW_INT(_)
        | MavMessage::GLOBAL_POSITION_INT(_)
        | MavMessage::RADIO_STATUS(_)
        | MavMessage::EKF_STATUS_REPORT(_)
        | MavMessage::VIBRATION(_)
        | MavMessage::BATTERY_STATUS(_)
        | MavMessage::ATTITUDE(_)
        | MavMessage::VFR_HUD(_)
        | MavMessage::WIND(_)
        | MavMessage::NAV_CONTROLLER_OUTPUT(_)
        | MavMessage::POWER_STATUS(_)
        | MavMessage::MISSION_CURRENT(_)
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
            if !fence::try_on_mission_request_int(app, data) {
                mission::on_request_int(app, data);
            }
            true
        }
        MavMessage::MISSION_REQUEST(data) => {
            if !fence::try_on_mission_request(app, data) {
                mission::on_request(app, data);
            }
            true
        }
        MavMessage::MISSION_ACK(data) => {
            if !fence::try_on_mission_ack(app, data) {
                mission::on_ack(app, data);
            }
            true
        }
        MavMessage::MISSION_COUNT(data) => {
            if !fence::try_on_mission_count(app, data) {
                mission::on_count(app, data);
            }
            true
        }
        MavMessage::MISSION_ITEM_INT(data) => {
            if !fence::try_on_mission_item_int(app, data) {
                mission::on_item_int(app, data);
            }
            true
        }
        MavMessage::FILE_TRANSFER_PROTOCOL(data) => {
            scripting::on_ftp_reply(app, data);
            true
        }
        MavMessage::SERVO_OUTPUT_RAW(data) => {
            on_servo_output_raw(app, data);
            false
        }
        MavMessage::RC_CHANNELS(data) => {
            on_rc_channels(app, data);
            true
        }
        MavMessage::COMMAND_LONG(data) => {
            on_command_long(app, data);
            true
        }
        MavMessage::MAG_CAL_PROGRESS(data) => {
            on_mag_cal_progress(app, data);
            true
        }
        MavMessage::MAG_CAL_REPORT(data) => {
            on_mag_cal_report(app, data);
            true
        }
        MavMessage::LOG_ENTRY(data) => {
            logs::on_log_entry(app, data);
            true
        }
        MavMessage::LOG_DATA(data) => {
            logs::on_log_data(app, data);
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

/// port=0 → outputs 1-8, port=1 → outputs 9-16, etc. Channel index in the
/// frontend is `port * 8 + i + 1` (1-indexed).
fn on_servo_output_raw(app: &AppHandle, data: &SERVO_OUTPUT_RAW_DATA) {
    let channels = [
        data.servo1_raw, data.servo2_raw, data.servo3_raw, data.servo4_raw,
        data.servo5_raw, data.servo6_raw, data.servo7_raw, data.servo8_raw,
    ];
    let _ = app.emit("servo-outputs", serde_json::json!({
        "port": data.port,
        "channels": channels,
    }));
}

/// `chancount` can claim more channels than this message actually carries
/// (ArduPilot's own doc note: "can be larger than 18") — clamped so the
/// slice never reads past the 18 fields that exist.
fn on_rc_channels(app: &AppHandle, data: &RC_CHANNELS_DATA) {
    let raw = [
        data.chan1_raw, data.chan2_raw, data.chan3_raw, data.chan4_raw,
        data.chan5_raw, data.chan6_raw, data.chan7_raw, data.chan8_raw,
        data.chan9_raw, data.chan10_raw, data.chan11_raw, data.chan12_raw,
        data.chan13_raw, data.chan14_raw, data.chan15_raw, data.chan16_raw,
        data.chan17_raw, data.chan18_raw,
    ];
    let count = (data.chancount as usize).min(raw.len());
    let _ = app.emit("rc-channels", serde_json::json!({"channels": raw[..count].to_vec()}));
}

/// ArduPilot drives its own 6-position accelerometer calibration by pushing
/// `MAV_CMD_ACCELCAL_VEHICLE_POS` to the GCS as a `COMMAND_LONG` — the
/// vehicle is the sender here, the reverse of this message's usual
/// direction. `param1` is the `ACCELCAL_VEHICLE_POS` enum value (which
/// orientation to hold next, or the SUCCESS/FAILED sentinels), forwarded
/// as-is for the frontend to interpret.
fn on_command_long(app: &AppHandle, data: &COMMAND_LONG_DATA) {
    if data.command == MavCmd::MAV_CMD_ACCELCAL_VEHICLE_POS {
        let _ = app.emit("accel-cal-pos", serde_json::json!({"position": data.param1 as u32}));
    }
}

/// Streamed per compass while `MAV_CMD_DO_START_MAG_CAL` is running.
/// `completion_mask` is ArduPilot's own 80-section geodesic-grid coverage
/// bitmap (10 bytes, 8 sections each), forwarded as-is — the frontend
/// (`magCalGrid.ts`) knows how to turn it into sphere positions.
fn on_mag_cal_progress(app: &AppHandle, data: &MAG_CAL_PROGRESS_DATA) {
    let _ = app.emit(
        "mag-cal-progress",
        serde_json::json!({
            "compassId": data.compass_id,
            "calMask": data.cal_mask,
            "completionPct": data.completion_pct,
            "completionMask": data.completion_mask.to_vec(),
        }),
    );
}

/// Sent once per compass when `MAV_CMD_DO_START_MAG_CAL` finishes for it —
/// `fitness` is the real quality number (RMS milligauss residual from
/// ArduPilot's ellipsoid fit), the only calibration in this app that reports
/// one.
fn on_mag_cal_report(app: &AppHandle, data: &MAG_CAL_REPORT_DATA) {
    let _ = app.emit(
        "mag-cal-report",
        serde_json::json!({
            "compassId": data.compass_id,
            "calMask": data.cal_mask,
            "calStatus": data.cal_status.to_u32().unwrap_or(0),
            "fitness": data.fitness,
        }),
    );
}