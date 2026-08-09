use std::{sync::Mutex, time::Duration};

use mavlink::dialects::ardupilotmega::{
    MavCmd, MavFrame, MavMessage, MavMissionResult, MavMissionType, MISSION_ACK_DATA,
    MISSION_COUNT_DATA, MISSION_ITEM_INT_DATA, MISSION_REQUEST_DATA, MISSION_REQUEST_INT_DATA,
    MISSION_REQUEST_LIST_DATA,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio::sync::mpsc;

use crate::link::LinkState;

pub enum FenceEvent {
    Requested(u16),
    Ack(MavMissionResult),
    Count(u16),
    Item(MISSION_ITEM_INT_DATA),
}

/// Holds the sender side of the channel for exactly one in-flight fence
/// transfer.  Its emptiness is the "only one transfer at a time" lock.
#[derive(Default)]
pub struct FenceState {
    tx: Mutex<Option<mpsc::UnboundedSender<FenceEvent>>>,
}

/// Tries to forward an event to an in-flight fence transfer.  Returns `true`
/// if a transfer was active and consumed the event, `false` if nobody was
/// waiting — the caller should then fall back to the mission handler.
///
/// This is the correct routing strategy: incoming MISSION_* messages from the
/// vehicle often arrive over MAVLink 1, where extension fields (including
/// `mission_type`) aren't present and default to 0 (MISSION).  Routing by
/// which channel is actively waiting is more reliable than routing by the
/// field that may not be set.
fn try_forward(app: &AppHandle, event: FenceEvent) -> bool {
    let state = app.state::<FenceState>();
    let guard = state.tx.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(tx) = guard.as_ref() {
        let _ = tx.send(event);
        true
    } else {
        false
    }
}

pub fn try_on_mission_count(app: &AppHandle, data: &MISSION_COUNT_DATA) -> bool {
    try_forward(app, FenceEvent::Count(data.count))
}

pub fn try_on_mission_request_int(app: &AppHandle, data: &MISSION_REQUEST_INT_DATA) -> bool {
    try_forward(app, FenceEvent::Requested(data.seq))
}

// ArduPilot's exact variant can depend on firmware version — this legacy
// message is handled defensively alongside MISSION_REQUEST_INT.
#[allow(deprecated)]
pub fn try_on_mission_request(app: &AppHandle, data: &MISSION_REQUEST_DATA) -> bool {
    try_forward(app, FenceEvent::Requested(data.seq))
}

pub fn try_on_mission_ack(app: &AppHandle, data: &MISSION_ACK_DATA) -> bool {
    try_forward(app, FenceEvent::Ack(data.mavtype))
}

pub fn try_on_mission_item_int(app: &AppHandle, data: &MISSION_ITEM_INT_DATA) -> bool {
    try_forward(app, FenceEvent::Item(data.clone()))
}

#[derive(Deserialize, Serialize, Clone)]
pub struct FencePoint {
    pub lat: f64,
    pub lon: f64,
}

#[derive(Serialize)]
pub struct FencePolygon {
    pub vertices: Vec<FencePoint>,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct FenceCircle {
    pub center: FencePoint,
    pub radius: f32,
}

#[derive(Serialize)]
pub struct DownloadedFence {
    pub polygons: Vec<FencePolygon>,
    pub circles: Vec<FenceCircle>,
}

struct ClearOnDrop(AppHandle);
impl Drop for ClearOnDrop {
    fn drop(&mut self) {
        *self.0.state::<FenceState>().tx.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

/// Uploads one or more inclusion polygons and/or inclusion circles using the
/// MAVLink MISSION protocol with `mission_type = MAV_MISSION_TYPE_FENCE`.
///
/// Each polygon becomes a consecutive run of
/// `MAV_CMD_NAV_FENCE_POLYGON_VERTEX_INCLUSION` items.  `param1` on each item
/// is the total vertex count for that polygon, which is how the receiver
/// knows where one polygon ends and the next begins. Each circle becomes a
/// single `MAV_CMD_NAV_FENCE_CIRCLE_INCLUSION` item with `param1` set to its
/// radius in meters.
#[tauri::command]
pub async fn upload_fence(
    app: AppHandle,
    polygons: Vec<Vec<FencePoint>>,
    circles: Vec<FenceCircle>,
) -> Result<(), String> {
    if polygons.is_empty() && circles.is_empty() {
        return Err("no polygons or circles to upload".to_string());
    }
    for (i, p) in polygons.iter().enumerate() {
        if p.len() < 3 {
            return Err(format!("polygon {} needs at least 3 vertices", i + 1));
        }
    }
    for (i, c) in circles.iter().enumerate() {
        if c.radius <= 0.0 {
            return Err(format!("circle {} needs a radius greater than zero", i + 1));
        }
    }

    // Build a flat (command, param1, lat, lon) list: all polygon vertices in
    // order, followed by all circles. `command` picks the item type on the
    // wire; `param1` is the vertex-count-for-this-polygon or the
    // radius-for-this-circle depending on it.
    let mut items: Vec<(MavCmd, f32, f64, f64)> = polygons
        .iter()
        .flat_map(|polygon| {
            let n = polygon.len() as f32;
            polygon
                .iter()
                .map(move |pt| (MavCmd::MAV_CMD_NAV_FENCE_POLYGON_VERTEX_INCLUSION, n, pt.lat, pt.lon))
        })
        .collect();
    items.extend(circles.iter().map(|c| {
        (MavCmd::MAV_CMD_NAV_FENCE_CIRCLE_INCLUSION, c.radius, c.center.lat, c.center.lon)
    }));

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

    let _ = connection.send_default(&MavMessage::MISSION_COUNT(MISSION_COUNT_DATA {
        count: items.len() as u16,
        target_system: target.0,
        target_component: target.1,
        mission_type: MavMissionType::MAV_MISSION_TYPE_FENCE,
        opaque_id: 0,
    }));

    loop {
        match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
            Ok(Some(FenceEvent::Requested(seq))) => {
                let Some(&(command, param1, lat, lon)) = items.get(seq as usize) else {
                    return Err(format!("vehicle requested unknown fence item {seq}"));
                };
                let _ = connection.send_default(&MavMessage::MISSION_ITEM_INT(
                    MISSION_ITEM_INT_DATA {
                        seq,
                        frame: MavFrame::MAV_FRAME_GLOBAL,
                        command,
                        current: 0,
                        autocontinue: 1,
                        param1,
                        param2: 0.0,
                        param3: 0.0,
                        param4: 0.0,
                        x: (lat * 1e7) as i32,
                        y: (lon * 1e7) as i32,
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

/// Downloads the geofence stored on the vehicle and reconstructs the set of
/// inclusion polygons from the flat item list.  Each polygon vertex carries
/// `param1 = total vertices in this polygon`, which is the boundary marker
/// that lets us split the flat list back into individual polygons.
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
        return Ok(DownloadedFence {polygons: vec![], circles: vec![]});
    }

    let mut raw_items: Vec<MISSION_ITEM_INT_DATA> = Vec::with_capacity(count as usize);
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
                    raw_items.push(item);
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

    // Reconstruct polygons and circles from the flat item list. Each
    // POLYGON_VERTEX_INCLUSION item carries param1 = total vertex count for
    // its polygon, so we accumulate until we've consumed that many vertices,
    // then start a new polygon. Each CIRCLE_INCLUSION item is self-contained
    // (center + radius), so it becomes a circle on its own.
    let mut polygons: Vec<FencePolygon> = Vec::new();
    let mut current: Vec<FencePoint> = Vec::new();
    let mut remaining: u16 = 0;
    let mut circles: Vec<FenceCircle> = Vec::new();

    for item in raw_items {
        match item.command {
            MavCmd::MAV_CMD_NAV_FENCE_POLYGON_VERTEX_INCLUSION => {
                if remaining == 0 {
                    remaining = item.param1 as u16;
                }
                current.push(FencePoint {
                    lat: item.x as f64 / 1e7,
                    lon: item.y as f64 / 1e7,
                });
                remaining -= 1;
                if remaining == 0 {
                    polygons.push(FencePolygon {vertices: std::mem::take(&mut current)});
                }
            }
            MavCmd::MAV_CMD_NAV_FENCE_CIRCLE_INCLUSION => {
                circles.push(FenceCircle {
                    center: FencePoint {
                        lat: item.x as f64 / 1e7,
                        lon: item.y as f64 / 1e7,
                    },
                    radius: item.param1,
                });
            }
            _ => {}
        }
    }

    Ok(DownloadedFence {polygons, circles})
}
