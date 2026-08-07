use std::{
    sync::{atomic::Ordering, Mutex},
    time::Duration,
};

use mavlink::{
    dialects::ardupilotmega::{
        MavCmd, MavFrame, MavMessage, MavMissionResult, MavMissionType, MISSION_ACK_DATA,
        MISSION_COUNT_DATA, MISSION_ITEM_INT_DATA, MISSION_REQUEST_DATA, MISSION_REQUEST_INT_DATA,
        MISSION_REQUEST_LIST_DATA,
    },
    MavConnection,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio::sync::mpsc;

use crate::link::LinkState;
use crate::telemetry::VehicleKind;

/// Sends into whatever upload is currently listening, if any. `Err` (no
/// upload in flight) is expected and fine to drop — it just means this
/// MAVLink message arrived with nobody asking for it.
fn forward(app: &AppHandle, event: MissionEvent) {
    let state = app.state::<MissionState>();
    let guard = state.tx.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(tx) = guard.as_ref() {
        let _ = tx.send(event);
    }
}

/// What the read thread hands the in-flight `upload_mission`/`download_mission`
/// call: the vehicle asking for a specific item (upload), the terminal ack
/// (upload), or — on the way down — the item count and each item itself.
pub enum MissionEvent {
    Requested(u16),
    Ack(MavMissionResult),
    Count(u16),
    Item(MISSION_ITEM_INT_DATA),
}

/// Holds the sender side of the channel for exactly one in-flight upload.
/// Its own emptiness *is* the "only one upload at a time" lock — a second
/// `upload_mission` call sees `Some` here and refuses to start.
#[derive(Default)]
pub struct MissionState {
    tx: Mutex<Option<mpsc::UnboundedSender<MissionEvent>>>,
}

/// Action type for each waypoint, matching the TypeScript `WaypointAction` union.
/// `Serialize` is for `download_mission`'s reply; `Deserialize` is for
/// `upload_mission`'s input — the same enum reads back what it writes.
#[derive(Deserialize, Serialize, Default, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum WaypointAction {
    #[default]
    Waypoint,
    Takeoff,
    Loiter,
    ReturnToLaunch,
    Land,
}

/// The frontend's waypoint shape (`src/mission/mission.ts`). `id` is
/// frontend-only (React keys) and simply isn't declared here — serde ignores
/// fields a struct doesn't ask for, so the extra key in the JSON is harmless.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Waypoint {
    pub lat: f64,
    pub lon: f64,
    pub altitude: f32,
    /// Per-waypoint speed override (m/s). Stored in the mission draft but not
    /// yet uploaded — DO_CHANGE_SPEED interleaving is planned for a later pass.
    #[serde(default)]
    pub speed: Option<f32>,
    #[serde(default)]
    pub action: WaypointAction,
}

pub fn on_request_int(app: &AppHandle, data: &MISSION_REQUEST_INT_DATA) {
    forward(app, MissionEvent::Requested(data.seq));
}

// ArduPilot's exact variant can depend on firmware version — this legacy
// message is handled defensively alongside MISSION_REQUEST_INT.
#[allow(deprecated)]
pub fn on_request(app: &AppHandle, data: &MISSION_REQUEST_DATA) {
    forward(app, MissionEvent::Requested(data.seq));
}

pub fn on_ack(app: &AppHandle, data: &MISSION_ACK_DATA) {
    forward(app, MissionEvent::Ack(data.mavtype));
}

pub fn on_count(app: &AppHandle, data: &MISSION_COUNT_DATA) {
    forward(app, MissionEvent::Count(data.count));
}

pub fn on_item_int(app: &AppHandle, data: &MISSION_ITEM_INT_DATA) {
    forward(app, MissionEvent::Item(data.clone()));
}

