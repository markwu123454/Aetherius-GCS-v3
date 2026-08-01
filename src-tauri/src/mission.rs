use std::{
    sync::{atomic::Ordering, Mutex},
    time::Duration,
};

use mavlink::{
    dialects::ardupilotmega::{
        MavCmd, MavFrame, MavMessage, MavMissionResult, MISSION_ACK_DATA, MISSION_COUNT_DATA,
        MISSION_ITEM_INT_DATA, MISSION_REQUEST_DATA, MISSION_REQUEST_INT_DATA,
    },
    MavConnection,
};
use serde::Deserialize;
use tauri::{AppHandle, Manager};
use tokio::sync::mpsc;

use crate::link::LinkState;

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

/// What the read thread hands the in-flight `upload_mission` call: either the
/// vehicle asking for a specific item, or the terminal ack.
pub enum MissionEvent {
    Requested(u16),
    Ack(MavMissionResult),
}

/// Holds the sender side of the channel for exactly one in-flight upload.
/// Its own emptiness *is* the "only one upload at a time" lock — a second
/// `upload_mission` call sees `Some` here and refuses to start.
#[derive(Default)]
pub struct MissionState {
    tx: Mutex<Option<mpsc::UnboundedSender<MissionEvent>>>,
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
) -> Vec<MISSION_ITEM_INT_DATA> {
    let mut items = Vec::with_capacity(waypoints.len() + 1);

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
    });

    for (index, waypoint) in waypoints.iter().enumerate() {
        items.push(MISSION_ITEM_INT_DATA {
            seq: (index + 1) as u16,
            frame: MavFrame::MAV_FRAME_GLOBAL_RELATIVE_ALT,
            command: MavCmd::MAV_CMD_NAV_WAYPOINT,
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
    let home = {
        let snapshot = link.snapshot.lock().unwrap_or_else(|e| e.into_inner());
        match (snapshot.lat, snapshot.lon) {
            (Some(lat), Some(lon)) => (lat, lon),
            _ => return Err("no GPS fix yet — home position is unknown".to_string()),
        }
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

    let items = build_upload_items(&waypoints, home, target);

    let _ = connection.send_default(&MavMessage::MISSION_COUNT(MISSION_COUNT_DATA {
        count: items.len() as u16,
        target_system: target.0,
        target_component: target.1,
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
            Ok(None) => {
                return Err("mission channel closed unexpectedly".to_string());
            }
            Err(_) => {
                return Err("vehicle did not respond in time".to_string());
            }
        }
    }
}

