use std::{sync::Mutex, time::Duration};

use mavlink::dialects::ardupilotmega::{
    MavCmd, MavFrame, MavMessage, MavMissionResult, MavMissionType, MISSION_ACK_DATA,
    MISSION_COUNT_DATA, MISSION_ITEM_INT_DATA, MISSION_REQUEST_INT_DATA,
    MISSION_REQUEST_LIST_DATA,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio::sync::mpsc;

use crate::link::LinkState;

/// Events from the vehicle during an in-flight fence upload or download.
pub enum FenceEvent {
    /// Vehicle requesting a specific item by sequence number (upload path).
    Requested(u16),
    /// Final acknowledgment from the vehicle (upload path).
    Ack(MavMissionResult),
    /// How many fence items are stored on the vehicle (download path).
    Count(u16),
    /// One fence item received from the vehicle (download path).
    Item(MISSION_ITEM_INT_DATA),
}

/// Holds the sender side of the channel for exactly one in-flight fence
/// transfer.  Its emptiness is the "only one transfer at a time" lock.
#[derive(Default)]
pub struct FenceState {
    tx: Mutex<Option<mpsc::UnboundedSender<FenceEvent>>>,
}

fn forward(app: &AppHandle, event: FenceEvent) {
    let state = app.state::<FenceState>();
    let guard = state.tx.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(tx) = guard.as_ref() {
        let _ = tx.send(event);
    }
}

/// Called by dispatch when a MISSION_COUNT arrives with mission_type == FENCE.
pub fn on_mission_count(app: &AppHandle, data: &MISSION_COUNT_DATA) {
    forward(app, FenceEvent::Count(data.count));
}

/// Called by dispatch when a MISSION_REQUEST_INT arrives with mission_type ==
/// FENCE (the vehicle is requesting one of our fence items during an upload).
pub fn on_mission_request_int(app: &AppHandle, data: &MISSION_REQUEST_INT_DATA) {
    forward(app, FenceEvent::Requested(data.seq));
}

/// Called by dispatch when a MISSION_ACK arrives with mission_type == FENCE.
pub fn on_mission_ack(app: &AppHandle, data: &MISSION_ACK_DATA) {
    forward(app, FenceEvent::Ack(data.mavtype));
}

/// Called by dispatch when a MISSION_ITEM_INT arrives with mission_type ==
/// FENCE (the vehicle is sending us one of its stored fence items).
pub fn on_mission_item_int(app: &AppHandle, data: &MISSION_ITEM_INT_DATA) {
    forward(app, FenceEvent::Item(data.clone()));
}

/// One lat/lon point as received from or sent to the frontend.
#[derive(Deserialize, Serialize, Clone)]
pub struct FencePoint {
    pub lat: f64,
    pub lon: f64,
}

/// Reply shape for `download_fence`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedFence {
    /// Inclusion polygon vertices, in order.
    pub vertices: Vec<FencePoint>,
}

struct ClearOnDrop(AppHandle);
impl Drop for ClearOnDrop {
    fn drop(&mut self) {
        *self.0.state::<FenceState>().tx.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

/// Uploads a polygon geofence using the MAVLink MISSION protocol with
/// `mission_type = MAV_MISSION_TYPE_FENCE`.
///
/// Each point becomes a `MAV_CMD_NAV_FENCE_POLYGON_VERTEX_INCLUSION` item
/// with `param1` set to the total vertex count.  The standard upload
/// handshake is: GCS → MISSION_COUNT, then for each vehicle request GCS
/// responds with the item, finished by MISSION_ACK from the vehicle.
#[tauri::command]
pub async fn upload_fence(app: AppHandle, points: Vec<FencePoint>) -> Result<(), String> {
    if points.len() < 3 {
        return Err("polygon fence needs at least 3 vertices".to_string());
    }

    let link = app.state::<LinkState>();
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
        let state = app.state::<FenceState>();
        let mut guard = state.tx.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_some() {
            return Err("a fence transfer is already in progress".to_string());
        }
        *guard = Some(tx);
    }
    let _guard = ClearOnDrop(app.clone());

    let n = points.len() as u16;
    let _ = connection.send_default(&MavMessage::MISSION_COUNT(MISSION_COUNT_DATA {
        count: n,
        target_system: target.0,
        target_component: target.1,
        mission_type: MavMissionType::MAV_MISSION_TYPE_FENCE,
        opaque_id: 0,
    }));

    loop {
        match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
            Ok(Some(FenceEvent::Requested(seq))) => {
                let Some(pt) = points.get(seq as usize) else {
                    return Err(format!("vehicle requested unknown fence item {seq}"));
                };
                let _ = connection.send_default(&MavMessage::MISSION_ITEM_INT(
                    MISSION_ITEM_INT_DATA {
                        seq,
                        frame: MavFrame::MAV_FRAME_GLOBAL,
                        command: MavCmd::MAV_CMD_NAV_FENCE_POLYGON_VERTEX_INCLUSION,
                        current: 0,
                        autocontinue: 1,
                        param1: n as f32,
                        param2: 0.0,
                        param3: 0.0,
                        param4: 0.0,
                        x: (pt.lat * 1e7) as i32,
                        y: (pt.lon * 1e7) as i32,
                        z: 0.0,
                        target_system: target.0,
                        target_component: target.1,
                        mission_type: MavMissionType::MAV_MISSION_TYPE_FENCE,
                    },
                ));
            }
            Ok(Some(FenceEvent::Ack(MavMissionResult::MAV_MISSION_ACCEPTED))) => return Ok(()),
            Ok(Some(FenceEvent::Ack(other))) => {
                return Err(format!("vehicle rejected the fence: {other:?}"));
            }
            Ok(Some(FenceEvent::Count(_) | FenceEvent::Item(_))) => {}
            Ok(None) => return Err("fence channel closed unexpectedly".to_string()),
            Err(_) => return Err("vehicle did not respond in time".to_string()),
        }
    }
}

