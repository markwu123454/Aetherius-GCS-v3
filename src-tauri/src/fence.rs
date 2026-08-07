use std::{sync::Mutex, time::Duration};

use mavlink::dialects::ardupilotmega::{FENCE_FETCH_POINT_DATA, FENCE_POINT_DATA, MavMessage};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio::sync::mpsc;

use crate::link::LinkState;

/// Forwards an inbound FENCE_POINT to whatever download is in flight, if any.
/// Silently dropped when no download is running — same pattern as
/// `mission::forward`.
fn forward(app: &AppHandle, data: FENCE_POINT_DATA) {
    let state = app.state::<FenceState>();
    let guard = state.tx.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(tx) = guard.as_ref() {
        let _ = tx.send(data);
    }
}

pub fn on_fence_point(app: &AppHandle, data: &FENCE_POINT_DATA) {
    forward(app, data.clone());
}

/// Channel slot for an in-flight fence download.  Mutex emptiness = "no
/// download running" lock, same as `MissionState`.
#[derive(Default)]
pub struct FenceState {
    tx: Mutex<Option<mpsc::UnboundedSender<FENCE_POINT_DATA>>>,
}

struct ClearOnDrop(AppHandle);
impl Drop for ClearOnDrop {
    fn drop(&mut self) {
        *self.0.state::<FenceState>().tx.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
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
    /// Point at idx 0: the vehicle's breach return point.
    pub return_point: Option<FencePoint>,
    /// Polygon vertices, idx 1..N.
    pub vertices: Vec<FencePoint>,
}

/// Uploads the fence polygon using the legacy ArduPilot FENCE_POINT protocol.
///
/// The frontend is responsible for calling `set_param("FENCE_TOTAL",
/// points.len())` and waiting for the echo before invoking this command, so
/// ArduPilot knows how many points to expect.
///
/// `points[0]` is the return point (breach destination, typically the polygon
/// centroid).  `points[1..]` are the polygon vertices.  The protocol is
/// fire-and-forget per point — ArduPilot stores each FENCE_POINT as it
/// arrives with no per-point acknowledgment.
#[tauri::command]
pub async fn upload_fence(app: AppHandle, points: Vec<FencePoint>) -> Result<(), String> {
    if points.len() < 2 {
        return Err("fence needs at least a return point and one vertex".to_string());
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

    for (idx, pt) in points.iter().enumerate() {
        let _ = connection.send_default(&MavMessage::FENCE_POINT(FENCE_POINT_DATA {
            lat: pt.lat as f32,
            lng: pt.lon as f32,
            target_system: target.0,
            target_component: target.1,
            idx: idx as u8,
            count: points.len() as u8,
        }));
    }

    Ok(())
}

/// Downloads the fence stored on the vehicle using the legacy FENCE_POINT
/// protocol: one `FENCE_FETCH_POINT` request per index, each answered by
/// the vehicle with a `FENCE_POINT` response forwarded here via
/// `on_fence_point`.
///
/// `count` must equal the current `FENCE_TOTAL` parameter value, as read
/// from the live param map by the frontend.
#[tauri::command]
pub async fn download_fence(app: AppHandle, count: u8) -> Result<DownloadedFence, String> {
    if count == 0 {
        return Ok(DownloadedFence {return_point: None, vertices: vec![]});
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
            return Err("a fence download is already in progress".to_string());
        }
        *guard = Some(tx);
    }
    let _guard = ClearOnDrop(app.clone());

    let mut points: Vec<FENCE_POINT_DATA> = Vec::with_capacity(count as usize);

    for idx in 0..count {
        let _ = connection.send_default(&MavMessage::FENCE_FETCH_POINT(FENCE_FETCH_POINT_DATA {
            target_system: target.0,
            target_component: target.1,
            idx,
        }));

        loop {
            match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
                Ok(Some(pt)) if pt.idx == idx => {
                    points.push(pt);
                    break;
                }
                // Stale reply for a different idx — keep waiting.
                Ok(Some(_)) => {}
                Ok(None) => return Err("fence channel closed unexpectedly".to_string()),
                Err(_) => {
                    return Err(format!(
                        "vehicle did not respond with fence point {idx} in time"
                    ))
                }
            }
        }
    }

    let mut iter = points.into_iter();
    let return_point = iter.next().map(|p| FencePoint {lat: p.lat as f64, lon: p.lng as f64});
    let vertices = iter.map(|p| FencePoint {lat: p.lat as f64, lon: p.lng as f64}).collect();

    Ok(DownloadedFence {return_point, vertices})
}
