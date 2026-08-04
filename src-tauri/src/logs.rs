use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use mavlink::{
    dialects::ardupilotmega::{
        LOG_DATA_DATA, LOG_ENTRY_DATA, LOG_REQUEST_DATA_DATA, LOG_REQUEST_LIST_DATA, MavMessage,
    },
    MavConnection,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

use crate::link::LinkState;

/// How many bytes `LOG_DATA`'s `data` field holds per reply — the
/// protocol's own fixed chunk size, not a tunable.
const LOG_CHUNK_BYTES: u32 = 90;

const LOG_LIST_POLL_INTERVAL: Duration = Duration::from_millis(200);
/// How long to wait, per round, for `LOG_ENTRY` replies to a
/// `LOG_REQUEST_LIST` before re-sending it.
const LOG_LIST_ROUND_TIMEOUT: Duration = Duration::from_secs(2);
const LOG_LIST_MAX_ROUNDS: u32 = 5;

const LOG_CHUNK_TIMEOUT: Duration = Duration::from_secs(1);
const LOG_CHUNK_MAX_RETRIES: u32 = 5;
/// How often to emit `log-download-progress` during a transfer — a 90-byte
/// chunk can mean tens of thousands of them for one log, and emitting a
/// progress event for every single one floods the IPC bridge for no
/// visible benefit.
const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(150);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub id: u16,
    pub time_utc: u32,
    pub size: u32,
}

/// The fields of a `LOG_DATA` reply this module actually needs, copied out
/// on arrival — a local type rather than passing the mavlink crate's own
/// `LOG_DATA_DATA` through the oneshot, so nothing here depends on whether
/// that struct happens to derive `Clone`.
struct LogChunk {
    ofs: u32,
    id: u16,
    count: u8,
    data: [u8; 90],
}

#[derive(Default)]
pub struct LogsState {
    /// Every `LOG_ENTRY` seen since the current `list_logs` call cleared
    /// this, keyed by log id.
    entries: Mutex<HashMap<u16, LogEntry>>,
    /// `num_logs` from the most recently seen `LOG_ENTRY` — every entry in
    /// a listing reports the same total, so whichever arrived last is as
    /// good as any. `None` until the first one arrives.
    total: Mutex<Option<u16>>,
    /// The chunk `download_log`'s current iteration is waiting on, if any.
    pending_chunk: Mutex<Option<oneshot::Sender<LogChunk>>>,
}

/// Routes one `LOG_ENTRY` into the shared map `list_logs` polls. Called
/// from `dispatch.rs`.
pub fn on_log_entry(app: &AppHandle, data: &LOG_ENTRY_DATA) {
    let state = app.state::<LogsState>();
    state
        .entries
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(data.id, LogEntry { id: data.id, time_utc: data.time_utc, size: data.size });
    *state.total.lock().unwrap_or_else(|e| e.into_inner()) = Some(data.num_logs);
}

/// Routes a `LOG_DATA` reply to whichever chunk request is currently
/// waiting on one. Called from `dispatch.rs`.
pub fn on_log_data(app: &AppHandle, data: &LOG_DATA_DATA) {
    let chunk = LogChunk { ofs: data.ofs, id: data.id, count: data.count, data: data.data };
    if let Some(sender) = app.state::<LogsState>().pending_chunk.lock().unwrap_or_else(|e| e.into_inner()).take() {
        let _ = sender.send(chunk);
    }
}

fn current_link(app: &AppHandle) -> Result<(Arc<dyn MavConnection<MavMessage> + Send + Sync>, (u8, u8)), String> {
    let link = app.state::<LinkState>();
    let connection = link
        .connection
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or_else(|| "no vehicle has been heard from yet".to_string())?;
    let target = link
        .target
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .ok_or_else(|| "no vehicle has been heard from yet".to_string())?;
    Ok((connection, target))
}

