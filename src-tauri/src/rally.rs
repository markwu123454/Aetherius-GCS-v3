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

pub enum RallyEvent {
    Requested(u16),
    Ack(MavMissionResult),
    Count(u16),
    Item(MISSION_ITEM_INT_DATA),
}

/// Holds the sender side of the channel for exactly one in-flight rally
/// transfer.  Its emptiness is the "only one transfer at a time" lock — same
/// shape as `fence::FenceState`.
#[derive(Default)]
pub struct RallyState {
    tx: Mutex<Option<mpsc::UnboundedSender<RallyEvent>>>,
}

/// Tries to forward an event to an in-flight rally transfer.  Returns `true`
/// if a transfer was active and consumed the event, `false` if nobody was
/// waiting — the caller should then fall back to the next handler in line
/// (`fence`, then `mission`; see `dispatch::route`), for the same reason
/// `fence::try_forward` does: MAVLink 1 senders omit `mission_type`
/// entirely, so routing by who's actively waiting is more reliable than
/// routing by a field that may not be set.
fn try_forward(app: &AppHandle, event: RallyEvent) -> bool {
    let state = app.state::<RallyState>();
    let guard = state.tx.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(tx) = guard.as_ref() {
        let _ = tx.send(event);
        true
    } else {
        false
    }
}

pub fn try_on_mission_count(app: &AppHandle, data: &MISSION_COUNT_DATA) -> bool {
    try_forward(app, RallyEvent::Count(data.count))
}

pub fn try_on_mission_request_int(app: &AppHandle, data: &MISSION_REQUEST_INT_DATA) -> bool {
    try_forward(app, RallyEvent::Requested(data.seq))
}

// ArduPilot's exact variant can depend on firmware version — this legacy
// message is handled defensively alongside MISSION_REQUEST_INT.
#[allow(deprecated)]
pub fn try_on_mission_request(app: &AppHandle, data: &MISSION_REQUEST_DATA) -> bool {
    try_forward(app, RallyEvent::Requested(data.seq))
}

pub fn try_on_mission_ack(app: &AppHandle, data: &MISSION_ACK_DATA) -> bool {
    try_forward(app, RallyEvent::Ack(data.mavtype))
}

pub fn try_on_mission_item_int(app: &AppHandle, data: &MISSION_ITEM_INT_DATA) -> bool {
    try_forward(app, RallyEvent::Item(data.clone()))
}

/// One rally point: an alternate RTL destination, alongside home. ArduPilot's
/// own mission-item-protocol handler for `MAV_MISSION_TYPE_RALLY`
/// (`MissionItemProtocol_Rally`) only ever reads/writes lat/lon/alt — the
/// storage-level `break_alt`/`land_dir`/`flags` fields on its `RallyLocation`
/// struct exist but aren't wired to any MAVLink field, so there is nothing
/// else here to round-trip.
#[derive(Deserialize, Serialize, Clone)]
pub struct RallyPoint {
    pub lat: f64,
    pub lon: f64,
    /// Meters, relative to home — matches `MAV_FRAME_GLOBAL_RELATIVE_ALT`,
    /// the frame ArduPilot itself sends rally points back in.
    pub alt: f32,
}

