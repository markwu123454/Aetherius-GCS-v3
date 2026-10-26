use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use mavlink::{
    dialects::ardupilotmega::{
        LOG_DATA_DATA, LOG_ENTRY_DATA, LOG_REQUEST_DATA_DATA, LOG_REQUEST_END_DATA, LOG_REQUEST_LIST_DATA,
        MavMessage,
    },
    MavConnection,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

use crate::{link::LinkState, vehicle_profile};

pub mod analysis;
pub mod parser;

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
/// The error string `download_log` returns when it stopped because of
/// `cancel_download` rather than a real failure — the frontend matches on
/// this to skip showing it as an error.
const CANCELLED: &str = "cancelled";
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
    /// Set by `cancel_download` to the id it wants stopped. Checked by the
    /// in-flight `download_log` loop for that id between chunks; cleared at
    /// the start of every new `download_log` call.
    cancel: Mutex<Option<u16>>,
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedLog {
    pub id: u16,
    pub path: String,
}

/// Scans the connected vehicle's own `logs/` folder (see
/// `vehicle_profile::vehicle_dir`) for files already downloaded, so the
/// Logs page can show "already have this one" without needing to have
/// downloaded it in the current session — `download_log`'s own
/// `savedPaths` tracking only knows about downloads it personally ran.
/// Only `.bin` files count: `logs/analysis.rs`'s `save_analysis_state`
/// writes a JSON sidecar into this same directory (older builds named it
/// `<id>.json`), and a file whose
/// stem parses as the same numeric id would otherwise collide with it in
/// the id-keyed map the frontend builds from this list, silently handing
/// the sidecar's own path back as if it were the log itself.
#[tauri::command]
pub fn list_downloaded_logs(app: AppHandle) -> Result<Vec<DownloadedLog>, String> {
    let dir = vehicle_profile::vehicle_dir(&app)?.join("logs");
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("bin") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()).and_then(|s| s.parse::<u16>().ok()) else {
            continue;
        };
        out.push(DownloadedLog { id, path: path.to_string_lossy().to_string() });
    }
    Ok(out)
}

/// Requests that an in-flight `download_log` for `id` stop after its
/// current chunk. A no-op if `id` isn't the download actually in progress —
/// matches `pending_chunk`'s "one in-flight download at a time" model, so a
/// stale cancel from a finished download can't affect a later one.
#[tauri::command]
pub fn cancel_download(app: AppHandle, id: u16) {
    *app.state::<LogsState>().cancel.lock().unwrap_or_else(|e| e.into_inner()) = Some(id);
}

fn is_cancelled(app: &AppHandle, id: u16) -> bool {
    *app.state::<LogsState>().cancel.lock().unwrap_or_else(|e| e.into_inner()) == Some(id)
}

/// Downloads one log's raw bytes and writes them to
/// `$APPDATA/<vehicle>/logs/<id>.bin` — `<vehicle>` is the connected
/// board's own hardware UID (see `vehicle_profile.rs`), or `unknown` if it
/// hasn't reported one, so two different aircraft's log `#21`s can't
/// overwrite each other. Returns the saved path. `size` comes from the
/// caller's own `LogEntry` (from `list_logs`) — read `LOG_CHUNK_BYTES` at a
/// time sequentially, one `LOG_REQUEST_DATA`/`LOG_DATA` round trip per
/// chunk, retrying a chunk up to `LOG_CHUNK_MAX_RETRIES` times before
/// giving up on the whole download. Emits `log-download-progress` after
/// every chunk so the frontend can show a progress bar without polling.
///
/// Whether the transfer completes, is cancelled via `cancel_download`, or
/// errors out, a `LOG_REQUEST_END` is always sent afterward — ArduPilot
/// uses that to know the GCS is done pulling chunks and it can resume
/// normal logging behavior, so it needs sending on every exit path, not
/// just success.
#[tauri::command]
pub async fn download_log(app: AppHandle, id: u16, size: u32) -> Result<String, String> {
    let (connection, target) = current_link(&app)?;
    *app.state::<LogsState>().cancel.lock().unwrap_or_else(|e| e.into_inner()) = None;

    let result = fetch_all_chunks(&app, &connection, target, id, size).await;

    let _ = connection.send_default(&MavMessage::LOG_REQUEST_END(LOG_REQUEST_END_DATA {
        target_system: target.0,
        target_component: target.1,
    }));

    let bytes = result?;

    let dir = vehicle_profile::vehicle_dir(&app)?.join("logs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{id:08}.bin"));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

async fn fetch_all_chunks(
    app: &AppHandle,
    connection: &Arc<dyn MavConnection<MavMessage> + Send + Sync>,
    target: (u8, u8),
    id: u16,
    size: u32,
) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::with_capacity(size as usize);
    let mut ofs: u32 = 0;
    let mut last_emit = Instant::now();

    while ofs < size {
        if is_cancelled(app, id) {
            return Err(CANCELLED.to_string());
        }

        let chunk = fetch_chunk(app, connection, target, id, ofs).await?;
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

    Ok(bytes)
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
        if is_cancelled(app, id) {
            return Err(CANCELLED.to_string());
        }

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
