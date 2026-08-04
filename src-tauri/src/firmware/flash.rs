//! Tauri commands for ArduPilot firmware flashing — the orchestration
//! around `bootloader.rs`'s protocol implementation: fetching ArduPilot's
//! published board/version catalog, downloading a chosen `.apj`, and
//! running the flash on a background thread with progress reported through
//! events (mirrors `link::connect_link`'s shape, not `logs::download_log`'s,
//! since the actual serial I/O here is blocking rather than tokio-async).

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
/// Pause after asking a board to reboot, before scanning again — the sum of
/// the two sleeps `uploader.py` uses around the same step (0.25s after
/// sending, 0.3s after closing the port), both of which its comments
/// attribute to serial I/O errors that appear without them.
const REBOOT_SETTLE: Duration = Duration::from_millis(550);
/// Read timeout while *scanning* for a bootloader. Deliberately short: a
/// board that's been told to reboot holds in its bootloader for only a few
/// seconds before jumping to its application, and every silent port on the
/// machine costs one of these before the next is tried. The handle that
/// finds the bootloader is promoted to `READ_TIMEOUT` for the flash itself.
const PROBE_TIMEOUT: Duration = Duration::from_millis(300);

#[derive(Deserialize)]
struct ManifestEntry {
    vehicletype: String,
    platform: String,
    format: String,
    url: String,
    /// `"Copter"` vs `"HELICOPTER"` vs `"FIXED_WING"` — the *only* field
    /// separating a board's multirotor build from its traditional-helicopter
    /// one. Both are published under the same `platform` and the same
    /// version string, and both carry the same `board_id`, so without this
    /// they're indistinguishable in the picker *and* to `upload`'s
    /// board-ID check.
    #[serde(rename = "mav-type")]
    mav_type: String,
    #[serde(rename = "mav-firmware-version-type")]
    version_type: String,
    #[serde(rename = "mav-firmware-version-str")]
    version_str: String,
    /// USB vendor/product IDs this build's board enumerates as, as
    /// `["0x3162/0x0053", ...]`. Present on every `.apj` entry but absent
    /// from the `hex`/`elf`/`abin` rows in the same array, so it has to
    /// default — a non-defaulting field here fails the whole 91k-row parse.
    #[serde(rename = "USBID", default)]
    usbid: Vec<String>,
    /// Ground truth for "is this firmware for this board" — the same number
    /// `upload` checks against the bootloader's `INFO_BOARD_ID`. Also only
    /// present on `.apj` rows.
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

/// ArduPilot's own published board/version catalog
/// (<https://firmware.ardupilot.org/manifest.json.gz>) — around 90k entries
/// across every vehicle type, firmware format, and version ever released.
/// Narrowed to `.apj` builds for `vehicletype` (the manifest's own field —
/// `"Copter"`/`"Plane"`/etc, not this app's `VehicleKind`), and to each
/// board's current recommended build (`"OFFICIAL"`) or its bleeding-edge one
/// (`latest == 1`). The full version history behind that is tens of
/// thousands of rows per vehicle type — not something worth shipping to a
/// firmware picker; a "show older versions" mode would need a second,
/// separately-filtered command rather than sending everything up front.
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

/// One downloaded `.apj`, tagged with the URL it came from.
struct PreparedFirmware {
    url: String,
    firmware: ApjFirmware,
}

/// Holds the most recently downloaded `.apj` between `flash_prepare` and
/// `flash_start`. Kept server-side rather than round-tripped through the
/// frontend — firmware images run to a few MB, and the frontend only ever
/// needs `ApjSummary` to show a confirmation before flashing.
#[derive(Default)]
pub struct FlashState {
    /// Tagged with its source URL so `flash_start` can refuse to write an
    /// image the operator wasn't looking at. `flash_prepare` calls can
    /// overlap and finish out of order (clicking board A then board B while
    /// A is still downloading), which would otherwise leave A's firmware
    /// here under B's confirmation screen.
    prepared: Mutex<Option<PreparedFirmware>>,
    /// Set for the entire lifetime of a flash thread. A chip erase followed
    /// by two interleaved `PROG_MULTI` streams on one port is the worst
    /// outcome this module can produce, and the frontend's own "is it
    /// flashing" state resets whenever the Firmware page unmounts — so the
    /// interlock has to live here, not in React.
    busy: Arc<AtomicBool>,
}

/// Downloads one `.apj` file (a JSON header plus a compressed firmware
/// image, typically a few hundred KB to a few MB) and parses it, ready for
/// `flash_start`. Returns just enough to show the operator a confirmation —
/// board ID, revision, and size — before anything touches a serial port.
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

/// Flashes whatever `flash_prepare` most recently downloaded onto `port`
/// (a bare port name like `COM5`, from `ScannedLink::port_name` — not a
/// MAVLink `serial:PORT:BAUD` address, since flashing always talks the
/// bootloader's own baud rate regardless of what the board's flight
/// firmware uses for telemetry).
///
/// `port` must already be sitting in bootloader mode, or be about to (the
/// operator plugging it in right now, or having just triggered
/// `RebootToBootloader` on an already-connected vehicle and disconnected
/// that link) — this polls for up to `FIND_BOOTLOADER_TIMEOUT` before
/// giving up rather than trying to coax a running vehicle into rebooting
/// itself.
///
/// Runs on its own thread — the protocol in `bootloader.rs` is blocking
/// serial I/O, unlike the rest of this app's MAVLink-over-channels code —
/// and reports back purely through `flash-progress`/`flash-result` events,
/// the same "kick off a background thread, deliver status via events" shape
/// `connect_link` uses, rather than holding the calling `invoke()` open for
/// the whole flash.
/// Releases the busy interlock however the flash thread ends, and
/// guarantees the frontend sees a terminal `flash-result` even if the thread
/// unwinds — a UI stuck on "Erasing flash…" with no result and no way to
/// retry is the one failure mode worse than a reported error.
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

/// Every port belonging to the same physical USB device as `port_name`.
///
/// A flight controller typically exposes more than one CDC interface (a
/// Pixhawk 6C enumerates `MI_00` and `MI_02` as two COM ports), and only one
/// of them speaks MAVLink — which is usually *not* the one the operator
/// happened to pick. Matching on vendor/product/serial keeps the reboot
/// request aimed at that one board, rather than every board plugged in.
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

/// Asks a *running* board to reboot into its bootloader, by writing a
/// `COMMAND_LONG`/`PREFLIGHT_REBOOT_SHUTDOWN` with `param1 = 3` straight to
/// the serial port.
///
/// This is what makes flashing work on a board that isn't already in its
/// bootloader — the overwhelmingly common case, since a board only sits in
/// its bootloader for a few seconds after power-up. It deliberately does
/// *not* go through `link`/`vehicle_command`: those need an established
/// MAVLink connection, and the whole point here is to reach a board nothing
/// is connected to. ArduPilot's own `uploader.py` does the same thing, with
/// pre-baked reboot packets.
///
/// Sent as both MAVLink v1 and v2, to both the usual target
/// (system 1, component 1) and the broadcast-ish (0, 0), because we have no
/// heartbeat to learn the board's real IDs from. Every failure is ignored:
/// the board may already be in its bootloader, in which case there's nothing
/// to reboot and nothing listening.
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

