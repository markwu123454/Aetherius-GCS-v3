use serde::Serialize;

use mavlink::{
    error::MessageReadError,
    dialects::ardupilotmega::{MavCmd, MavMessage},
    MavConnection,
};

use std::{
    io::ErrorKind,
    net::{SocketAddr, TcpStream},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use tauri::{AppHandle, Emitter, Manager, State};

use crate::dispatch;
use crate::telemetry::VehicleSnapshot;
use crate::commands;
use crate::params;

const LOSING_AFTER: Duration = Duration::from_millis(2_500);
const SCAN_PROBE_TIMEOUT: Duration = Duration::from_millis(250);
const PREARM_CHECK_INTERVAL: Duration = Duration::from_secs(3);

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

/// ArduPilot sends position/attitude/VFR_HUD at its own low idle rate until a
/// GCS asks for more. `REQUEST_DATA_STREAM` used to be the way to ask, but
/// it (and the stream-id enum it took) are deprecated in the MAVLink spec in
/// favor of `MAV_CMD_SET_MESSAGE_INTERVAL` — one COMMAND_LONG per message
/// type, naming the interval in microseconds. Sent once as soon as the
/// vehicle's target IDs are known from its first HEARTBEAT. Only the
/// messages that actually need to feel smooth are sped up — battery, GPS
/// status and the rest stay at their own default rate, since asking for
/// those at 20 Hz would just be discarded bandwidth.
fn request_data_streams(app: &AppHandle, target_system: u8, target_component: u8) {
    // Microseconds between messages — 20 Hz, matching read_loop's own emit
    // throttle below; no point asking the vehicle for faster than that will
    // ever actually be forwarded.
    const INTERVAL_US: f32 = 50_000.0;

    // Raw MAVLink message IDs, from common.xml — stable across dialects, so
    // these don't depend on whatever symbolic constants this crate version
    // does or doesn't export: ATTITUDE, GLOBAL_POSITION_INT, VFR_HUD.
    for message_id in [30.0, 33.0, 74.0] {
        let _ = commands::send_async(
            app,
            MavCmd::MAV_CMD_SET_MESSAGE_INTERVAL,
            [message_id, INTERVAL_US, 0.0, 0.0, 0.0, 0.0, 0.0],
            (target_system, target_component),
        );
    }
}

#[derive(Default)]
pub struct LinkState {
    pub snapshot: Mutex<VehicleSnapshot>,
    pub generation: AtomicU64,
    pub status: Mutex<Option<LinkStatus>>,
    pub connection: Mutex<Option<Arc<dyn MavConnection<MavMessage> + Send + Sync>>>,
    /// The vehicle's (system_id, component_id), learned from the first
    /// HEARTBEAT after connecting. `None` until then, and cleared on
    /// disconnect — commands have nobody to address until it's known again.
    pub target: Mutex<Option<(u8, u8)>>,
    /// Milliseconds since UNIX_EPOCH of the last HEARTBEAT, 0 until one arrives.
    /// Lets the watchdog judge staleness without needing `recv()` to have
    /// returned recently — a physically unplugged serial port can block
    /// that call forever.
    pub last_heartbeat_ms: AtomicU64,
}

/// Read messages until asked to stop. Emission is throttled because SITL sends
/// roughly fifty messages a second and the UI cannot use that rate — it would
/// just be re-rendering faster than a human can read.
fn read_loop(
    app: AppHandle,
    connection: Arc<dyn MavConnection<MavMessage> + Send + Sync>,
    generation: u64,
) {
    let mut last_emit = Instant::now();
    let mut last_heartbeat: Option<Instant> = None;

    loop {
        if app.state::<LinkState>().generation.load(Ordering::SeqCst) != generation {
            return;
        }

        match connection.recv() {
            Ok((header, message)) => {
                let state = app.state::<LinkState>();

                if matches!(message, MavMessage::HEARTBEAT(_)) {
                    let first_heartbeat = last_heartbeat.is_none();
                    last_heartbeat = Some(Instant::now());
                    state.last_heartbeat_ms.store(
                        SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0),
                        Ordering::SeqCst,
                    );
                    *state.target.lock().unwrap_or_else(|e| e.into_inner()) =
                        Some((header.system_id, header.component_id));

                    if first_heartbeat {
                        request_data_streams(&app, header.system_id, header.component_id);
                    }
                }

                let mut snapshot = state.snapshot.lock().unwrap_or_else(|e| e.into_inner());
                dispatch::route(&app, &mut snapshot, &message);
                snapshot.since_heartbeat_ms = last_heartbeat.map(|at| at.elapsed().as_millis() as u64);

                if last_emit.elapsed() >= Duration::from_millis(50) {
                    last_emit = Instant::now();
                    let payload = snapshot.clone();
                    drop(snapshot);
                    let _ = app.emit("vehicle", payload);

                    if let Some(batch) = params::drain_batch(&app) {
                        let _ = app.emit("param-values", batch);
                    }
                }
            }
            Err(MessageReadError::Parse(_)) => continue,
            Err(MessageReadError::Io(error)) => {
                if !matches!(error.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock) {
                    break;
                }
            }
        }

        if app.state::<LinkState>().generation.load(Ordering::SeqCst) != generation {
            return;
        }

        set_status(
            &app,
            match last_heartbeat {
                None => LinkStatus::Connecting,
                Some(at) if at.elapsed() > LOSING_AFTER => LinkStatus::Losing,
                Some(_) => LinkStatus::Connected,
            },
        );
    }

    if app.state::<LinkState>().generation.load(Ordering::SeqCst) == generation {
        set_status(&app, LinkStatus::Lost);
    }
}

