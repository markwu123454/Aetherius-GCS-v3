//! Every CLI request this session, as the panel shows it. The backend owns
//! this record; the panel renders whatever `cli-activity` events carry and
//! answers approvals through `cli_resolve` / `cli_stop`.

use std::{
    io::Write,
    path::Path,
    sync::{atomic::{AtomicU64, Ordering}, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

/// Most requests kept in memory; older finished ones drop off the panel
/// (they're still in the history files).
const MAX_RECORDS: usize = 300;
/// Most streamed items kept per request.
const MAX_ITEMS: usize = 500;
/// Replies bigger than this are left out of the history file.
const MAX_HISTORY_DATA: usize = 256 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RequestState {
    Running,
    Waiting,
    Held,
    Done,
    Failed,
    Rejected,
    Blocked,
    Expired,
    Stopped,
    Cancelled,
}

impl RequestState {
    pub fn finished(self) -> bool {
        !matches!(self, RequestState::Running | RequestState::Waiting | RequestState::Held)
    }

    pub fn key(self) -> &'static str {
        match self {
            RequestState::Running => "running",
            RequestState::Waiting => "waiting",
            RequestState::Held => "held",
            RequestState::Done => "done",
            RequestState::Failed => "failed",
            RequestState::Rejected => "rejected",
            RequestState::Blocked => "blocked",
            RequestState::Expired => "expired",
            RequestState::Stopped => "stopped",
            RequestState::Cancelled => "cancelled",
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub id: String,
    /// Catalog name, e.g. `params set`.
    pub command: String,
    /// As typed.
    pub argv: String,
    pub folder: String,
    pub process: Vec<String>,
    pub category: String,
    pub state: RequestState,
    pub reason: Option<String>,
    /// Milliseconds since the Unix epoch.
    pub started_at: u64,
    pub ended_at: Option<u64>,
    /// What the panel shows for approval (`kind` says which layout).
    pub approval: Option<Value>,
    pub progress: Option<Value>,
    pub items: Vec<Value>,
    /// `{ok, data, error}` once finished.
    pub result: Option<Value>,
    /// Extra the panel draws that the CLI doesn't get, e.g. a full spectrum
    /// behind `logs fft`'s peaks.
    pub view: Option<Value>,
    /// The caller's UTC offset, for showing its times the way it sees them.
    pub utc_offset_minutes: i32,
    #[serde(skip)]
    pub decision: Option<bool>,
    #[serde(skip)]
    pub stop: bool,
    /// `--no-wait`: the caller left, keep going anyway.
    #[serde(skip)]
    pub detached: bool,
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[derive(Default)]
pub struct Registry {
    records: Mutex<Vec<Record>>,
    next: AtomicU64,
}

pub struct NewRecord {
    pub command: String,
    pub argv: String,
    pub folder: String,
    pub process: Vec<String>,
    pub category: String,
    pub utc_offset_minutes: i32,
}

impl Registry {
    pub fn create(&self, app: &AppHandle, new: NewRecord) -> String {
        let id = format!("r{}", self.next.fetch_add(1, Ordering::SeqCst) + 1);
        let record = Record {
            id: id.clone(),
            command: new.command,
            argv: new.argv,
            folder: new.folder,
            process: new.process,
            category: new.category,
            state: RequestState::Running,
            reason: None,
            started_at: now_ms(),
            ended_at: None,
            approval: None,
            progress: None,
            items: Vec::new(),
            result: None,
            view: None,
            utc_offset_minutes: new.utc_offset_minutes,
            decision: None,
            stop: false,
            detached: false,
        };
        let mut records = self.records.lock().unwrap_or_else(|e| e.into_inner());
        while records.len() >= MAX_RECORDS {
            match records.iter().position(|r| r.state.finished()) {
                Some(oldest) => {
                    records.remove(oldest);
                }
                None => break,
            }
        }
        records.push(record.clone());
        drop(records);
        let _ = app.emit("cli-activity", &record);
        id
    }

    /// Changes one record and tells the panel.
    pub fn update(&self, app: &AppHandle, id: &str, change: impl FnOnce(&mut Record)) -> Option<Record> {
        let mut records = self.records.lock().unwrap_or_else(|e| e.into_inner());
        let record = records.iter_mut().find(|r| r.id == id)?;
        change(record);
        if record.items.len() > MAX_ITEMS {
            let excess = record.items.len() - MAX_ITEMS;
            record.items.drain(..excess);
        }
        let snapshot = record.clone();
        drop(records);
        let _ = app.emit("cli-activity", &snapshot);
        Some(snapshot)
    }

    pub fn get(&self, id: &str) -> Option<Record> {
        self.records.lock().unwrap_or_else(|e| e.into_inner()).iter().find(|r| r.id == id).cloned()
    }

    pub fn all(&self) -> Vec<Record> {
        self.records.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn decide(&self, id: &str, approve: bool) -> Result<(), String> {
        let mut records = self.records.lock().unwrap_or_else(|e| e.into_inner());
        let record = records.iter_mut().find(|r| r.id == id).ok_or("no such request")?;
        if record.state != RequestState::Waiting {
            return Err("that request isn't waiting for approval".to_string());
        }
        record.decision = Some(approve);
        Ok(())
    }

    pub fn request_stop(&self, id: &str) -> Result<(), String> {
        let mut records = self.records.lock().unwrap_or_else(|e| e.into_inner());
        let record = records.iter_mut().find(|r| r.id == id).ok_or("no such request")?;
        if record.state.finished() {
            return Err("that request has already finished".to_string());
        }
        record.stop = true;
        Ok(())
    }

    pub fn clear_finished(&self, app: &AppHandle) {
        self.records.lock().unwrap_or_else(|e| e.into_inner()).retain(|r| !r.state.finished());
        let _ = app.emit("cli-cleared", ());
    }
}

/// `YYYY-MM-DD` for a UTC day count since 1970 (Howard Hinnant's
/// civil-from-days).
fn civil_date(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `2026-11-13T14:02:11` in the caller's local time.
pub fn iso_local(ms: u64, utc_offset_minutes: i32) -> String {
    let local = ms as i64 / 1000 + utc_offset_minutes as i64 * 60;
    let (y, m, d) = civil_date(local.div_euclid(86_400));
    let secs = local.rem_euclid(86_400);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}", secs / 3600, secs % 3600 / 60, secs % 60)
}

/// `14:02:11` in the caller's local time.
pub fn clock_local(ms: u64, utc_offset_minutes: i32) -> String {
    iso_local(ms, utc_offset_minutes)[11..].to_string()
}

/// Appends a finished request to today's history file.
pub fn append_history(dir: &Path, record: &Record) {
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let mut value = serde_json::to_value(record).unwrap_or(Value::Null);
    if let Some(data) = value.pointer_mut("/result/data") {
        if data.to_string().len() > MAX_HISTORY_DATA {
            *data = json!({"omitted": "too large for the history file"});
        }
    }
    let day = iso_local(record.started_at, 0)[..10].to_string();
    let path = dir.join(format!("{day}.jsonl"));
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{value}");
    }
}

/// Deletes history files older than `days`; `0` keeps everything.
pub fn prune_history(dir: &Path, days: u32) {
    if days == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let limit = Duration::from_secs(days as u64 * 86_400);
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let old = entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > limit);
        if old {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_times() {
        // 2026-11-13T14:02:11Z
        let ms = 1_794_578_531_000;
        assert_eq!(iso_local(ms, 0), "2026-11-13T14:02:11");
        assert_eq!(clock_local(ms, -300), "09:02:11");
        assert_eq!(iso_local(0, 0), "1970-01-01T00:00:00");
    }
}