/// Downloads the geofence stored on the vehicle using the MAVLink MISSION
/// protocol with `mission_type = MAV_MISSION_TYPE_FENCE`.
///
/// Handshake: GCS → MISSION_REQUEST_LIST (FENCE), vehicle → MISSION_COUNT
/// (FENCE), then for each item: GCS → MISSION_REQUEST_INT (FENCE), vehicle
/// → MISSION_ITEM_INT (FENCE), finished with GCS → MISSION_ACK (FENCE).
/// Only `MAV_CMD_NAV_FENCE_POLYGON_VERTEX_INCLUSION` items are returned as
/// vertices; other fence item types are silently dropped for now.
#[tauri::command]
pub async fn download_fence(app: AppHandle) -> Result<DownloadedFence, String> {
    let link = app.state::<LinkState>();
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
        let state = app.state::<FenceState>();
        let mut guard = state.tx.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_some() {
            return Err("a fence transfer is already in progress".to_string());
        }
        *guard = Some(tx);
    }
    let _guard = ClearOnDrop(app.clone());

    let _ = connection.send_default(&MavMessage::MISSION_REQUEST_LIST(
        MISSION_REQUEST_LIST_DATA {
            target_system: target.0,
            target_component: target.1,
            mission_type: MavMissionType::MAV_MISSION_TYPE_FENCE,
        },
    ));

    let count = loop {
        match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
            Ok(Some(FenceEvent::Count(count))) => break count,
            Ok(Some(_)) => {}
            Ok(None) => return Err("fence channel closed unexpectedly".to_string()),
            Err(_) => return Err("vehicle did not respond in time".to_string()),
        }
    };

    if count == 0 {
        let _ = connection.send_default(&MavMessage::MISSION_ACK(MISSION_ACK_DATA {
            target_system: target.0,
            target_component: target.1,
            mavtype: MavMissionResult::MAV_MISSION_ACCEPTED,
            mission_type: MavMissionType::MAV_MISSION_TYPE_FENCE,
            opaque_id: 0,
        }));
        return Ok(DownloadedFence {vertices: vec![]});
    }

    let mut items: Vec<MISSION_ITEM_INT_DATA> = Vec::with_capacity(count as usize);
    for seq in 0..count {
        let _ = connection.send_default(&MavMessage::MISSION_REQUEST_INT(
            MISSION_REQUEST_INT_DATA {
                seq,
                target_system: target.0,
                target_component: target.1,
                mission_type: MavMissionType::MAV_MISSION_TYPE_FENCE,
            },
        ));

        loop {
            match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
                Ok(Some(FenceEvent::Item(item))) if item.seq == seq => {
                    items.push(item);
                    break;
                }
                Ok(Some(_)) => {}
                Ok(None) => return Err("fence channel closed unexpectedly".to_string()),
                Err(_) => {
                    return Err(format!("vehicle did not respond with fence item {seq} in time"))
                }
            }
        }
    }

    let _ = connection.send_default(&MavMessage::MISSION_ACK(MISSION_ACK_DATA {
        target_system: target.0,
        target_component: target.1,
        mavtype: MavMissionResult::MAV_MISSION_ACCEPTED,
        mission_type: MavMissionType::MAV_MISSION_TYPE_FENCE,
        opaque_id: 0,
    }));

    let vertices = items
        .into_iter()
        .filter(|item| {
            item.command == MavCmd::MAV_CMD_NAV_FENCE_POLYGON_VERTEX_INCLUSION
        })
        .map(|item| FencePoint {
            lat: item.x as f64 / 1e7,
            lon: item.y as f64 / 1e7,
        })
        .collect();

    Ok(DownloadedFence {vertices})
}
