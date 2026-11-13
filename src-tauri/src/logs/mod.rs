use std::{
    collections::HashMap,
    io,
    path::{Path, PathBuf},
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
    /// The file's size on disk. ArduPilot reuses log numbers once logs are
    /// erased, so an id alone can't tell this file apart from a newer log
    /// with the same number still on the vehicle; id and size together can.
    pub size: u64,
}

/// The file name for the `copy`th distinct log saved under `id`:
/// `00000042.bin` for the first, then `00000042-2.bin`, `00000042-3.bin`, …
/// for later logs the vehicle gave the same number.
fn log_file_name(id: u16, copy: u32) -> String {
    if copy <= 1 {
        format!("{id:08}.bin")
    } else {
        format!("{id:08}-{copy}.bin")
    }
}

/// The log id in a name `log_file_name` produced, or `None` for anything
/// else in the folder. Only `.bin` files count: `logs/analysis.rs`'s
/// `save_analysis_state` writes a JSON sidecar into this same directory
/// (older builds named it `<id>.json`), and a file whose stem parses as the
/// same numeric id would otherwise be handed back as if it were the log.
fn parse_log_file_name(name: &str) -> Option<u16> {
    let stem = name.strip_suffix(".bin")?;
    let id = match stem.split_once('-') {
        Some((id, copy)) => {
            copy.parse::<u32>().ok().filter(|&n| n >= 2)?;
            id
        }
        None => stem,
    };
    id.parse::<u16>().ok()
}

/// Where to save a freshly downloaded log `id` in `dir` without overwriting
/// a different log. ArduPilot reuses log numbers once logs are erased, so an
/// `00000042.bin` already on disk may be an older flight than the log 42
/// just downloaded. Tries each `log_file_name` in turn: a free name is used;
/// a file with exactly these bytes is the same log downloaded again and is
/// returned as already saved (`true`); any other file is left alone.
fn save_path_for(dir: &Path, id: u16, bytes: &[u8]) -> io::Result<(PathBuf, bool)> {
    let mut copy = 1;
    loop {
        let path = dir.join(log_file_name(id, copy));
        match std::fs::metadata(&path) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok((path, false)),
            Err(e) => return Err(e),
            Ok(meta) => {
                if meta.len() == bytes.len() as u64 && std::fs::read(&path)? == bytes {
                    return Ok((path, true));
                }
            }
        }
        copy += 1;
    }
}

/// Scans the connected vehicle's own `logs/` folder (see
/// `vehicle_profile::vehicle_dir`) for files already downloaded, so the
/// Logs page can show "already have this one" without needing to have
/// downloaded it in the current session. Each comes back with its size,
/// since the id alone can match a different log the vehicle has since
/// given the same number.
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
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let Some(id) = path.file_name().and_then(|s| s.to_str()).and_then(parse_log_file_name) else {
            continue;
        };
        out.push(DownloadedLog { id, path: path.to_string_lossy().to_string(), size: meta.len() });
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
/// overwrite each other. A different log already saved under the same id
/// (the vehicle reuses numbers once logs are erased) is never overwritten:
/// the new one gets the next free name from `save_path_for`, and the same
/// log downloaded again isn't written twice. Returns the saved path. `size` comes from the
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
    let (path, already_saved) = save_path_for(&dir, id, &bytes).map_err(|e| e.to_string())?;
    if !already_saved {
        std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh, empty directory for one test, removed when the guard drops.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("aetherius-logs-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn save(dir: &Path, id: u16, bytes: &[u8]) -> (String, bool) {
        let (path, already_saved) = save_path_for(dir, id, bytes).unwrap();
        if !already_saved {
            std::fs::write(&path, bytes).unwrap();
        }
        (path.file_name().unwrap().to_string_lossy().to_string(), already_saved)
    }

    #[test]
    fn file_names_round_trip() {
        assert_eq!(log_file_name(42, 1), "00000042.bin");
        assert_eq!(log_file_name(42, 3), "00000042-3.bin");
        assert_eq!(parse_log_file_name("00000042.bin"), Some(42));
        assert_eq!(parse_log_file_name("00000042-3.bin"), Some(42));
        assert_eq!(parse_log_file_name("42.bin"), Some(42));
    }

    #[test]
    fn other_files_in_the_folder_are_ignored() {
        assert_eq!(parse_log_file_name("00000042.bin.analysis.json"), None);
        assert_eq!(parse_log_file_name("00000042.json"), None);
        assert_eq!(parse_log_file_name("00000042-1.bin"), None);
        assert_eq!(parse_log_file_name("00000042-x.bin"), None);
        assert_eq!(parse_log_file_name("flight.bin"), None);
    }

    #[test]
    fn a_reused_log_number_gets_its_own_file() {
        let dir = TempDir::new("reused");
        assert_eq!(save(&dir.0, 42, b"first flight"), ("00000042.bin".into(), false));
        assert_eq!(save(&dir.0, 42, b"second flight, longer"), ("00000042-2.bin".into(), false));
        assert_eq!(save(&dir.0, 42, b"third flight"), ("00000042-3.bin".into(), false));
        assert_eq!(std::fs::read(dir.0.join("00000042.bin")).unwrap(), b"first flight");
        assert_eq!(std::fs::read(dir.0.join("00000042-2.bin")).unwrap(), b"second flight, longer");
    }

    #[test]
    fn same_size_but_different_bytes_is_a_different_log() {
        let dir = TempDir::new("same-size");
        save(&dir.0, 7, b"aaaa");
        assert_eq!(save(&dir.0, 7, b"bbbb"), ("00000007-2.bin".into(), false));
    }

    #[test]
    fn downloading_the_same_log_again_reuses_its_file() {
        let dir = TempDir::new("again");
        save(&dir.0, 42, b"first flight");
        save(&dir.0, 42, b"second flight");
        assert_eq!(save(&dir.0, 42, b"second flight"), ("00000042-2.bin".into(), true));
        assert_eq!(save(&dir.0, 42, b"first flight"), ("00000042.bin".into(), true));
        assert_eq!(std::fs::read_dir(&dir.0).unwrap().count(), 2);
    }
}
