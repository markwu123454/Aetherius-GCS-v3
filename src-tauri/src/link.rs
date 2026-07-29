use serde::Serialize;

use mavlink::{error::MessageReadError, dialects::ardupilotmega::MavMessage, MavConnection};

use std::{
    io::ErrorKind,
    net::{SocketAddr, TcpStream},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

use tauri::{AppHandle, Emitter, Manager, State};

use crate::telemetry::{self, VehicleSnapshot};

const LOSING_AFTER: Duration = Duration::from_millis(2_500);
const SCAN_PROBE_TIMEOUT: Duration = Duration::from_millis(250);

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
                telemetry::apply(&mut snapshot, &message);
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

        // A message can arrive after we've already been superseded — recheck
        // right before publishing so a stale reader never overwrites the
        // status the newer request just set.
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
    set_status(&app, LinkStatus::Disconnecting);
    state.generation.fetch_add(1, Ordering::SeqCst);
    set_status(&app, LinkStatus::Disconnected);
}