/// Turns the operator's waypoints into the actual MISSION_ITEM_INT sequence
/// ArduPilot expects. ArduPilot treats item `seq == 0` as the vehicle's home
/// position, not the first real waypoint — so this emits `waypoints.len() + 1`
/// items: item 0 is home (absolute frame, current position, altitude left at
/// 0.0 as a placeholder — the snapshot doesn't carry an AMSL altitude to put
/// there, and ArduPilot's own handling of this field is exactly what the SITL
/// smoke test in the task notes is meant to check); items 1..N are the real
/// waypoints, relative-altitude frame.
///
/// If SITL shows item indexing doesn't land where expected, the fallback is
/// dropping the home item entirely (`count = waypoints.len()`, real items at
/// 0..N-1) — a change confined to this function.
fn build_upload_items(
    waypoints: &[Waypoint],
    home: (f64, f64),
    target: (u8, u8),
    include_takeoff: bool,
) -> Vec<MISSION_ITEM_INT_DATA> {
    let extra = if include_takeoff { 2 } else { 1 };
    let mut items = Vec::with_capacity(waypoints.len() + extra);

    items.push(MISSION_ITEM_INT_DATA {
        seq: 0,
        frame: MavFrame::MAV_FRAME_GLOBAL,
        command: MavCmd::MAV_CMD_NAV_WAYPOINT,
        current: 0,
        autocontinue: 1,
        x: (home.0 * 1e7) as i32,
        y: (home.1 * 1e7) as i32,
        z: 0.0,
        target_system: target.0,
        target_component: target.1,
        param1: 0.0,
        param2: 0.0,
        param3: 0.0,
        param4: 0.0,
        mission_type: MavMissionType::MAV_MISSION_TYPE_MISSION,
    });

    if include_takeoff {
        if let Some(first) = waypoints.first() {
            items.push(MISSION_ITEM_INT_DATA {
                seq: 1,
                frame: MavFrame::MAV_FRAME_GLOBAL_RELATIVE_ALT,
                command: MavCmd::MAV_CMD_NAV_TAKEOFF,
                current: 0,
                autocontinue: 1,
                x: 0,
                y: 0,
                z: first.altitude,
                target_system: target.0,
                target_component: target.1,
                param1: 0.0,
                param2: 0.0,
                param3: 0.0,
                param4: 0.0,
                mission_type: MavMissionType::MAV_MISSION_TYPE_MISSION,
            });
        }
    }

    for (index, waypoint) in waypoints.iter().enumerate() {
        let command = match waypoint.action {
            WaypointAction::Waypoint => MavCmd::MAV_CMD_NAV_WAYPOINT,
            WaypointAction::Takeoff => MavCmd::MAV_CMD_NAV_TAKEOFF,
            WaypointAction::Loiter => MavCmd::MAV_CMD_NAV_LOITER_UNLIM,
            WaypointAction::ReturnToLaunch => MavCmd::MAV_CMD_NAV_RETURN_TO_LAUNCH,
            WaypointAction::Land => MavCmd::MAV_CMD_NAV_LAND,
        };
        items.push(MISSION_ITEM_INT_DATA {
            seq: (index + extra) as u16,
            frame: MavFrame::MAV_FRAME_GLOBAL_RELATIVE_ALT,
            command,
            current: 0,
            autocontinue: 1,
            x: (waypoint.lat * 1e7) as i32,
            y: (waypoint.lon * 1e7) as i32,
            z: waypoint.altitude,
            target_system: target.0,
            target_component: target.1,
            param1: 0.0,
            param2: 0.0,
            param3: 0.0,
            param4: 0.0,
            mission_type: MavMissionType::MAV_MISSION_TYPE_MISSION,
        });
    }

    items
}

struct ClearOnDrop(AppHandle);

