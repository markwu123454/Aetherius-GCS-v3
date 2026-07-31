use std::{collections::HashMap, sync::Mutex, time::Duration};

use mavlink::{
    dialects::ardupilotmega::{
        MavMessage, MavParamType, PARAM_REQUEST_LIST_DATA, PARAM_SET_DATA, PARAM_VALUE_DATA,
    },
    MavConnection,
};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tokio::sync::oneshot;

use crate::link::LinkState;

#[derive(Clone, Copy)]
struct CachedParam {
    value: f32,
    param_type: MavParamType,
    index: u16,
}

#[derive(Default)]
pub struct ParamState {
    values: Mutex<HashMap<String, CachedParam>>,
    expected_count: Mutex<Option<u16>>,
    pending_batch: Mutex<Vec<(String, CachedParam)>>,
    write_waiters: Mutex<HashMap<String, oneshot::Sender<f32>>>,
}

#[derive(Clone, Serialize)]
pub struct ParamEntry {
    pub name: String,
    pub value: f32,
    #[serde(rename = "paramType")]
    pub param_type: &'static str,
    pub index: u16,
}

#[derive(Clone, Serialize)]
pub struct ParamBatch {
    pub total: Option<u16>,
    pub values: Vec<ParamEntry>,
}

fn type_name(t: MavParamType) -> &'static str {
    match t {
        MavParamType::MAV_PARAM_TYPE_UINT8 => "UINT8",
        MavParamType::MAV_PARAM_TYPE_INT8 => "INT8",
        MavParamType::MAV_PARAM_TYPE_UINT16 => "UINT16",
        MavParamType::MAV_PARAM_TYPE_INT16 => "INT16",
        MavParamType::MAV_PARAM_TYPE_UINT32 => "UINT32",
        MavParamType::MAV_PARAM_TYPE_INT32 => "INT32",
        MavParamType::MAV_PARAM_TYPE_UINT64 => "UINT64",
        MavParamType::MAV_PARAM_TYPE_INT64 => "INT64",
        MavParamType::MAV_PARAM_TYPE_REAL32 => "REAL32",
        MavParamType::MAV_PARAM_TYPE_REAL64 => "REAL64",
    }
}

/// Every `PARAM_VALUE` lands here, whether it's part of a bulk dump or the
/// echo of a `PARAM_SET`. ArduPilot encodes non-float parameters as their
/// literal numeric value cast to `f32` — not bit-reinterpreted — so
/// `param_value` is already the real number; no decoding beyond that cast is
/// needed.
pub fn on_value(app: &AppHandle, data: &PARAM_VALUE_DATA) {
    let Ok(name) = data.param_id.to_str() else {
        return;
    };
    if name.is_empty() {
        return;
    }
    let name = name.to_string();

    let cached = CachedParam {
        value: data.param_value,
        param_type: data.param_type,
        index: data.param_index,
    };

    let state = app.state::<ParamState>();
    state.values.lock().unwrap_or_else(|e| e.into_inner()).insert(name.clone(), cached);
    *state.expected_count.lock().unwrap_or_else(|e| e.into_inner()) = Some(data.param_count);
    state.pending_batch.lock().unwrap_or_else(|e| e.into_inner()).push((name.clone(), cached));

    let waiter = state.write_waiters.lock().unwrap_or_else(|e| e.into_inner()).remove(&name);
    if let Some(sender) = waiter {
        let _ = sender.send(data.param_value);
    }
}

/// Drains whatever has arrived since the last call, for `link.rs`'s
/// already-throttled emit tick to publish as one `param-values` event rather
/// than one IPC round trip per parameter — a full dump is thousands of them.
pub fn drain_batch(app: &AppHandle) -> Option<ParamBatch> {
    let state = app.state::<ParamState>();
    let batch = std::mem::take(&mut *state.pending_batch.lock().unwrap_or_else(|e| e.into_inner()));
    if batch.is_empty() {
        return None;
    }

    let total = *state.expected_count.lock().unwrap_or_else(|e| e.into_inner());
    let values = batch
        .into_iter()
        .map(|(name, cached)| ParamEntry {
            name,
            value: cached.value,
            param_type: type_name(cached.param_type),
            index: cached.index,
        })
        .collect();
    Some(ParamBatch {total, values})
}

/// Forgets everything read so far. Called on disconnect so a value read from
/// one vehicle is never shown as current for whatever connects next.
pub fn clear(app: &AppHandle) {
    let state = app.state::<ParamState>();
    state.values.lock().unwrap_or_else(|e| e.into_inner()).clear();
    *state.expected_count.lock().unwrap_or_else(|e| e.into_inner()) = None;
    state.pending_batch.lock().unwrap_or_else(|e| e.into_inner()).clear();
}

#[tauri::command]
pub fn refresh_params(app: AppHandle, link: State<LinkState>) -> Result<(), String> {
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

    clear(&app);

    let _ = connection.send_default(&MavMessage::PARAM_REQUEST_LIST(PARAM_REQUEST_LIST_DATA {
        target_system: target.0,
        target_component: target.1,
    }));
    Ok(())
}

#[tauri::command]
pub async fn set_param(app: AppHandle, name: String, value: f32) -> Result<f32, String> {
    if name.is_empty() || name.len() > 16 {
        return Err("parameter names are 1-16 characters".to_string());
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

    // Echo back the type we last saw for this param. ArduPilot only reads
    // this field for its own bookkeeping, but a well-formed message still
    // needs one, and REAL32 is a harmless default for a param never read.
    let param_type = app
        .state::<ParamState>()
        .values
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&name)
        .map(|cached| cached.param_type)
        .unwrap_or(MavParamType::MAV_PARAM_TYPE_REAL32);

    let (tx, rx) = oneshot::channel();
    // Replacing whatever was already waiting on this name is deliberate: a
    // second write to the same param supersedes the first, and the dropped
    // sender is how the first `await` below learns that, rather than hanging
    // until its own timeout.
    app.state::<ParamState>()
        .write_waiters
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(name.clone(), tx);

    let _ = connection.send_default(&MavMessage::PARAM_SET(PARAM_SET_DATA {
        param_value: value,
        target_system: target.0,
        target_component: target.1,
        param_id: name.as_str().into(),
        param_type,
    }));

    match tokio::time::timeout(Duration::from_secs(3), rx).await {
        Ok(Ok(echoed)) => {
            // PARAM_SET has no ack of its own — an echoed value that differs
            // from what was requested is the only way ArduPilot has to say
            // "clamped" or "rejected", so it's treated as failure here.
            if (echoed - value).abs() > (value.abs().max(1.0) * 1e-3) {
                Err(format!("vehicle set {name} to {echoed} instead of the requested {value}"))
            } else {
                Ok(echoed)
            }
        }
        Ok(Err(_)) => Err(format!("write to {name} was superseded by a newer write")),
        Err(_) => Err(format!(
            "{name} was not acknowledged — check the link, or that it's a real parameter on this firmware"
        )),
    }
}