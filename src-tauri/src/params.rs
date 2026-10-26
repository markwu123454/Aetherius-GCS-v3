use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

use mavlink::{
    dialects::ardupilotmega::{
        MavMessage, MavParamType, PARAM_REQUEST_LIST_DATA, PARAM_REQUEST_READ_DATA, PARAM_SET_DATA,
        PARAM_VALUE_DATA,
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
    /// When the last `PARAM_VALUE` arrived — how `complete_dump` tells a dump
    /// still streaming from one that has stopped short.
    last_arrival: Mutex<Option<Instant>>,
    /// Bumped by every `clear`, which ends whichever `complete_dump` was
    /// watching the dump before it.
    fetch_epoch: AtomicU64,
}

/// How long a dump can go quiet before it counts as stalled.
const STALL_AFTER: Duration = Duration::from_secs(2);
/// Stalled rounds in a row with nothing new before giving up — a vehicle
/// that never answers isn't asked forever.
const MAX_IDLE_ROUNDS: u32 = 10;
/// Missing values asked for one at a time per round; the rest wait for the next.
const MAX_READS_PER_ROUND: usize = 50;

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
    *state.last_arrival.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());

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
    *state.last_arrival.lock().unwrap_or_else(|e| e.into_inner()) = None;
    state.fetch_epoch.fetch_add(1, Ordering::SeqCst);
}

/// Sees one `PARAM_REQUEST_LIST` through to a full set of values.
///
/// A single request isn't enough. ArduPilot drops it outright while its
/// parameters are still loading, and right after a reboot it's already
/// sending heartbeats by then — exactly when the frontend asks — so all that
/// arrives is the handful it pushes out on its own as boot code sets sensor
/// IDs and the like, each carrying the full count. A lossy radio drops values
/// out of the middle of a dump too. So whenever values stop arriving short of
/// the count, this asks again: for the whole list if little of the dump came
/// through, otherwise for just the missing indices.
fn complete_dump(app: AppHandle, epoch: u64) {
    let mut last_request = Instant::now();
    let mut last_have = 0;
    let mut idle_rounds = 0;

    loop {
        std::thread::sleep(Duration::from_millis(500));

        let state = app.state::<ParamState>();
        if state.fetch_epoch.load(Ordering::SeqCst) != epoch {
            return;
        }

        let last_arrival = *state.last_arrival.lock().unwrap_or_else(|e| e.into_inner());
        let quiet_for = last_arrival.map_or(last_request.elapsed(), |at| at.elapsed().min(last_request.elapsed()));
        if quiet_for < STALL_AFTER {
            continue;
        }

        let expected = *state.expected_count.lock().unwrap_or_else(|e| e.into_inner());
        let (have, missing) = {
            let values = state.values.lock().unwrap_or_else(|e| e.into_inner());
            // Indices only come from the dump itself: a value ArduPilot pushes
            // out on its own carries index 65535, which is filtered out here.
            let missing = expected.map(|count| {
                let seen: HashSet<u16> = values.values().map(|p| p.index).filter(|&i| i < count).collect();
                (0..count).filter(|i| !seen.contains(i)).collect::<Vec<u16>>()
            });
            (values.len(), missing)
        };
        if expected.is_some_and(|count| have >= count as usize) {
            return;
        }

        if have > last_have {
            last_have = have;
            idle_rounds = 0;
        } else {
            idle_rounds += 1;
            if idle_rounds > MAX_IDLE_ROUNDS {
                return;
            }
        }

        let link = app.state::<LinkState>();
        let Some(target) = *link.target.lock().unwrap_or_else(|e| e.into_inner()) else {
            return;
        };
        let Some(connection) = link.connection.lock().unwrap_or_else(|e| e.into_inner()).clone() else {
            return;
        };

        match (expected, missing) {
            (Some(count), Some(missing)) if missing.len() <= count as usize / 2 => {
                for index in missing.into_iter().take(MAX_READS_PER_ROUND) {
                    let _ = connection.send_default(&MavMessage::PARAM_REQUEST_READ(PARAM_REQUEST_READ_DATA {
                        param_index: index as i16,
                        target_system: target.0,
                        target_component: target.1,
                        param_id: "".into(),
                    }));
                }
            }
            _ => {
                let _ = connection.send_default(&MavMessage::PARAM_REQUEST_LIST(PARAM_REQUEST_LIST_DATA {
                    target_system: target.0,
                    target_component: target.1,
                }));
            }
        }
        last_request = Instant::now();
    }
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
    let epoch = app.state::<ParamState>().fetch_epoch.load(Ordering::SeqCst);

    let _ = connection.send_default(&MavMessage::PARAM_REQUEST_LIST(PARAM_REQUEST_LIST_DATA {
        target_system: target.0,
        target_component: target.1,
    }));

    let handle = app.clone();
    std::thread::spawn(move || complete_dump(handle, epoch));
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