impl Drop for ClearOnDrop {
    fn drop(&mut self) {
        *self.0.state::<MissionState>().tx.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

#[tauri::command]
pub async fn upload_mission(app: AppHandle, waypoints: Vec<Waypoint>) -> Result<(), String> {
    if waypoints.is_empty() {
        return Err("mission has no waypoints".to_string());
    }

    let link = app.state::<LinkState>();
    let generation = link.generation.load(Ordering::SeqCst);

    let target = link
        .target
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .ok_or_else(|| "no vehicle has been heard from yet".to_string())?;
    let connection = link
        .connection
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or_else(|| "not connected".to_string())?;
    let (home, include_takeoff) = {
        let snapshot = link.snapshot.lock().unwrap_or_else(|e| e.into_inner());
        let home = match (snapshot.lat, snapshot.lon) {
            (Some(lat), Some(lon)) => (lat, lon),
            _ => return Err("no GPS fix yet — home position is unknown".to_string()),
        };
        let include_takeoff = matches!(
        snapshot.vehicle_kind,
        Some(VehicleKind::Multirotor) | Some(VehicleKind::Plane)
    );
        (home, include_takeoff)
    };
    drop(link);

    let (tx, mut rx) = mpsc::unbounded_channel();
    {
        let mission = app.state::<MissionState>();
        let mut guard = mission.tx.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_some() {
            return Err("a mission upload is already in progress".to_string());
        }
        *guard = Some(tx);
    }
    // Only created after the check above succeeds — bailing out on "already
    // in progress" must never clear someone else's in-flight sender.
    let _guard = ClearOnDrop(app.clone());

    let items = build_upload_items(&waypoints, home, target, include_takeoff);

    let _ = connection.send_default(&MavMessage::MISSION_COUNT(MISSION_COUNT_DATA {
        count: items.len() as u16,
        target_system: target.0,
        target_component: target.1,
        mission_type: MavMissionType::MAV_MISSION_TYPE_MISSION,
        opaque_id: 0,
    }));

    loop {
        if app.state::<LinkState>().generation.load(Ordering::SeqCst) != generation {
            return Err("link was reset while the upload was in flight".to_string());
        }

        match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
            Ok(Some(MissionEvent::Requested(seq))) => {
                let Some(item) = items.get(seq as usize) else {
                    return Err(format!("vehicle requested unknown item {seq}"));
                };
                let _ = connection.send_default(&MavMessage::MISSION_ITEM_INT(item.clone()));
            }
            Ok(Some(MissionEvent::Ack(MavMissionResult::MAV_MISSION_ACCEPTED))) => {
                return Ok(());
            }
            Ok(Some(MissionEvent::Ack(other))) => {
                return Err(format!("vehicle rejected the mission: {other:?}"));
            }
            // A `Count`/`Item` landing here would mean a download's replies
            // arrived during an upload — can't happen while the shared
            // `MissionState` lock enforces one transfer at a time, but
            // ignoring rather than erroring costs nothing if it ever does.
            Ok(Some(MissionEvent::Count(_) | MissionEvent::Item(_))) => {}
            Ok(None) => {
                return Err("mission channel closed unexpectedly".to_string());
            }
            Err(_) => {
                return Err("vehicle did not respond in time".to_string());
            }
        }
    }
}

/// One waypoint as reconstructed from the vehicle's own mission list — the
/// reply shape for `download_mission`, mirroring `Waypoint` minus the
/// frontend-only `id`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedWaypoint {
    pub lat: f64,
    pub lon: f64,
    pub altitude: f32,
    /// Always `None` — the vehicle's mission list carries no per-item speed
    /// (that would ride a separate DO_CHANGE_SPEED item), same limitation
    /// noted on `Waypoint::speed`.
    pub speed: Option<f32>,
    pub action: WaypointAction,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedMission {
    pub waypoints: Vec<DownloadedWaypoint>,
    /// Items the vehicle reported that don't map onto the editor's five
    /// actions (e.g. DO_* items) — dropped rather than guessed at, since
    /// their `x`/`y` aren't necessarily even a position. Surfaced so the
    /// frontend can tell the operator their round-trip wasn't lossless.
    pub skipped: u32,
}

/// Maps a downloaded `MAV_CMD_NAV_*` item onto the editor's action set. `None`
/// for anything else — the caller counts and drops those.
fn action_for_command(command: MavCmd) -> Option<WaypointAction> {
    match command {
        MavCmd::MAV_CMD_NAV_WAYPOINT => Some(WaypointAction::Waypoint),
        MavCmd::MAV_CMD_NAV_TAKEOFF => Some(WaypointAction::Takeoff),
        MavCmd::MAV_CMD_NAV_LOITER_UNLIM => Some(WaypointAction::Loiter),
        MavCmd::MAV_CMD_NAV_RETURN_TO_LAUNCH => Some(WaypointAction::ReturnToLaunch),
        MavCmd::MAV_CMD_NAV_LAND => Some(WaypointAction::Land),
        _ => None,
    }
}

/// Reverses `build_upload_items`: item 0 is always ArduPilot's home entry, so
/// it's dropped the same way it's synthesized on upload rather than shown as
/// an editable waypoint. Every other recognized nav item becomes one
/// `DownloadedWaypoint`; `x`/`y` are read back as lat/lon *1e7 regardless of
/// frame, which holds for the GLOBAL* frames this app ever uploads but is
/// not a general decoder for a mission built by another GCS in a local frame.
///
/// One asymmetry with upload worth knowing about: a multirotor/plane upload
/// also synthesizes its own separate NAV_TAKEOFF item right after home (see
/// `build_upload_items`) — that synthetic item downloads back as an ordinary
/// leading "takeoff" waypoint at (0, 0) rather than being recognized and
/// dropped, so a round-tripped mission can gain one extra bogus waypoint at
/// the start. Fixing that would mean teaching download to recognize "looks
/// synthetic", which risks dropping a real first waypoint that legitimately
/// is a takeoff at the origin — left as a known gap rather than guessed at.
fn convert_downloaded_items(items: &[MISSION_ITEM_INT_DATA]) -> (Vec<DownloadedWaypoint>, u32) {
    let mut waypoints = Vec::with_capacity(items.len().saturating_sub(1));
    let mut skipped = 0u32;
    for item in items {
        if item.seq == 0 {
            continue;
        }
        let Some(action) = action_for_command(item.command) else {
            skipped += 1;
            continue;
        };
        waypoints.push(DownloadedWaypoint {
            lat: item.x as f64 / 1e7,
            lon: item.y as f64 / 1e7,
            altitude: item.z,
            speed: None,
            action,
        });
    }
    (waypoints, skipped)
}

/// The download side of the mission protocol: `MISSION_REQUEST_LIST` →
/// `MISSION_COUNT`, then one `MISSION_REQUEST_INT`/`MISSION_ITEM_INT`
/// round trip per item, finished off with an ack so the vehicle knows the
/// transfer completed rather than timing out on its own end. Shares
/// `MissionState`'s single-sender slot with `upload_mission`, so the two
/// can't run concurrently against each other either.
#[tauri::command]
pub async fn download_mission(app: AppHandle) -> Result<DownloadedMission, String> {
    let link = app.state::<LinkState>();
    let generation = link.generation.load(Ordering::SeqCst);

    let target = link
        .target
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .ok_or_else(|| "no vehicle has been heard from yet".to_string())?;
    let connection = link
        .connection
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or_else(|| "not connected".to_string())?;
    drop(link);

    let (tx, mut rx) = mpsc::unbounded_channel();
    {
        let mission = app.state::<MissionState>();
        let mut guard = mission.tx.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_some() {
            return Err("a mission transfer is already in progress".to_string());
        }
        *guard = Some(tx);
    }
    let _guard = ClearOnDrop(app.clone());

    let check_generation = || -> Result<(), String> {
        if app.state::<LinkState>().generation.load(Ordering::SeqCst) != generation {
            Err("link was reset while the download was in flight".to_string())
        } else {
            Ok(())
        }
    };

    let _ = connection.send_default(&MavMessage::MISSION_REQUEST_LIST(MISSION_REQUEST_LIST_DATA {
        target_system: target.0,
        target_component: target.1,
        mission_type: MavMissionType::MAV_MISSION_TYPE_MISSION,
    }));

    let count = loop {
        check_generation()?;
        match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
            Ok(Some(MissionEvent::Count(count))) => break count,
            Ok(Some(_)) => {}
            Ok(None) => return Err("mission channel closed unexpectedly".to_string()),
            Err(_) => return Err("vehicle did not respond in time".to_string()),
        }
    };

