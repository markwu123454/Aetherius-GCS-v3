use serde::{Deserialize, Serialize};

use mavlink::{
    error::MessageReadError,
    dialects::ardupilotmega::{MavCmd, MavMessage},
    MavConnection,
};

use std::{
    collections::HashMap,
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
    // does or doesn't export: ATTITUDE, GLOBAL_POSITION_INT, VFR_HUD,
    // RC_CHANNELS.
    for message_id in [30.0, 33.0, 74.0, 65.0] {
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

/// `rename_all` is deliberately `serialize`-only: the frontend wants
/// camelCase, but `usb_boards.json` spells these variants exactly as they're
/// written here, so renaming the *deserialize* side too would make every row
/// of that file fail to parse — and because `usb_boards()` parses lazily
/// inside `scan_links`, that failure surfaces as a non-unwinding panic in a
/// WebView2 callback (a hard abort, not an error dialog) rather than at
/// startup. `SiKRadio` gets an explicit wire name because serde's camelCase
/// rule only lowercases the first character (`siKRadio`), which isn't what
/// `UsbBoardClass` in `connection.ts` declares.
#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all(serialize = "camelCase"))]
pub enum UsbBoardClass {
    Pixhawk,
    #[serde(rename(serialize = "sikRadio"))]
    SiKRadio,
    RtkGps,
    OpenPilot,
}

#[derive(Deserialize)]
struct UsbBoard {
    vendor_id: u16,
    product_id: u16,
    class: UsbBoardClass,
    name: String,
}

/// Parsed once from `usb_boards.json` (embedded into the binary at compile
/// time via `include_str!`, not read from disk at runtime) and cached —
/// `scan_links` runs on a few-second timer while the connect dropdown is
/// open, so re-parsing on every call would be wasted work. A malformed file
/// is a build-time mistake, not something that can happen in the field, so
/// panicking on it here rather than silently returning no boards is the
/// right failure mode.
fn usb_boards() -> &'static [UsbBoard] {
    static BOARDS: std::sync::OnceLock<Vec<UsbBoard>> = std::sync::OnceLock::new();
    BOARDS.get_or_init(|| {
        serde_json::from_str(include_str!("usb_boards.json")).expect("usb_boards.json is malformed")
    })
}

/// `product_id: 0` in the table is a vendor-only wildcard (matches any
/// product from that vendor) — used for vendors that only ship flight
/// controllers, e.g. CubePilot.
fn identify_usb_board(vendor_id: u16, product_id: u16) -> Option<&'static UsbBoard> {
    usb_boards()
        .iter()
        .find(|board| board.vendor_id == vendor_id && (board.product_id == product_id || board.product_id == 0))
}

fn board_baud(class: UsbBoardClass) -> u32 {
    match class {
        UsbBoardClass::SiKRadio => 57_600,
        _ => 115_200,
    }
}

/// `label` is what the UI shows, `address` is the exact string that would be
/// passed to `connect_link` if this entry is picked — kept separate so a
/// recognized board can show a friendly name *and* the literal connect
/// string it resolves to, rather than hiding one behind the other.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedLink {
    pub label: String,
    pub address: String,
    /// `None` for non-USB entries (SITL) — a recognized USB board always
    /// has a class, used by the firmware-flashing port picker to filter
    /// out radios/GPS units that obviously aren't a flight controller.
    pub class: Option<UsbBoardClass>,
    /// USB vendor and product ID, `None` for non-USB entries. ArduPilot's
    /// firmware manifest lists a `USBID` per build, so these are what let
    /// the firmware picker narrow ~300 boards down to the one plugged in —
    /// the same thing QGroundControl does.
    pub vid: Option<u16>,
    pub pid: Option<u16>,
    /// The bare serial port name (e.g. `COM5`), independent of `address`'s
    /// `serial:<port>:<baud>` MAVLink connection string — flashing opens
    /// the port directly at the bootloader's own baud rate, not whatever
    /// baud this board talks MAVLink at.
    pub port_name: Option<String>,
}