struct ClearOnDrop(AppHandle);
impl Drop for ClearOnDrop {
    fn drop(&mut self) {
        *self.0.state::<RallyState>().tx.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

/// Uploads the full rally point set using the MAVLink MISSION protocol with
/// `mission_type = MAV_MISSION_TYPE_RALLY`. Each point becomes a single
/// `MAV_CMD_NAV_RALLY_POINT` item — no polygon-style grouping needed, unlike
/// `fence::upload_fence`, since every point stands alone.
#[tauri::command]
pub async fn upload_rally(app: AppHandle, points: Vec<RallyPoint>) -> Result<(), String> {
    if points.is_empty() {
        return Err("no rally points to upload".to_string());
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
        let state = app.state::<RallyState>();
        let mut guard = state.tx.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_some() {
            return Err("a rally transfer is already in progress".to_string());
        }
        *guard = Some(tx);
    }
    let _guard = ClearOnDrop(app.clone());

    let _ = connection.send_default(&MavMessage::MISSION_COUNT(MISSION_COUNT_DATA {
        count: points.len() as u16,
        target_system: target.0,
        target_component: target.1,
        mission_type: MavMissionType::MAV_MISSION_TYPE_RALLY,
        opaque_id: 0,
    }));

    loop {
        match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
            Ok(Some(RallyEvent::Requested(seq))) => {
                let Some(point) = points.get(seq as usize) else {
                    return Err(format!("vehicle requested unknown rally item {seq}"));
                };
                let _ = connection.send_default(&MavMessage::MISSION_ITEM_INT(
                    MISSION_ITEM_INT_DATA {
                        seq,
                        frame: MavFrame::MAV_FRAME_GLOBAL_RELATIVE_ALT,
                        command: MavCmd::MAV_CMD_NAV_RALLY_POINT,
                        current: 0,
                        autocontinue: 1,
                        param1: 0.0,
                        param2: 0.0,
                        param3: 0.0,
                        param4: 0.0,
                        x: (point.lat * 1e7) as i32,
                        y: (point.lon * 1e7) as i32,
                        z: point.alt,
                        target_system: target.0,
                        target_component: target.1,
                        mission_type: MavMissionType::MAV_MISSION_TYPE_RALLY,
                    },
                ));
            }
            Ok(Some(RallyEvent::Ack(MavMissionResult::MAV_MISSION_ACCEPTED))) => return Ok(()),
            Ok(Some(RallyEvent::Ack(other))) => {
                return Err(format!("vehicle rejected the rally points: {other:?}"));
            }
            Ok(Some(RallyEvent::Count(_) | RallyEvent::Item(_))) => {}
            Ok(None) => return Err("rally channel closed unexpectedly".to_string()),
            Err(_) => return Err("vehicle did not respond in time".to_string()),
        }
    }
}

/// Downloads the rally points stored on the vehicle.
#[tauri::command]
pub async fn download_rally(app: AppHandle) -> Result<Vec<RallyPoint>, String> {
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
        let state = app.state::<RallyState>();
        let mut guard = state.tx.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_some() {
            return Err("a rally transfer is already in progress".to_string());
        }
        *guard = Some(tx);
    }
    let _guard = ClearOnDrop(app.clone());

    let _ = connection.send_default(&MavMessage::MISSION_REQUEST_LIST(
        MISSION_REQUEST_LIST_DATA {
            target_system: target.0,
            target_component: target.1,
            mission_type: MavMissionType::MAV_MISSION_TYPE_RALLY,
        },
    ));

    let count = loop {
        match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
            Ok(Some(RallyEvent::Count(count))) => break count,
            Ok(Some(_)) => {}
            Ok(None) => return Err("rally channel closed unexpectedly".to_string()),
            Err(_) => return Err("vehicle did not respond in time".to_string()),
        }
    };

    if count == 0 {
        let _ = connection.send_default(&MavMessage::MISSION_ACK(MISSION_ACK_DATA {
            target_system: target.0,
            target_component: target.1,
            mavtype: MavMissionResult::MAV_MISSION_ACCEPTED,
            mission_type: MavMissionType::MAV_MISSION_TYPE_RALLY,
            opaque_id: 0,
        }));
        return Ok(vec![]);
    }

    let mut raw_items: Vec<MISSION_ITEM_INT_DATA> = Vec::with_capacity(count as usize);
    for seq in 0..count {
        let _ = connection.send_default(&MavMessage::MISSION_REQUEST_INT(
            MISSION_REQUEST_INT_DATA {
                seq,
                target_system: target.0,
                target_component: target.1,
                mission_type: MavMissionType::MAV_MISSION_TYPE_RALLY,
            },
        ));

        loop {
            match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
                Ok(Some(RallyEvent::Item(item))) if item.seq == seq => {
                    raw_items.push(item);
                    break;
                }
                Ok(Some(_)) => {}
                Ok(None) => return Err("rally channel closed unexpectedly".to_string()),
                Err(_) => {
                    return Err(format!("vehicle did not respond with rally item {seq} in time"))
                }
            }
        }
    }

    let _ = connection.send_default(&MavMessage::MISSION_ACK(MISSION_ACK_DATA {
        target_system: target.0,
        target_component: target.1,
        mavtype: MavMissionResult::MAV_MISSION_ACCEPTED,
        mission_type: MavMissionType::MAV_MISSION_TYPE_RALLY,
        opaque_id: 0,
    }));

    Ok(raw_items
        .into_iter()
        .filter(|item| item.command == MavCmd::MAV_CMD_NAV_RALLY_POINT)
        .map(|item| RallyPoint {
            lat: item.x as f64 / 1e7,
            lon: item.y as f64 / 1e7,
            alt: item.z,
        })
        .collect())
}