    if count == 0 {
        return Ok(DownloadedMission {waypoints: Vec::new(), skipped: 0});
    }

    let mut items: Vec<MISSION_ITEM_INT_DATA> = Vec::with_capacity(count as usize);
    for seq in 0..count {
        check_generation()?;
        let _ = connection.send_default(&MavMessage::MISSION_REQUEST_INT(MISSION_REQUEST_INT_DATA {
            seq,
            target_system: target.0,
            target_component: target.1,
            mission_type: MavMissionType::MAV_MISSION_TYPE_MISSION,
        }));

        loop {
            check_generation()?;
            match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
                Ok(Some(MissionEvent::Item(item))) if item.seq == seq => {
                    items.push(item);
                    break;
                }
                // A stale reply for an earlier seq, or an unrelated event —
                // keep waiting for the one that was actually just asked for.
                Ok(Some(_)) => {}
                Ok(None) => return Err("mission channel closed unexpectedly".to_string()),
                Err(_) => return Err(format!("vehicle did not respond with item {seq} in time")),
            }
        }
    }

    let _ = connection.send_default(&MavMessage::MISSION_ACK(MISSION_ACK_DATA {
        target_system: target.0,
        target_component: target.1,
        mavtype: MavMissionResult::MAV_MISSION_ACCEPTED,
        mission_type: MavMissionType::MAV_MISSION_TYPE_MISSION,
        opaque_id: 0,
    }));

    let (waypoints, skipped) = convert_downloaded_items(&items);
    Ok(DownloadedMission {waypoints, skipped})
}

