//! Tauri commands for ArduPilot firmware flashing — the orchestration around
//! `bootloader.rs`'s protocol: fetching ArduPilot's board/version catalog,
//! downloading a chosen `.apj`, and running the flash on a background thread
//! with progress reported through events (blocking serial I/O, so this takes
//! `link::connect_link`'s thread-plus-events shape, not the tokio-async one).

use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use flate2::read::GzDecoder;
use mavlink::dialects::ardupilotmega::{COMMAND_LONG_DATA, MavCmd, MavMessage};
use mavlink::MavHeader;
use serde::{Deserialize, Serialize};
use serialport::SerialPortType;
use tauri::{AppHandle, Emitter, State};

use super::bootloader::{self, ApjFirmware, UploadStage};

const MANIFEST_URL: &str = "https://firmware.ardupilot.org/manifest.json.gz";
const BOOTLOADER_BAUD: u32 = 115_200;
const READ_TIMEOUT: Duration = Duration::from_secs(2);
const FIND_BOOTLOADER_TIMEOUT: Duration = Duration::from_secs(20);
/// Pause after asking a board to reboot, before scanning again — the sum of the
/// two sleeps `uploader.py` uses here (0.25s after sending, 0.3s after closing
/// the port), which its comments attribute to serial I/O errors.
const REBOOT_SETTLE: Duration = Duration::from_millis(550);
/// Read timeout while *scanning* for a bootloader — deliberately short: a board
/// holds in its bootloader only a few seconds, and every silent port costs one
/// of these. The handle that finds it is promoted to `READ_TIMEOUT` to flash.
const PROBE_TIMEOUT: Duration = Duration::from_millis(300);

#[derive(Deserialize)]
struct ManifestEntry {
    vehicletype: String,
    platform: String,
    format: String,
    url: String,
    /// `"Copter"` vs `"HELICOPTER"` vs `"FIXED_WING"` — the only field separating
    /// a board's multirotor build from its heli one: both share the same
    /// `platform`, version, and `board_id`, so without it they're
    /// indistinguishable in the picker and to `upload`'s board-ID check.
    #[serde(rename = "mav-type")]
    mav_type: String,
    #[serde(rename = "mav-firmware-version-type")]
    version_type: String,
    #[serde(rename = "mav-firmware-version-str")]
    version_str: String,
    /// USB vendor/product IDs the board enumerates as (`["0x3162/0x0053", ...]`).
    /// Absent from the `hex`/`elf`/`abin` rows, so it must default or the whole
    /// parse fails.
    #[serde(rename = "USBID", default)]
    usbid: Vec<String>,
    /// The same number `upload` checks against the bootloader's `INFO_BOARD_ID`.
    /// Only present on `.apj` rows, so it must default.
    #[serde(default)]
    board_id: Option<u32>,
    #[serde(default)]
    latest: i32,
    #[serde(default)]
    manufacturer: Option<String>,
    #[serde(default)]
    brand_name: Option<String>,
}

