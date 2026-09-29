use serde::{Deserialize, Serialize};

use mavlink::{
    error::MessageReadError,
    dialects::ardupilotmega::{HEARTBEAT_DATA, MavAutopilot, MavCmd, MavMessage, MavResult, MavType},
    MavConnection,
};

use std::{
    collections::HashMap,
    io::ErrorKind,
    net::{SocketAddr, TcpStream, ToSocketAddrs},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use tauri::{AppHandle, Emitter, Manager, State};

use tauri_plugin_store::StoreExt;

use crate::dispatch;
use crate::telemetry::VehicleSnapshot;
use crate::commands::{self, AckOrSilence, CommandError};
use crate::params;

const LOSING_AFTER: Duration = Duration::from_millis(2_500);
const SCAN_PROBE_TIMEOUT: Duration = Duration::from_millis(250);
/// How long `open_connection` will wait for a TCP peer to answer. The OS's
/// own limit is the alternative, and on Windows that's ~21 seconds of SYN
/// retries — long enough that an operator who mistyped an address assumes
/// the app has hung.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkStatus {
    Disconnected,
    Connecting,
    Connected,
    Losing,
    Lost,
    Rebooting,
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
///
/// SERVO_OUTPUT_RAW is asked for explicitly too, at a fixed 10 Hz: whether a
/// port streams it unprompted depends on that port's `SRx_RC_CHAN` rate, which
/// SITL's TCP port has set but a serial telemetry port usually doesn't — the
/// Servo Outputs panel would otherwise sit empty on real hardware. 10 Hz is
/// plenty for a bar display and cheap on a 57600 radio link.
fn request_data_streams(app: &AppHandle, target_system: u8, target_component: u8, interval_us: f32) {
    const SERVO_OUTPUT_RAW_INTERVAL_US: f32 = 100_000.0;

    for (message_id, interval) in [
        (30.0, interval_us),
        (33.0, interval_us),
        (74.0, interval_us),
        (65.0, interval_us),
        (36.0, SERVO_OUTPUT_RAW_INTERVAL_US),
    ] {
        let _ = commands::send_async(
            app,
            MavCmd::MAV_CMD_SET_MESSAGE_INTERVAL,
            [message_id, interval, 0.0, 0.0, 0.0, 0.0, 0.0],
            (target_system, target_component),
        );
    }
}

/// ArduPilot doesn't push AUTOPILOT_VERSION on its own — it has to be asked
/// for, same as the streams above. Sent once, right after the first
/// HEARTBEAT; the reply is routed through `telemetry::apply` like any other
/// message and lands in the same `vehicle` event the frontend already reads.
fn request_autopilot_version(app: &AppHandle, target_system: u8, target_component: u8) {
    let _ = commands::send_async(
        app,
        MavCmd::MAV_CMD_REQUEST_MESSAGE,
        // param1: message id. AUTOPILOT_VERSION = 148.
        [148.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        (target_system, target_component),
    );
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
    /// The endpoint the current link was opened to — what a reboot
    /// reconnects to. Kept here rather than asked of the frontend, because
    /// any page can ask for a reboot, not just the one that connected.
    pub endpoint: Mutex<Option<String>>,
    /// Set while `reboot_reconnect_loop` owns the link. A transport dying in
    /// that window is the reboot happening, not a lost link, so `read_loop`
    /// leaves the status alone and the loop reconnects.
    pub reconnecting: AtomicBool,
}

/// Opens the transport for `endpoint`, bounding the part of it the OS would
/// otherwise stretch to its own limit.
///
/// `mavlink`'s `tcpout` is a bare `TcpStream::connect` with no timeout, so an
/// address that nothing answers blocks for the whole SYN-retry budget. Probing
/// first with an explicit deadline — the same thing `scan_links` does for SITL
/// — bounds that, which is also what bounds how long a cancelled attempt's
/// thread can linger before it notices the epoch moved on.
///
/// Every resolved address is tried, not just the first, the same way
/// `TcpStream::connect` itself does: on Windows `localhost` resolves to `::1`
/// ahead of `127.0.0.1`, and SITL only listens on IPv4, so probing the first
/// address alone would refuse a host that `tcpout` would have reached fine.
fn open_connection(endpoint: &str) -> Result<Arc<dyn MavConnection<MavMessage> + Send + Sync>, String> {
    if let Some(rest) = endpoint.strip_prefix("tcp:") {
        let addresses: Vec<SocketAddr> = rest
            .to_socket_addrs()
            .map_err(|error| format!("{rest} is not a valid host:port: {error}"))?
            .collect();
        if addresses.is_empty() {
            return Err(format!("{rest} did not resolve to any address"));
        }

        let mut last_error = None;
        let reached = addresses.iter().any(|address| match TcpStream::connect_timeout(address, CONNECT_TIMEOUT) {
            Ok(_) => true,
            Err(error) => {
                last_error = Some(error);
                false
            }
        });
        if !reached {
            let error = last_error.map(|e| e.to_string()).unwrap_or_default();
            return Err(format!("could not reach {rest}: {error}"));
        }
    }

    let address = to_mavlink_address(endpoint);
    mavlink::connect::<MavMessage>(&address)
        .map(|connection| Arc::new(connection) as Arc<dyn MavConnection<MavMessage> + Send + Sync>)
        .map_err(|error| format!("could not open {address}: {error}"))
}

/// Puts everything an epoch owns back to "no vehicle": the transport, the
/// target, the telemetry snapshot, heartbeat liveness and the parameter cache.
/// Every lifecycle transition goes through here rather than clearing its own
/// subset, because a field one path forgets is a field that survives into the
/// next vehicle — a stale `target` in particular makes `read_loop` treat every
/// heartbeat of the next vehicle as foreign.
///
/// `only_if_generation` is the epoch the caller believes it still owns. The
/// lifecycle commands pass `None`: they are themselves what defines the next
/// epoch, so they always win. A background thread passes its own lease, so a
/// teardown racing a fresh `connect_link` can't wipe the link that replaced
/// it. Returns whether the reset actually happened.
fn reset_link_state(app: &AppHandle, only_if_generation: Option<u64>) -> bool {
    let state = app.state::<LinkState>();

    // Locked in the order `read_loop` takes them — snapshot, then target, then
    // connection — because it can hold the snapshot while its prearm-edge
    // branch reaches for the target and then, inside `send_async`, for the
    // connection. Any other order here is a deadlock against that path.
    let reset = {
        let mut snapshot = state.snapshot.lock().unwrap_or_else(|e| e.into_inner());
        let mut target = state.target.lock().unwrap_or_else(|e| e.into_inner());
        let mut connection = state.connection.lock().unwrap_or_else(|e| e.into_inner());

        match only_if_generation {
            Some(generation) if state.generation.load(Ordering::SeqCst) != generation => false,
            _ => {
                *snapshot = VehicleSnapshot::default();
                *target = None;
                *connection = None;
                state.last_heartbeat_ms.store(0, Ordering::SeqCst);
                true
            }
        }
    };

    // Outside the locks above: `params` has its own, and there is no reason to
    // hold four at once.
    if reset {
        params::clear(app);
    }
    reset
}

/// Makes `connection` the live link for `generation` and starts the three
/// threads that serve it, each holding that generation as its lease.
///
/// Returns false if the epoch moved on while the caller was opening the
/// transport — that's a cancel taking effect, and dropping `connection` on the
/// way out is what closes the socket nobody asked for any more.
fn install_link(app: &AppHandle, connection: Arc<dyn MavConnection<MavMessage> + Send + Sync>, generation: u64) -> bool {
    let state = app.state::<LinkState>();

    {
        // Checked under the same lock `reset_link_state` clears under, so a
        // disconnect that lands during the blocking open can't be overwritten
        // by the very attempt it cancelled.
        let mut slot = state.connection.lock().unwrap_or_else(|e| e.into_inner());
        if state.generation.load(Ordering::SeqCst) != generation {
            return false;
        }
        *slot = Some(connection.clone());
        state.last_heartbeat_ms.store(0, Ordering::SeqCst);
    }

    let store = app.store("settings.json").ok();
    let settings = store.as_ref().and_then(|s| s.get("settings"));

    let prearm_interval_secs = settings
        .as_ref()
        .and_then(|s| s.get("prearmCheckInterval"))
        .and_then(|v| v.as_u64())
        .unwrap_or(3)
        .max(1);

    let telem_rate_hz = settings
        .as_ref()
        .and_then(|s| s.get("telemRateHz"))
        .and_then(|v| v.as_u64())
        .unwrap_or(20)
        .clamp(1, 20) as u32;

    let telem_interval_us = 1_000_000.0 / telem_rate_hz as f32;
    let prearm_interval = Duration::from_secs(prearm_interval_secs);

    let handle = app.clone();
    std::thread::spawn(move || read_loop(handle, connection, generation, telem_interval_us));

    let watchdog_handle = app.clone();
    std::thread::spawn(move || watchdog_loop(watchdog_handle, generation));

    let prearm_handle = app.clone();
    std::thread::spawn(move || prearm_check_loop(prearm_handle, generation, prearm_interval));

    true
}

/// True only for the aircraft's own HEARTBEAT, not one from another GCS,
/// companion computer or peripheral sharing the link.
///
/// `sim_vehicle.py` starts a MAVProxy that holds SITL's SERIAL0, and
/// ArduPilot's MAVLink router forwards that MAVProxy's broadcast heartbeat
/// (sys 255, comp 230, `MAV_TYPE_GCS`) back out of the other serial ports. So
/// a GCS connected to 5762 receives two heartbeats carrying two different
/// source IDs, only one of which is the vehicle. The forwarding only starts
/// once this end transmits, which is why a passive listener on the same port
/// never sees the second one.
///
/// `MAV_AUTOPILOT_INVALID` is the spec's own marker for "this component is not
/// a flight controller", and every non-autopilot is required to send it — so
/// this catches gimbals and companion computers too, not just the MAVProxy
/// that prompted it.
fn is_vehicle_heartbeat(data: &HEARTBEAT_DATA) -> bool {
    data.autopilot != MavAutopilot::MAV_AUTOPILOT_INVALID && data.mavtype != MavType::MAV_TYPE_GCS
}

/// Read messages until asked to stop. Emission is throttled because SITL sends
/// roughly fifty messages a second and the UI cannot use that rate — it would
/// just be re-rendering faster than a human can read.
fn read_loop(
    app: AppHandle,
    connection: Arc<dyn MavConnection<MavMessage> + Send + Sync>,
    generation: u64,
    telem_interval_us: f32,
) {
    let mut last_emit = Instant::now();
    let mut last_heartbeat: Option<Instant> = None;
    // Tracks the previous `prearm_pass` value so we can detect the passing →
    // failing edge and fire an immediate check without waiting for the periodic
    // poll loop. Initialised to `None` (unknown) so the very first `false`
    // reading after connecting doesn't incorrectly fire a check — only a
    // confirmed transition from `true` triggers one.
    let mut last_prearm_pass: Option<bool> = None;

    loop {
        if app.state::<LinkState>().generation.load(Ordering::SeqCst) != generation {
            return;
        }

        match connection.recv() {
            Ok((header, message)) => {
                let state = app.state::<LinkState>();

                // A heartbeat from anything that isn't our vehicle is dropped
                // before it can touch the target, the snapshot or link liveness
                // — see `is_vehicle_heartbeat`. Once a vehicle is locked in, a
                // heartbeat carrying any other source ID is ignored for the rest
                // of the link's life, so a second autopilot appearing on a
                // shared link can't take over the session mid-flight.
                //
                // Everything that isn't a heartbeat still routes as before;
                // `set_status` at the bottom of the loop is deliberately left
                // outside this guard so a link carrying nothing but foreign
                // heartbeats still ages into `Losing`.
                let foreign_heartbeat = match &message {
                    MavMessage::HEARTBEAT(data) => {
                        let id = (header.system_id, header.component_id);
                        let locked = *state.target.lock().unwrap_or_else(|e| e.into_inner());
                        !is_vehicle_heartbeat(data) || locked.is_some_and(|target| target != id)
                    }
                    _ => false,
                };

                if !foreign_heartbeat {
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
                            request_data_streams(&app, header.system_id, header.component_id, telem_interval_us);
                            request_autopilot_version(&app, header.system_id, header.component_id);
                        }
                    }

                    let mut snapshot = state.snapshot.lock().unwrap_or_else(|e| e.into_inner());
                    dispatch::route(&app, &mut snapshot, &message);
                    snapshot.since_heartbeat_ms = last_heartbeat.map(|at| at.elapsed().as_millis() as u64);

                    let current_prearm_pass = snapshot.prearm_pass;

                    if last_emit.elapsed() >= Duration::from_millis(50) {
                        last_emit = Instant::now();
                        let payload = snapshot.clone();
                        drop(snapshot);
                        let _ = app.emit("vehicle", payload);

                        if let Some(batch) = params::drain_batch(&app) {
                            let _ = app.emit("param-values", batch);
                        }
                    }

                    // Fire an immediate prearm check on every passing → failing
                    // transition, regardless of where the periodic poll timer sits.
                    // This keeps the reasons list current whenever the vehicle
                    // starts oscillating between states — the periodic loop still
                    // runs its normal keep-alive rhythm in parallel.
                    if last_prearm_pass == Some(true) && current_prearm_pass == Some(false) {
                        if let Some(target) = *state.target.lock().unwrap_or_else(|e| e.into_inner()) {
                            let _ = commands::send_async(&app, MavCmd::MAV_CMD_RUN_PREARM_CHECKS, [0.0; 7], target);
                        }
                    }
                    last_prearm_pass = current_prearm_pass;
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

    // The transport is finished, so tear the epoch down rather than leaving a
    // dead connection installed: a send against it would otherwise look like
    // it succeeded, and `send_sync` would wait out its full timeout instead of
    // reporting `NotConnected`. Guarded by our own generation so a connect
    // that raced us keeps the link it just installed.
    if reset_link_state(&app, Some(generation)) && !app.state::<LinkState>().reconnecting.load(Ordering::SeqCst) {
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
fn prearm_check_loop(app: AppHandle, generation: u64, interval: Duration) {
    loop {
        std::thread::sleep(interval);

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
    /// Best-effort match for `vehicle_profile`'s per-board UID, derived from
    /// the USB serial number — see `chibios_uid_from_serial`. `None` when
    /// there's no serial number, or it doesn't look like one of these UIDs,
    /// which just means this particular board can't be recognized until it's
    /// actually connected once and reports its UID over MAVLink instead.
    pub candidate_uid: Option<String>,
}

/// Every current ArduPilot board runs ChibiOS on an STM32, and reports its
/// USB serial-number descriptor as the plain hex of the chip's 96-bit
/// (12-byte) unique ID register — the exact same bytes `AUTOPILOT_VERSION`'s
/// `uid2` field carries once connected, just zero-padded there to 18 bytes
/// (see `telemetry::autopilot_version::apply`). So the pre-connect UID is
/// derivable, not guessed: right-pad the USB serial to the same 18-byte hex
/// length and it's the identical string `board_uid` will be once the board
/// actually answers a heartbeat.
///
/// Returns `None` for anything that doesn't look like that — no serial
/// number, one longer than 12 bytes already, or containing non-hex
/// characters (some vendors put a human-readable string here instead). A
/// board that doesn't match still works the normal way: connect once,
/// and its real `board_uid` takes over as the identity from then on.
fn chibios_uid_from_serial(serial: &str) -> Option<String> {
    const UID2_HEX_LEN: usize = 36; // 18 bytes
    if serial.is_empty()
        || serial.len() > UID2_HEX_LEN
        || serial.len() % 2 != 0
        || !serial.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return None;
    }
    let mut uid = serial.to_ascii_lowercase();
    uid.push_str(&"0".repeat(UID2_HEX_LEN - uid.len()));
    Some(uid)
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

/// `async` only for where it runs, not for what it does: enumerating serial
/// ports and probing SITL both block, and this runs on a three-second timer
/// for as long as the app is disconnected. A plain `#[tauri::command]` would
/// do that on the main thread.
#[tauri::command(async)]
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
                    candidate_uid: usb
                        .and_then(|usb| usb.serial_number.as_deref())
                        .and_then(chibios_uid_from_serial),
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
            candidate_uid: None,
        });
    }

    found
}

/// Starts connecting. Returns as soon as the attempt is handed to a worker
/// thread, so the outcome arrives as events rather than as this call's return
/// value: `link-status` for the transition, and `link-error` carrying the
/// message when the transport can't be opened at all.
///
/// A `#[tauri::command]` that isn't `async` runs inline on the main thread, so
/// blocking here — which is what opening a transport does — wedges the IPC
/// queue: the Cancel button's own `disconnect_link` couldn't be dispatched
/// until the connect had already given up on its own.
#[tauri::command]
pub fn connect_link(endpoint: String, app: AppHandle, state: State<LinkState>) {
    // Ending the previous epoch has to happen here, in order, before anything
    // can observe a half-old link — only the blocking open goes to the worker.
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    reset_link_state(&app, None);
    *state.endpoint.lock().unwrap_or_else(|e| e.into_inner()) = Some(endpoint.clone());
    set_status(&app, LinkStatus::Connecting);

    let handle = app.clone();
    std::thread::spawn(move || {
        let connection = match open_connection(&endpoint) {
            Ok(connection) => connection,
            Err(error) => {
                if handle.state::<LinkState>().generation.load(Ordering::SeqCst) == generation {
                    let _ = handle.emit("link-error", error);
                    set_status(&handle, LinkStatus::Error);
                }
                return;
            }
        };

        // A false return is a cancel that landed while the open above blocked
        // — `install_link` drops the connection and nothing else is touched.
        install_link(&handle, connection, generation);
    });
}

#[tauri::command]
pub fn link_status(state: State<LinkState>) -> Option<LinkStatus> {
    *state.status.lock().unwrap_or_else(|e| e.into_inner())
}

/// Ends the current epoch. Bumping the generation before the reset is what
/// makes this instant even with a connect still in flight: the worker's
/// `install_link` sees the new generation and drops what it opened.
#[tauri::command]
pub fn disconnect_link(app: AppHandle, state: State<LinkState>) {
    set_status(&app, LinkStatus::Disconnecting);
    state.generation.fetch_add(1, Ordering::SeqCst);
    reset_link_state(&app, None);
    *state.endpoint.lock().unwrap_or_else(|e| e.into_inner()) = None;
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

    /// The exact serial number a real Pixhawk 6C reported over USB
    /// (VID:PID `0x3162:0x0053`), right-padded to `uid2`'s 18-byte length —
    /// this is the actual round trip a saved auto-connect profile depends
    /// on: `chibios_uid_from_serial`'s output has to equal what
    /// `telemetry::autopilot_version::apply` would derive from that same
    /// board's `AUTOPILOT_VERSION.uid2` once it's actually connected.
    #[test]
    fn derives_the_same_uid_a_real_pixhawk_6c_reports_over_mavlink() {
        assert_eq!(
            chibios_uid_from_serial("350048001451333531333639").as_deref(),
            Some("350048001451333531333639000000000000"),
        );
    }

    #[test]
    fn rejects_serials_that_dont_look_like_a_chip_uid() {
        assert_eq!(chibios_uid_from_serial(""), None); // empty
        assert_eq!(chibios_uid_from_serial("NOTHEX12345678901234567"), None); // non-hex
        assert_eq!(chibios_uid_from_serial("abc"), None); // odd length
        // Longer than the 18-byte uid2 field can hold.
        assert_eq!(chibios_uid_from_serial(&"ab".repeat(19)), None);
    }

    #[test]
    fn is_case_insensitive() {
        assert_eq!(
            chibios_uid_from_serial("350048001451333531333639"),
            chibios_uid_from_serial("350048001451333531333639".to_uppercase().as_str()),
        );
    }
}

/// How long a reboot has to bring the vehicle back before giving up.
const REBOOT_DEADLINE: Duration = Duration::from_secs(20);
/// ArduPilot's own override for its refuse-while-armed check on
/// `PREFLIGHT_REBOOT_SHUTDOWN` (param 6, `handle_preflight_reboot` in
/// GCS_Common.cpp). Only sent after the operator confirms rebooting armed.
const FORCE_REBOOT_MAGIC: f32 = 20190226.0;

/// Reopens the link after a reboot until the vehicle is heard from again.
///
/// Reboot is only done when a HEARTBEAT arrives, not when the port opens: a
/// port can open while the vehicle is still coming up and then drop again
/// (USB re-enumerating), and that has to mean "keep trying", not "lost". So
/// each opened link is watched until it either hears a heartbeat (done) or
/// dies (reopen), all inside one deadline. `reconnecting` stays set for the
/// whole loop so `read_loop` doesn't report those deaths as a lost link.
fn reboot_reconnect_loop(app: AppHandle, endpoint: String, mut generation: u64) {
    let deadline = Instant::now() + REBOOT_DEADLINE;
    let state = app.state::<LinkState>();

    let outcome = 'outer: loop {
        std::thread::sleep(Duration::from_secs(2));

        // A connect_link or disconnect_link call superseded us.
        if state.generation.load(Ordering::SeqCst) != generation {
            break None;
        }
        if Instant::now() >= deadline {
            break Some(LinkStatus::Lost);
        }

        // Bounded by `open_connection` rather than by the OS, so a board that
        // hasn't finished rebooting costs one attempt — not a stall that runs
        // past the deadline above and ignores a disconnect while it does.
        let Ok(connection) = open_connection(&endpoint) else {
            continue;
        };

        // Claiming the next epoch with a compare-exchange is what lets a
        // disconnect that landed during the open above win: if the generation
        // moved at all, this fails and the connection is dropped unused.
        if state
            .generation
            .compare_exchange(generation, generation + 1, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            break None;
        }
        generation += 1;
        if !install_link(&app, connection, generation) {
            break None;
        }

        // Watch this link until the vehicle speaks or the link dies.
        loop {
            std::thread::sleep(Duration::from_millis(250));
            if state.generation.load(Ordering::SeqCst) != generation {
                break 'outer None;
            }
            if state.last_heartbeat_ms.load(Ordering::SeqCst) != 0 {
                break 'outer None; // back: read_loop has already published Connected
            }
            let alive = state.connection.lock().unwrap_or_else(|e| e.into_inner()).is_some();
            if !alive {
                // The transport died before the vehicle was heard: still
                // coming up. Put the status back and reopen.
                set_status(&app, LinkStatus::Rebooting);
                continue 'outer;
            }
            if Instant::now() >= deadline {
                // Open but silent — leave it; read_loop keeps listening and
                // publishes Connected if the vehicle does turn up.
                break 'outer None;
            }
        }
    };

    state.reconnecting.store(false, Ordering::SeqCst);
    if let Some(status) = outcome {
        if state.generation.load(Ordering::SeqCst) == generation {
            set_status(&app, status);
        }
    }
}

/// Reboots the vehicle, then reconnects to it.
///
/// Waits for the vehicle to accept first: ArduPilot acks
/// `PREFLIGHT_REBOOT_SHUTDOWN` before restarting, and refuses it while armed
/// unless forced. Going to "rebooting" without that answer (as this used to)
/// meant a refused or lost command still showed a full reboot-and-reconnect
/// while the vehicle carried on unchanged. A vehicle that goes silent
/// without acking counts as rebooting — its ack was lost on the way out.
///
/// The endpoint comes from `LinkState`, not the caller: any page can ask for
/// a reboot, and only the one that connected ever knew the address.
///
/// `force` sends ArduPilot's armed override; the frontend only sets it after
/// the operator confirms rebooting an armed vehicle.
#[tauri::command]
pub async fn reboot_link(force: bool, app: AppHandle) -> Result<(), String> {
    let state = app.state::<LinkState>();
    let target = state
        .target
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .ok_or_else(|| "no vehicle has been heard from yet".to_string())?;
    let endpoint = state
        .endpoint
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or_else(|| "not connected".to_string())?;

    let params = [1.0, 0.0, 0.0, 0.0, 0.0, if force { FORCE_REBOOT_MAGIC } else { 0.0 }, 0.0];
    let outcome = commands::send_expecting_silence(
        &app,
        MavCmd::MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN,
        params,
        target,
        3,
        Duration::from_millis(1500),
    )
    .await;

    match outcome {
        Ok(AckOrSilence::Ack(MavResult::MAV_RESULT_ACCEPTED)) | Ok(AckOrSilence::Silent) => {}
        Ok(AckOrSilence::Ack(MavResult::MAV_RESULT_FAILED)) => {
            let armed = state.snapshot.lock().unwrap_or_else(|e| e.into_inner()).armed == Some(true);
            return Err(if armed {
                "The vehicle refused to reboot because it's armed.".to_string()
            } else {
                "The vehicle refused to reboot.".to_string()
            });
        }
        Ok(AckOrSilence::Ack(other)) => return Err(format!("The vehicle refused to reboot ({other:?}).")),
        Err(CommandError::Timeout) => {
            return Err("No answer from the vehicle, so it didn't reboot. Check the link and try again.".to_string())
        }
        Err(CommandError::NotConnected) => return Err("not connected".to_string()),
        Err(CommandError::LinkReset) => return Err("The link changed before the vehicle answered.".to_string()),
    }

    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    state.reconnecting.store(true, Ordering::SeqCst);
    reset_link_state(&app, None);
    set_status(&app, LinkStatus::Rebooting);

    let handle = app.clone();
    std::thread::spawn(move || reboot_reconnect_loop(handle, endpoint, generation));

    Ok(())
}