fn watchdog_loop(app: AppHandle, generation: u64) {
    loop {
        std::thread::sleep(Duration::from_millis(500));

        let state = app.state::<LinkState>();
        if state.generation.load(Ordering::SeqCst) != generation {
            return;
        }

        let last_ms = state.last_heartbeat_ms.load(Ordering::SeqCst);
        if last_ms == 0 {
            continue;
        }

        let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        if Duration::from_millis(now_ms.saturating_sub(last_ms)) > LOSING_AFTER {
            set_status(&app, LinkStatus::Losing);
        }
    }
}

/// Periodically re-triggers ArduPilot's prearm checks so SYS_STATUS and any
/// `PreArm:` STATUSTEXT lines stay current without the operator doing anything.
/// Skipped while armed — ArduPilot's own docs say it returns
/// MAV_RESULT_TEMPORARILY_REJECTED in that case, so sending it then would just
/// be noise in the console.
fn prearm_check_loop(app: AppHandle, generation: u64) {
    loop {
        std::thread::sleep(PREARM_CHECK_INTERVAL);

        let state = app.state::<LinkState>();
        if state.generation.load(Ordering::SeqCst) != generation {
            return;
        }

        let Some(target) = *state.target.lock().unwrap_or_else(|e| e.into_inner()) else {
            continue;
        };

        let armed = state.snapshot.lock().unwrap_or_else(|e| e.into_inner()).armed;
        if armed == Some(true) {
            continue;
        }

        let _ = commands::send_async(&app, MavCmd::MAV_CMD_RUN_PREARM_CHECKS, [0.0; 7], target);
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
pub fn scan_links() -> Vec<String> {
    let mut found = Vec::new();

    if let Ok(ports) = serialport::available_ports() {
        found.extend(
            ports
                .into_iter()
                .map(|p| format!("serial:{}:115200", p.port_name)),
        );
    }

    let sitl: SocketAddr = "127.0.0.1:5760".parse().unwrap();
    if TcpStream::connect_timeout(&sitl, SCAN_PROBE_TIMEOUT).is_ok() {
        found.push("tcp:127.0.0.1:5760".to_string());
    }

    found
}

#[tauri::command]
pub fn connect_link(endpoint: String, app: AppHandle, state: State<LinkState>) -> Result<(), String> {
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    set_status(&app, LinkStatus::Connecting);

    let address = to_mavlink_address(&endpoint);
    let connection = match mavlink::connect::<MavMessage>(&address) {
        Ok(connection) => Arc::new(connection) as Arc<dyn MavConnection<MavMessage> + Send + Sync>,
        Err(error) => {
            if state.generation.load(Ordering::SeqCst) == generation {
                set_status(&app, LinkStatus::Error);
            }
            return Err(format!("could not open {address}: {error}"));
        }
    };

    // The connect above blocks, and the user may have canceled while it did.
    // Not storing or spawning here is the cancel actually taking effect.
    if state.generation.load(Ordering::SeqCst) != generation {
        return Ok(());
    }

    *state.connection.lock().unwrap_or_else(|e| e.into_inner()) = Some(connection.clone());

    let handle = app.clone();
    std::thread::spawn(move || read_loop(handle, connection, generation));

    let watchdog_handle = app.clone();
    std::thread::spawn(move || watchdog_loop(watchdog_handle, generation));

    let prearm_handle = app.clone();
    std::thread::spawn(move || prearm_check_loop(prearm_handle, generation));

    Ok(())
}

#[tauri::command]
pub fn link_status(state: State<LinkState>) -> Option<LinkStatus> {
    *state.status.lock().unwrap_or_else(|e| e.into_inner())
}

#[tauri::command]
pub fn disconnect_link(app: AppHandle, state: State<LinkState>) {
    set_status(&app, LinkStatus::Disconnecting);
    state.generation.fetch_add(1, Ordering::SeqCst);
    *state.connection.lock().unwrap_or_else(|e| e.into_inner()) = None;
    *state.target.lock().unwrap_or_else(|e| e.into_inner()) = None;
    state.last_heartbeat_ms.store(0, Ordering::SeqCst);
    params::clear(&app);
    set_status(&app, LinkStatus::Disconnected);
}