/// Collapses a board's several USB CDC interfaces down to the one worth
/// connecting to.
///
/// An ArduPilot flight controller enumerates as more than one serial port
/// from a single physical board — a Pixhawk 6C appears as interface 0 and
/// interface 2, two COM ports with the same vendor, product and serial
/// number. Interface 0 is the one carrying MAVLink; the other is the
/// secondary port (SLCAN on boards that have it) and never answers a
/// heartbeat. Offering both makes the operator pick between two names for
/// one board, half of which silently fail to connect.
///
/// Only deduplicated when the board reports a serial number. Without one,
/// two identical boards are indistinguishable from one board's two
/// interfaces, and silently hiding a second real board is worse than
/// listing one board twice.
fn primary_interface_only(ports: Vec<serialport::SerialPortInfo>) -> Vec<serialport::SerialPortInfo> {
    // key -> (lowest interface seen, index of the port that had it)
    let mut best: HashMap<(u16, u16, String), (u8, usize)> = HashMap::new();
    let mut keep = vec![true; ports.len()];

    for (index, port) in ports.iter().enumerate() {
        let serialport::SerialPortType::UsbPort(usb) = &port.port_type else {
            continue;
        };
        let Some(serial) = usb.serial_number.clone() else {
            continue;
        };
        // A port with no interface number sorts last, so a known interface
        // is always preferred over an unknown one.
        let interface = usb.interface.unwrap_or(u8::MAX);
        let key = (usb.vid, usb.pid, serial);

        match best.get(&key).copied() {
            Some((best_interface, _)) if best_interface <= interface => keep[index] = false,
            Some((_, previous_index)) => {
                keep[previous_index] = false;
                best.insert(key, (interface, index));
            }
            None => {
                best.insert(key, (interface, index));
            }
        }
    }

    ports.into_iter().zip(keep).filter_map(|(port, keep)| keep.then_some(port)).collect()
}

#[tauri::command]
pub fn scan_links() -> Vec<ScannedLink> {
    let mut found = Vec::new();

    if let Ok(ports) = serialport::available_ports().map(primary_interface_only) {
        for port in ports {
            let usb = match &port.port_type {
                serialport::SerialPortType::UsbPort(usb) => Some(usb),
                _ => None,
            };
            let matched = usb.and_then(|usb| identify_usb_board(usb.vid, usb.pid));
            if let Some(board) = matched {
                let address = format!("serial:{}:{}", port.port_name, board_baud(board.class));
                found.push(ScannedLink {
                    label: board.name.clone(),
                    address,
                    class: Some(board.class),
                    vid: usb.map(|u| u.vid),
                    pid: usb.map(|u| u.pid),
                    port_name: Some(port.port_name.clone()),
                });
            }
        }
    }

    let sitl: SocketAddr = "127.0.0.1:5760".parse().unwrap();
    if TcpStream::connect_timeout(&sitl, SCAN_PROBE_TIMEOUT).is_ok() {
        found.push(ScannedLink {
            label: "SITL".to_string(),
            address: "tcp:127.0.0.1:5760".to_string(),
            class: None,
            vid: None,
            pid: None,
            port_name: None,
        });
    }

    found
}

