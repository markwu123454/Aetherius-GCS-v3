use serde::Serialize;

use mavlink::{
    error::MessageReadError,
    dialects::ardupilotmega::{
        MavMessage,
        MavModeFlag,
        MavSysStatusSensor,
    },
    MavConnection,
};

use std::{
    io::ErrorKind,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

use tauri::{AppHandle, Emitter, Manager, State};

const LOSING_AFTER: Duration = Duration::from_millis(2_500);

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkStatus {
    Disconnected,
    Connecting,
    Connected,
    Losing,
    Lost,
    Disconnecting,
    Error,
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
    pub hdop: Option<f32>,
    /// Milliseconds since the last heartbeat, so the UI can go stale on its own.
    pub since_heartbeat_ms: Option<u64>,
}

/// Translate our endpoint strings into the scheme the `mavlink` crate expects.
/// `tcpout` means "connect out to a listening peer", which is what SITL is.
fn to_mavlink_address(endpoint: &str) -> String {
    if let Some(rest) = endpoint.strip_prefix("tcp:") {
        format!("tcpout:{rest}")
    } else if let Some(rest) = endpoint.strip_prefix("udp:") {
        format!("udpin:{rest}")
    } else {
        endpoint.to_string()
    }
}

/// Fold one message into the snapshot. Only the messages the status strip
/// actually needs are handled; everything else is ignored rather than stored.
fn apply_message(snapshot: &mut VehicleSnapshot, message: &MavMessage) {
    match message {
        MavMessage::HEARTBEAT(data) => {
            snapshot.armed = Some(
                data.base_mode
                    .contains(MavModeFlag::MAV_MODE_FLAG_SAFETY_ARMED),
            );
            snapshot.custom_mode = Some(data.custom_mode);
        }
        MavMessage::SYS_STATUS(data) => {
            // Voltage arrives in millivolts, current in centiamps.
            snapshot.battery_voltage = Some(data.voltage_battery as f32 / 1000.0);
            snapshot.battery_current = Some(data.current_battery as f32 / 100.0);
            snapshot.battery_percent = Some(data.battery_remaining);
            snapshot.prearm_pass = Some(
                data.onboard_control_sensors_health
                    .contains(MavSysStatusSensor::MAV_SYS_STATUS_PREARM_CHECK),
            );
        }
        MavMessage::GPS_RAW_INT(data) => {
            snapshot.gps_fix = Some(data.fix_type as u8);
            snapshot.satellites = Some(data.satellites_visible);
            snapshot.hdop = Some(data.eph as f32 / 100.0);
        }
        _ => {}
    }
}

#[derive(Default)]
pub struct LinkState {
    pub snapshot: Mutex<VehicleSnapshot>,
    /// Bumped by every connect or disconnect request. Work that finishes
    /// holding a stale generation is discarded, which is what makes a cancel
    /// that races a successful connect still mean "I do not want this link".
    pub generation: AtomicU64,
    pub status: Mutex<Option<LinkStatus>>,
}

/// Read messages until asked to stop. Emission is throttled because SITL sends
/// roughly fifty messages a second and the UI cannot use that rate — it would
/// just be re-rendering faster than a human can read.
fn read_loop(app: AppHandle, connection: impl MavConnection<MavMessage> + Send, generation: u64) {
    let mut last_emit = Instant::now();
    let mut last_heartbeat: Option<Instant> = None;

    loop {
        // Any newer request supersedes this reader, and it exits without
        // touching the status — whoever superseded it already set one.
        if app.state::<LinkState>().generation.load(Ordering::SeqCst) != generation {
            return;
        }

        match connection.recv() {
            Ok((_header, message)) => {
                if matches!(message, MavMessage::HEARTBEAT(_)) {
                    last_heartbeat = Some(Instant::now());
                }

                let state = app.state::<LinkState>();
                let mut snapshot = state.snapshot.lock().unwrap_or_else(|e| e.into_inner());
                apply_message(&mut snapshot, &message);
                snapshot.since_heartbeat_ms = last_heartbeat.map(|at| at.elapsed().as_millis() as u64);

                if last_emit.elapsed() >= Duration::from_millis(100) {
                    last_emit = Instant::now();
                    let payload = snapshot.clone();
                    drop(snapshot);
                    let _ = app.emit("vehicle", payload);
                }
            }
            Err(MessageReadError::Parse(_)) => continue,
            Err(MessageReadError::Io(error)) => {
                if !matches!(error.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock) {
                    break;
                }
            }
        }

        // Reached on both a message and a read timeout, so the 100ms timeout
        // doubles as the clock for deciding the link has gone quiet.
        set_status(
            &app,
            match last_heartbeat {
                None => LinkStatus::Connecting,
                Some(at) if at.elapsed() > LOSING_AFTER => LinkStatus::Losing,
                Some(_) => LinkStatus::Connected,
            },
        );
    }

    // Fell out of the loop on a real I/O error rather than being superseded.
    if app.state::<LinkState>().generation.load(Ordering::SeqCst) == generation {
        set_status(&app, LinkStatus::Lost);
    }
}

fn set_status(app: &AppHandle, status: LinkStatus) {
    let state = app.state::<LinkState>();
    let mut current = state.status.lock().unwrap_or_else(|e| e.into_inner());

    // Emitting only on change keeps the frontend from re-rendering at the
    // reader loop's tick rate.
    if *current == Some(status) {
        return;
    }
    *current = Some(status);
    let _ = app.emit("link-status", status);
}

#[tauri::command]
pub fn connect_link(endpoint: String, app: AppHandle, state: State<LinkState>) -> Result<(), String> {
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    set_status(&app, LinkStatus::Connecting);

    let address = to_mavlink_address(&endpoint);
    let connection = match mavlink::connect::<MavMessage>(&address) {
        Ok(connection) => connection,
        Err(error) => {
            if state.generation.load(Ordering::SeqCst) == generation {
                set_status(&app, LinkStatus::Error);
            }
            return Err(format!("could not open {address}: {error}"));
        }
    };

    // The connect above blocks, and the user may have cancelled while it did.
    // Dropping the connection here is the cancel actually taking effect.
    if state.generation.load(Ordering::SeqCst) != generation {
        drop(connection);
        return Ok(());
    }

    let handle = app.clone();
    std::thread::spawn(move || read_loop(handle, connection, generation));
    Ok(())
}

#[tauri::command]
pub fn disconnect_link(app: AppHandle, state: State<LinkState>) {
    state.generation.fetch_add(1, Ordering::SeqCst);
    set_status(&app, LinkStatus::Disconnected);
}