        // Then the NSH console fallback, exactly as `uploader.py`'s
        // `send_reboot` does after its MAVLink attempt: three carriage
        // returns to wake a console prompt, then `reboot -b` (reboot to
        // bootloader), then a plain `reboot` for firmware that doesn't
        // understand `-b`.
        let _ = std::io::Write::write_all(&mut port, b"\r\r\r");
        let _ = std::io::Write::write_all(&mut port, b"reboot -b\n");
        let _ = std::io::Write::write_all(&mut port, b"\r\r\r");
        let _ = std::io::Write::write_all(&mut port, b"reboot\n");

        let _ = std::io::Write::flush(&mut port);
    }
}

/// Finds a board in bootloader mode and returns a transport ready to flash
/// it, along with the port it was found on.
///
/// Scans *every* USB port rather than only `preferred`, because a board in
/// bootloader mode is a different USB device from the same board running its
/// firmware — different product ID, so typically a different COM port
/// entirely. Targeting the port the operator selected (which is by
/// definition the *application's* port) can never find it.
fn connect_to_bootloader(
    preferred: &str,
    deadline: Instant,
) -> Result<(bootloader::SerialTransport, String), String> {
    let mut last_error: Option<String> = None;

    while Instant::now() < deadline {
        // Probe before rebooting, mirroring `uploader.py`'s
        // `find_bootloader`: open, try to identify, and only ask for a
        // reboot if nothing answered. A board already sitting in its
        // bootloader must not be sent MAVLink and NSH noise first.
        //
        // `preferred` leads so an operator who put the board in bootloader
        // mode by hand gets the fast path.
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

        // Nothing answered anywhere, so the board is presumably still
        // running its firmware — ask it to reboot, then let it settle.
        // `uploader.py` sleeps 0.25s after sending and another 0.3s after
        // closing the port, with comments naming the serial I/O errors that
        // appear without them; the same pauses are kept here.
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

    // Finds the board wherever it turns up — including asking it to reboot
    // into its bootloader, which is what makes this work on a board that's
    // currently running firmware.
    let (mut transport, _found_on) = connect_to_bootloader(port, Instant::now() + FIND_BOOTLOADER_TIMEOUT)?;

    // A 1.6 MB image is ~6,500 PROG_MULTI chunks, and the callback fires on
    // every one. Emitting a Tauri event per chunk means ~6,500 JSON
    // serializations and React renders during the phase that's already
    // holding the serial port flat out, so only whole-percent changes (and
    // the final chunk) cross the IPC boundary.
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