#[derive(Deserialize)]
struct Manifest {
    firmware: Vec<ManifestEntry>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FirmwareOption {
    pub platform: String,
    pub version: String,
    pub version_type: String,
    /// Passed straight through so the picker can label the frame class —
    /// see `ManifestEntry::mav_type` for why leaving it out is dangerous.
    pub mav_type: String,
    pub usbid: Vec<String>,
    pub board_id: Option<u32>,
    pub url: String,
    pub manufacturer: Option<String>,
    pub brand_name: Option<String>,
}

/// OFFICIAL before DEV, so each board's recommended build is the row above
/// its bleeding-edge one rather than below it (plain alphabetical order puts
/// "DEV" first).
fn version_type_rank(version_type: &str) -> u8 {
    if version_type == "OFFICIAL" {
        0
    } else {
        1
    }
}

/// Fetches ArduPilot's published board/version catalog
/// (<https://firmware.ardupilot.org/manifest.json.gz>, ~90k entries across every
/// vehicle type, format, and version) and narrows it to `.apj` builds for
/// `vehicletype` that are each board's recommended (`"OFFICIAL"`) or
/// bleeding-edge (`latest == 1`) build — the full history is too much for a picker.
#[tauri::command]
pub async fn flash_fetch_manifest(vehicletype: String) -> Result<Vec<FirmwareOption>, String> {
    let compressed = reqwest::get(MANIFEST_URL)
        .await
        .map_err(|e| format!("could not reach firmware.ardupilot.org: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("could not download the firmware manifest: {e}"))?;

    let mut json = String::new();
    GzDecoder::new(&compressed[..])
        .read_to_string(&mut json)
        .map_err(|e| format!("could not decompress the firmware manifest: {e}"))?;

    let manifest: Manifest =
        serde_json::from_str(&json).map_err(|e| format!("could not parse the firmware manifest: {e}"))?;

    Ok(narrow_manifest(manifest, &vehicletype))
}

/// Split out from the download so the filtering and ordering — the part
/// that decides what an operator is offered — is testable without hitting
/// the network.
fn narrow_manifest(manifest: Manifest, vehicletype: &str) -> Vec<FirmwareOption> {
    let mut options: Vec<FirmwareOption> = manifest
        .firmware
        .into_iter()
        .filter(|e| {
            e.format == "apj" && e.vehicletype == vehicletype && (e.latest == 1 || e.version_type == "OFFICIAL")
        })
        .map(|e| FirmwareOption {
            platform: e.platform,
            version: e.version_str,
            version_type: e.version_type,
            mav_type: e.mav_type,
            usbid: e.usbid,
            board_id: e.board_id,
            url: e.url,
            manufacturer: e.manufacturer,
            brand_name: e.brand_name,
        })
        .collect();

    options.sort_by(|a, b| {
        a.platform
            .cmp(&b.platform)
            .then(version_type_rank(&a.version_type).cmp(&version_type_rank(&b.version_type)))
            .then(a.mav_type.cmp(&b.mav_type))
    });
    options
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ApjSummary {
    pub board_id: u32,
    pub board_revision: u32,
    pub image_size: u64,
}

struct PreparedFirmware {
    url: String,
    firmware: ApjFirmware,
}

/// Holds the most recently downloaded `.apj` between `flash_prepare` and
/// `flash_start`, server-side — images run to a few MB and the frontend only
/// needs `ApjSummary`.
#[derive(Default)]
pub struct FlashState {
    /// Tagged with its source URL so `flash_start` can refuse to flash an image
    /// the operator wasn't looking at — overlapping `flash_prepare` calls can
    /// finish out of order.
    prepared: Mutex<Option<PreparedFirmware>>,
    /// Set for the whole lifetime of a flash thread. Two interleaved
    /// `PROG_MULTI` streams on one port is the worst thing this module can do,
    /// and the frontend's flashing state resets when the page unmounts, so the
    /// interlock lives here, not in React.
    busy: Arc<AtomicBool>,
}

/// Downloads and parses one `.apj`, returning just the `ApjSummary` needed to
/// confirm with the operator before anything touches a serial port.
#[tauri::command]
pub async fn flash_prepare(url: String, state: State<'_, FlashState>) -> Result<ApjSummary, String> {
    let bytes = reqwest::get(&url)
        .await
        .map_err(|e| format!("could not reach {url}: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("could not download firmware: {e}"))?;

    let fw = ApjFirmware::parse(&bytes).map_err(|e| e.to_string())?;
    let summary = ApjSummary { board_id: fw.board_id, board_revision: fw.board_revision, image_size: fw.image_size };

    *state.prepared.lock().unwrap_or_else(|e| e.into_inner()) =
        Some(PreparedFirmware { url: url.clone(), firmware: fw });
    Ok(summary)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "stage")]
pub enum FlashProgress {
    WaitingForBootloader,
    Identify,
    Erase,
    Program { done: usize, total: usize },
    Verify,
    Reboot,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlashResult {
    pub ok: bool,
    pub message: Option<String>,
}

fn stage_event(stage: UploadStage, done: usize, total: usize) -> FlashProgress {
    match stage {
        UploadStage::Identify => FlashProgress::Identify,
        UploadStage::Erase => FlashProgress::Erase,
        UploadStage::Program => FlashProgress::Program { done, total },
        UploadStage::Verify => FlashProgress::Verify,
        UploadStage::Reboot => FlashProgress::Reboot,
    }
}

/// Releases the busy interlock however the flash thread ends, and guarantees the
/// frontend sees a terminal `flash-result` even if the thread unwinds — a UI
/// stuck on "Erasing flash…" with no result is worse than a reported error.
struct FlashGuard {
    app: AppHandle,
    busy: Arc<AtomicBool>,
    reported: bool,
}

impl Drop for FlashGuard {
    fn drop(&mut self) {
        self.busy.store(false, Ordering::SeqCst);
        if !self.reported {
            let _ = self.app.emit(
                "flash-result",
                FlashResult { ok: false, message: Some("the flash aborted unexpectedly".to_string()) },
            );
        }
    }
}

#[tauri::command]
pub fn flash_start(
    app: AppHandle,
    port: String,
    url: String,
    force: bool,
    state: State<FlashState>,
) -> Result<(), String> {
    let fw = {
        let prepared = state.prepared.lock().unwrap_or_else(|e| e.into_inner());
        let prepared = prepared.as_ref().ok_or_else(|| "no firmware has been prepared yet".to_string())?;
        // The frontend names the build it just showed a confirmation for.
        // If that isn't what's actually loaded, a `flash_prepare` for a
        // different board landed in between — refuse rather than erase the
        // board and write whatever happens to be in hand.
        if prepared.url != url {
            return Err(
                "the prepared firmware doesn't match the one selected — re-select the build and try again".to_string()
            );
        }
        prepared.firmware.clone()
    };

    // `compare_exchange`, not a load-then-store: two clicks landing together
    // must not both see "not busy" and spawn.
    let busy = Arc::clone(&state.busy);
    if busy.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Err("a flash is already in progress on this machine".to_string());
    }

    std::thread::spawn(move || {
        let mut guard = FlashGuard { app: app.clone(), busy, reported: false };

        let (ok, message) = match run_flash(&app, &port, &fw, force) {
            Ok(()) => (true, None),
            Err(e) => (false, Some(e)),
        };

        guard.reported = true;
        let _ = app.emit("flash-result", FlashResult { ok, message });
    });

    Ok(())
}

/// Every USB serial port currently on the machine. Bluetooth and other
/// non-USB serial ports are excluded — opening those can block for seconds
/// and a flight controller is never behind one.
fn usb_ports() -> Vec<serialport::SerialPortInfo> {
    serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .filter(|p| matches!(p.port_type, SerialPortType::UsbPort(_)))
        .collect()
}

/// Every port on the same physical USB device as `port_name`. A flight
/// controller exposes several CDC interfaces (a Pixhawk 6C shows two COM ports),
/// only one of which speaks MAVLink — matching on vendor/product/serial aims the
/// reboot at that board rather than every board plugged in.
fn same_device_ports(port_name: &str) -> Vec<String> {
    let ports = usb_ports();
    let identity = ports.iter().find(|p| p.port_name == port_name).and_then(|p| match &p.port_type {
        SerialPortType::UsbPort(info) => Some((info.vid, info.pid, info.serial_number.clone())),
        _ => None,
    });

    match identity {
        Some(target) => ports
            .iter()
            .filter(|p| match &p.port_type {
                SerialPortType::UsbPort(info) => {
                    (info.vid, info.pid, info.serial_number.clone()) == target
                }
                _ => false,
            })
            .map(|p| p.port_name.clone())
            .collect(),
        // Not a USB port we can identify (or it's already gone) — fall back
        // to just the one we were given.
        None => vec![port_name.to_string()],
    }
}

/// Asks a *running* board to reboot into its bootloader (`COMMAND_LONG` /
/// `PREFLIGHT_REBOOT_SHUTDOWN`, `param1 = 3`) written straight to the port.
/// Deliberately not via `link`/`vehicle_command`, which need an established
/// MAVLink connection — the whole point is to reach a board nothing is connected
/// to (as `uploader.py`'s pre-baked reboot packets do). Sent as both MAVLink v1
/// and v2, to (system 1, component 1) and (0, 0), since we have no heartbeat to
/// learn the board's real IDs; every failure is ignored.
fn request_reboot_to_bootloader(port_name: &str) {
    let header = MavHeader { system_id: 255, component_id: 0, sequence: 0 };

    for name in same_device_ports(port_name) {
        let Ok(mut port) = serialport::new(&name, BOOTLOADER_BAUD).timeout(PROBE_TIMEOUT).open() else {
            continue;
        };
        for (target_system, target_component) in [(1u8, 1u8), (0, 0)] {
            let message = MavMessage::COMMAND_LONG(COMMAND_LONG_DATA {
                // param1 = 3: reboot and hold in the bootloader. Same
                // encoding as `VehicleCommand::RebootToBootloader`.
                param1: 3.0,
                param2: 0.0,
                param3: 0.0,
                param4: 0.0,
                param5: 0.0,
                param6: 0.0,
                param7: 0.0,
                command: MavCmd::MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN,
                target_system,
                target_component,
                confirmation: 0,
            });
            let _ = mavlink::write_v2_msg(&mut port, header, &message);
            let _ = mavlink::write_v1_msg(&mut port, header, &message);
        }

        // NSH console fallback, as `uploader.py`'s `send_reboot` does after its
        // MAVLink attempt: three carriage returns to wake a prompt, `reboot -b`
        // (to bootloader), then plain `reboot` for firmware without `-b`.
        let _ = std::io::Write::write_all(&mut port, b"\r\r\r");
        let _ = std::io::Write::write_all(&mut port, b"reboot -b\n");
        let _ = std::io::Write::write_all(&mut port, b"\r\r\r");
        let _ = std::io::Write::write_all(&mut port, b"reboot\n");

        let _ = std::io::Write::flush(&mut port);
    }
}

/// Finds a board in bootloader mode and returns a transport ready to flash it,
/// with the port it was found on. Scans *every* USB port, not just `preferred`:
/// a board in bootloader mode is a different USB device (different product ID,
/// usually a different COM port) from the same board running firmware, so the
/// operator's selected port can never find it.
fn connect_to_bootloader(
    preferred: &str,
    deadline: Instant,
) -> Result<(bootloader::SerialTransport, String), String> {
    let mut last_error: Option<String> = None;

    while Instant::now() < deadline {
        // Probe before rebooting, as `uploader.py`'s `find_bootloader` does:
        // identify first, ask for a reboot only if nothing answered (a board
        // already in its bootloader must not get MAVLink/NSH noise). `preferred`
        // leads so a hand-placed board gets the fast path.
        let mut candidates = vec![preferred.to_string()];
        candidates.extend(usb_ports().into_iter().map(|p| p.port_name).filter(|n| n != preferred));

        for name in candidates {
            let Ok(raw) = serialport::new(&name, BOOTLOADER_BAUD).timeout(PROBE_TIMEOUT).open() else {
                continue;
            };
            let mut transport = bootloader::SerialTransport::new(raw);

            // A past deadline means exactly one identify attempt — a probe,
            // not a wait.
            match bootloader::wait_for_bootloader(&mut transport, Instant::now()) {
                Ok(_) => {
                    transport
                        .set_timeout(READ_TIMEOUT)
                        .map_err(|e| format!("found a bootloader on {name} but could not configure it: {e}"))?;
                    return Ok((transport, name));
                }
                Err(e) => last_error = Some(e.to_string()),
            }
        }

        if Instant::now() >= deadline {
            break;
        }

        // Nothing answered, so the board is presumably still running firmware —
        // reboot it, then let it settle. `uploader.py` sleeps 0.25s after sending
        // and 0.3s after closing the port (naming the serial I/O errors that
        // appear without them); kept here as one pause.
        request_reboot_to_bootloader(preferred);
        std::thread::sleep(REBOOT_SETTLE);
    }

    let secs = FIND_BOOTLOADER_TIMEOUT.as_secs();
    Err(match last_error {
        Some(e) => format!(
            "no bootloader found on any USB port within {secs}s (last: {e}). \
             If the board is running, check it's the right port; otherwise unplug and replug it and try again."
        ),
        None => format!("no USB serial ports were available to scan within {secs}s"),
    })
}

fn run_flash(app: &AppHandle, port: &str, fw: &ApjFirmware, force: bool) -> Result<(), String> {
    let _ = app.emit("flash-progress", FlashProgress::WaitingForBootloader);

    let (mut transport, _found_on) = connect_to_bootloader(port, Instant::now() + FIND_BOOTLOADER_TIMEOUT)?;

    // A ~1.6 MB image is ~6,500 PROG_MULTI chunks; emitting a Tauri event per
    // chunk would mean ~6,500 JSON serializations and React renders during the
    // phase already holding the serial port flat out, so only whole-percent
    // changes (and the final chunk) cross the IPC boundary.
    let mut last_percent: Option<usize> = None;

    bootloader::upload(&mut transport, fw, force, |stage, done, total| {
        if stage == UploadStage::Program {
            let percent = done * 100 / total.max(1);
            if last_percent == Some(percent) && done != total {
                return;
            }
            last_percent = Some(percent);
        }
        let _ = app.emit("flash-progress", stage_event(stage, done, total));
    })
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Four real rows from `manifest.json.gz`, trimmed to the fields this
    /// module reads. The first two are the trap: ArduPilot publishes a
    /// multirotor and a traditional-helicopter build for every Copter board
    /// under the *same* `platform`, the *same* version string, and the same
    /// `board_id` — `mav-type` is the only thing separating them.
    const SAMPLE_MANIFEST: &str = r#"{
      "firmware": [
        {"vehicletype": "Copter", "platform": "CubeOrange", "format": "apj",
         "mav-type": "HELICOPTER", "mav-firmware-version-type": "OFFICIAL",
         "mav-firmware-version-str": "V4.7.0", "latest": 0,
         "url": "https://firmware.ardupilot.org/Copter/stable/CubeOrange-heli/arducopter-heli.apj"},
        {"vehicletype": "Copter", "platform": "CubeOrange", "format": "apj",
         "mav-type": "Copter", "mav-firmware-version-type": "OFFICIAL",
         "mav-firmware-version-str": "V4.7.0", "latest": 0,
         "url": "https://firmware.ardupilot.org/Copter/stable/CubeOrange/arducopter.apj"},
        {"vehicletype": "Copter", "platform": "CubeOrange", "format": "apj",
         "mav-type": "Copter", "mav-firmware-version-type": "DEV",
         "mav-firmware-version-str": "V4.8.0-dev", "latest": 1,
         "url": "https://firmware.ardupilot.org/Copter/latest/CubeOrange/arducopter.apj"},
        {"vehicletype": "Plane", "platform": "CubeOrange", "format": "apj",
         "mav-type": "FIXED_WING", "mav-firmware-version-type": "OFFICIAL",
         "mav-firmware-version-str": "V4.7.0", "latest": 0, "board_id": 140,
         "USBID": ["0x2DAE/0x1016"],
         "url": "https://firmware.ardupilot.org/Plane/stable/CubeOrange/arduplane.apj"}
      ]
    }"#;

    fn narrow(vehicletype: &str) -> Vec<FirmwareOption> {
        let manifest: Manifest = serde_json::from_str(SAMPLE_MANIFEST).expect("fixture should parse");
        narrow_manifest(manifest, vehicletype)
    }

    /// Without `mav_type` reaching the frontend these two rows render
    /// identically, and `upload`'s board-ID check can't tell them apart
    /// either (both builds carry the same `board_id`) — so picking the wrong
    /// one flashes helicopter firmware onto a multirotor with nothing
    /// downstream objecting.
    #[test]
    fn copter_rows_carry_the_frame_class_that_distinguishes_them() {
        let options = narrow("Copter");

        let same_looking: Vec<&FirmwareOption> =
            options.iter().filter(|o| o.platform == "CubeOrange" && o.version == "V4.7.0").collect();
        assert_eq!(same_looking.len(), 2, "the fixture's two V4.7.0 builds should both survive filtering");
        assert_ne!(
            same_looking[0].mav_type, same_looking[1].mav_type,
            "two builds identical in platform, version and version type must differ in frame class"
        );
        assert!(same_looking.iter().any(|o| o.mav_type == "HELICOPTER"));
        assert!(same_looking.iter().any(|o| o.mav_type == "Copter"));
    }

    /// Every row the picker shows has to be uniquely identifiable from what
    /// is actually rendered — platform, version, version type, frame class.
    #[test]
    fn no_two_rows_are_indistinguishable_on_screen() {
        for vehicletype in ["Copter", "Plane"] {
            let options = narrow(vehicletype);
            let mut shown: Vec<(String, String, String, String)> = options
                .iter()
                .map(|o| (o.platform.clone(), o.version.clone(), o.version_type.clone(), o.mav_type.clone()))
                .collect();
            let total = shown.len();
            shown.sort();
            shown.dedup();
            assert_eq!(shown.len(), total, "{vehicletype} has rows that render identically");
        }
    }

    #[test]
    fn recommended_builds_sort_above_bleeding_edge_ones() {
        let options = narrow("Copter");
        let cube: Vec<&str> = options
            .iter()
            .filter(|o| o.platform == "CubeOrange")
            .map(|o| o.version_type.as_str())
            .collect();
        assert_eq!(cube, ["OFFICIAL", "OFFICIAL", "DEV"], "OFFICIAL should lead, not sort alphabetically after DEV");
    }

    /// `USBID` and `board_id` are what let the picker narrow ~300 boards to
    /// the one plugged in, and they're absent from the `hex`/`elf` rows in
    /// the same array — so they must default rather than fail the parse, and
    /// must survive the mapping into `FirmwareOption`.
    #[test]
    fn usb_ids_and_board_id_reach_the_frontend() {
        let plane = narrow("Plane");
        assert_eq!(plane.len(), 1);
        assert_eq!(plane[0].board_id, Some(140));
        // Passed through verbatim, uppercase and all — the frontend
        // lowercases both sides when comparing, because the manifest mixes
        // cases across vendors.
        assert_eq!(plane[0].usbid, vec!["0x2DAE/0x1016".to_string()]);

        // The Copter fixture rows carry neither field; they must still parse
        // and simply arrive empty.
        let copter = narrow("Copter");
        assert!(!copter.is_empty());
        assert!(copter.iter().all(|o| o.usbid.is_empty() && o.board_id.is_none()));
    }

    #[test]
    fn other_vehicle_types_are_filtered_out() {
        let plane = narrow("Plane");
        assert_eq!(plane.len(), 1);
        assert_eq!(plane[0].mav_type, "FIXED_WING");
    }
}