#[tauri::command]
pub fn connect_link(endpoint: String, app: AppHandle, state: State<LinkState>) -> Result<(), String> {
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    state.last_heartbeat_ms.store(0, Ordering::SeqCst);
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

#[cfg(test)]
mod tests {
    use super::*;

    /// `usb_boards.json` is `include_str!`'d and parsed lazily on the first
    /// `scan_links`, so a mismatch between the file and the types here isn't
    /// a compile error — it's a runtime abort in front of the operator. This
    /// forces the same `OnceLock` the app does, turning that into an
    /// ordinary test failure.
    #[test]
    fn usb_boards_json_matches_the_types_it_deserializes_into() {
        let boards = usb_boards();
        assert!(!boards.is_empty(), "the board table should not be empty");
        assert!(
            boards.iter().any(|b| b.class == UsbBoardClass::Pixhawk),
            "the board table should contain at least one flashable flight controller"
        );
    }

    /// Checks the shape `scan_links` hands the frontend. Note this only
    /// reaches the board table if the machine running the tests actually has
    /// a serial port — `identify_usb_board` is what forces it — so it can't
    /// stand in for `usb_boards_json_matches_the_types_it_deserializes_into`
    /// above, which forces the parse unconditionally. Asserts on shape
    /// rather than contents, since what's plugged in varies.
    #[test]
    fn scan_links_serializes_for_the_frontend_without_panicking() {
        let json = serde_json::to_value(scan_links()).expect("scanned links should serialize");
        for link in json.as_array().expect("an array") {
            assert!(link.get("label").is_some_and(|v| v.is_string()));
            assert!(link.get("address").is_some_and(|v| v.is_string()));
            // camelCase, not `port_name` — `FirmwarePage` reads `portName`.
            assert!(link.get("portName").is_some());
            assert!(link.get("class").is_some());
        }
    }

    fn usb_port(name: &str, vid: u16, pid: u16, interface: Option<u8>, serial: Option<&str>) -> serialport::SerialPortInfo {
        serialport::SerialPortInfo {
            port_name: name.to_string(),
            port_type: serialport::SerialPortType::UsbPort(serialport::UsbPortInfo {
                vid,
                pid,
                serial_number: serial.map(str::to_string),
                manufacturer: None,
                product: None,
                interface,
            }),
        }
    }

    fn names(ports: Vec<serialport::SerialPortInfo>) -> Vec<String> {
        ports.into_iter().map(|p| p.port_name).collect()
    }

    /// Exactly what a Pixhawk 6C reports over USB: one board, one serial
    /// number, two COM ports on interfaces 0 and 2. Only interface 0 speaks
    /// MAVLink, so listing both offers a choice where one option can only
    /// fail.
    #[test]
    fn a_boards_second_usb_interface_is_not_offered_as_a_second_board() {
        let ports = vec![
            usb_port("COM12", 0x3162, 0x0053, Some(2), Some("350048001451333531333639")),
            usb_port("COM11", 0x3162, 0x0053, Some(0), Some("350048001451333531333639")),
        ];
        assert_eq!(names(primary_interface_only(ports)), ["COM11"]);
    }

    /// Order must not decide the winner — the lowest interface wins whether
    /// it was enumerated first or second.
    #[test]
    fn the_lowest_interface_wins_regardless_of_enumeration_order() {
        let low_first = vec![
            usb_port("COM11", 0x3162, 0x0053, Some(0), Some("A")),
            usb_port("COM12", 0x3162, 0x0053, Some(2), Some("A")),
        ];
        assert_eq!(names(primary_interface_only(low_first)), ["COM11"]);
    }

    /// Two of the same board are two boards. They differ only by serial
    /// number, and dropping one would hide hardware the operator has
    /// plugged in.
    #[test]
    fn two_identical_boards_both_survive() {
        let ports = vec![
            usb_port("COM11", 0x3162, 0x0053, Some(0), Some("BOARD-A")),
            usb_port("COM12", 0x3162, 0x0053, Some(2), Some("BOARD-A")),
            usb_port("COM21", 0x3162, 0x0053, Some(0), Some("BOARD-B")),
            usb_port("COM22", 0x3162, 0x0053, Some(2), Some("BOARD-B")),
        ];
        assert_eq!(names(primary_interface_only(ports)), ["COM11", "COM21"]);
    }

    /// With no serial number there is no way to tell one board's two
    /// interfaces from two boards. Listing a board twice is recoverable;
    /// hiding a real one is not.
    #[test]
    fn ports_without_a_serial_number_are_left_alone() {
        let ports = vec![
            usb_port("COM3", 0x1209, 0x5741, Some(0), None),
            usb_port("COM4", 0x1209, 0x5741, Some(2), None),
        ];
        assert_eq!(names(primary_interface_only(ports)), ["COM3", "COM4"]);
    }

    /// The frontend's `UsbBoardClass` union in `connection.ts` is matched
    /// against by string (`link.class === "pixhawk"` in the flashing port
    /// picker), so these wire names are load-bearing, not cosmetic.
    #[test]
    fn usb_board_class_serializes_to_the_names_the_frontend_declares() {
        let names: Vec<String> = [
            UsbBoardClass::Pixhawk,
            UsbBoardClass::SiKRadio,
            UsbBoardClass::RtkGps,
            UsbBoardClass::OpenPilot,
        ]
        .iter()
        .map(|c| serde_json::to_string(c).unwrap())
        .collect();
        assert_eq!(names, [r#""pixhawk""#, r#""sikRadio""#, r#""rtkGps""#, r#""openPilot""#]);
    }
}