/// Lists every dataflash log on the vehicle. Sends `LOG_REQUEST_LIST` for
/// the full id range (0..0xFFFF, ArduPilot's own "give me everything"
/// convention) and waits for a `LOG_ENTRY` per log — since a radio link
/// drops packets, this polls the shared state for up to
/// `LOG_LIST_ROUND_TIMEOUT` and re-sends the same request if entries are
/// still missing, up to `LOG_LIST_MAX_ROUNDS` times, rather than trusting a
/// single round trip.
#[tauri::command]
pub async fn list_logs(app: AppHandle) -> Result<Vec<LogEntry>, String> {
    let (connection, target) = current_link(&app)?;
    let state = app.state::<LogsState>();
    state.entries.lock().unwrap_or_else(|e| e.into_inner()).clear();
    *state.total.lock().unwrap_or_else(|e| e.into_inner()) = None;

    for _ in 0..LOG_LIST_MAX_ROUNDS {
        let request =
            LOG_REQUEST_LIST_DATA { start: 0, end: 0xFFFF, target_system: target.0, target_component: target.1 };
        let _ = connection.send_default(&MavMessage::LOG_REQUEST_LIST(request));

        let deadline = Instant::now() + LOG_LIST_ROUND_TIMEOUT;
        while Instant::now() < deadline {
            tokio::time::sleep(LOG_LIST_POLL_INTERVAL).await;
            if list_complete(&app) {
                return Ok(sorted_entries(&app));
            }
        }
    }

    let entries = sorted_entries(&app);
    if entries.is_empty() {
        Err("the vehicle never responded to the log list request".to_string())
    } else {
        // A partial list (some entries never arrived after every retry)
        // still beats discarding everything collected so far.
        Ok(entries)
    }
}

fn list_complete(app: &AppHandle) -> bool {
    let state = app.state::<LogsState>();
    let total = *state.total.lock().unwrap_or_else(|e| e.into_inner());
    match total {
        None => false,
        Some(0) => true,
        Some(n) => state.entries.lock().unwrap_or_else(|e| e.into_inner()).len() == n as usize,
    }
}

fn sorted_entries(app: &AppHandle) -> Vec<LogEntry> {
    let mut entries: Vec<LogEntry> =
        app.state::<LogsState>().entries.lock().unwrap_or_else(|e| e.into_inner()).values().cloned().collect();
    entries.sort_by_key(|e| e.id);
    entries
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    id: u16,
    received: u32,
    total: u32,
}

/// Downloads one log's raw bytes and writes them to
/// `$APPDATA/logs/<id>.bin`, returning that path. `size` comes from the
/// caller's own `LogEntry` (from `list_logs`) — read `LOG_CHUNK_BYTES` at a
/// time sequentially, one `LOG_REQUEST_DATA`/`LOG_DATA` round trip per
/// chunk, retrying a chunk up to `LOG_CHUNK_MAX_RETRIES` times before
/// giving up on the whole download. Emits `log-download-progress` after
/// every chunk so the frontend can show a progress bar without polling.
#[tauri::command]
pub async fn download_log(app: AppHandle, id: u16, size: u32) -> Result<String, String> {
    let (connection, target) = current_link(&app)?;

    let mut bytes = Vec::with_capacity(size as usize);
    let mut ofs: u32 = 0;
    let mut last_emit = Instant::now();

    while ofs < size {
        let chunk = fetch_chunk(&app, &connection, target, id, ofs).await?;
        let got = (chunk.count as usize).min(chunk.data.len());
        if got == 0 {
            break; // ArduPilot signals end-of-log with a zero-count reply
        }
        bytes.extend_from_slice(&chunk.data[..got]);
        ofs += got as u32;

        // Paced to a few updates a second, plus always the final one so the
        // UI reliably reaches 100% rather than stalling just short of it.
        if ofs >= size || last_emit.elapsed() >= PROGRESS_EMIT_INTERVAL {
            let _ = app.emit("log-download-progress", DownloadProgress { id, received: ofs, total: size });
            last_emit = Instant::now();
        }
    }

    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("logs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{id:08}.bin"));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// One `LOG_REQUEST_DATA`/`LOG_DATA` round trip, retried on timeout or on a
/// reply that doesn't match the chunk actually asked for (a stale reply
/// from an earlier retry, most likely) — up to `LOG_CHUNK_MAX_RETRIES`
/// times before giving up.
async fn fetch_chunk(
    app: &AppHandle,
    connection: &Arc<dyn MavConnection<MavMessage> + Send + Sync>,
    target: (u8, u8),
    id: u16,
    ofs: u32,
) -> Result<LogChunk, String> {
    for _ in 0..LOG_CHUNK_MAX_RETRIES {
        let (tx, rx) = oneshot::channel();
        *app.state::<LogsState>().pending_chunk.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx);

        let request = LOG_REQUEST_DATA_DATA {
            ofs,
            count: LOG_CHUNK_BYTES,
            id,
            target_system: target.0,
            target_component: target.1,
        };
        let _ = connection.send_default(&MavMessage::LOG_REQUEST_DATA(request));

        if let Ok(Ok(chunk)) = tokio::time::timeout(LOG_CHUNK_TIMEOUT, rx).await {
            if chunk.id == id && chunk.ofs == ofs {
                return Ok(chunk);
            }
        }
    }
    Err(format!("timed out reading log {id} at offset {ofs}"))
}