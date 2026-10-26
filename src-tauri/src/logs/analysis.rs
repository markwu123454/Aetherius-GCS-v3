//! Turns a parsed dataflash log (see `parser.rs`) into what the Log
//! Analysis page actually asks for: a summary of what's in the file, and
//! on-demand numeric/text extraction for whichever rows the user has added
//! to the timeline. Parsing the whole file only happens once per path, in
//! `open_log` — everything after that reuses the cached offset index.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::parser::{self, FieldValue, ParsedLog};

#[derive(Default)]
pub struct AnalysisState {
    /// One parsed index per log path opened this session. Never evicted —
    /// a session realistically opens a handful of logs, not enough for the
    /// cached offset indexes (a handful of `u64`s per record, not the raw
    /// bytes) to matter memory-wise.
    cache: Mutex<HashMap<PathBuf, Arc<ParsedLog>>>,
}

fn parsed_log(app: &AppHandle, path: &str) -> Result<Arc<ParsedLog>, String> {
    let path_buf = PathBuf::from(path);
    let state = app.state::<AnalysisState>();
    if let Some(existing) = state.cache.lock().unwrap_or_else(|e| e.into_inner()).get(&path_buf) {
        return Ok(existing.clone());
    }
    let parsed = Arc::new(parser::parse_index(&path_buf)?);
    state.cache.lock().unwrap_or_else(|e| e.into_inner()).insert(path_buf, parsed.clone());
    Ok(parsed)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageTypeSummary {
    pub name: String,
    pub fields: Vec<String>,
    pub count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogSummary {
    pub message_types: Vec<MessageTypeSummary>,
    pub start_us: u64,
    pub end_us: u64,
}

/// Parses the whole log at `path` once (cached by path for the rest of the
/// session — see `AnalysisState`) and returns what the row-add drawer and
/// timeline overview need: every message type present, its field names,
/// how many records it has, and the log's overall time bounds.
#[tauri::command]
pub fn open_log(app: AppHandle, path: String) -> Result<LogSummary, String> {
    let parsed = parsed_log(&app, &path)?;
    let mut message_types: Vec<MessageTypeSummary> = parsed
        .offsets
        .iter()
        .map(|(name, offsets)| MessageTypeSummary {
            name: name.clone(),
            fields: parsed.formats.get(name).map(|f| f.fields.iter().map(|field| field.name.clone()).collect()).unwrap_or_default(),
            count: offsets.len(),
        })
        .collect();
    message_types.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(LogSummary { message_types, start_us: parsed.start_us, end_us: parsed.end_us })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesResponse {
    pub time_us: Vec<u64>,
    pub series: HashMap<String, Vec<f64>>,
}

/// Extracts one or more numeric fields of `message_type` over
/// `[start_us, end_us]` (unbounded on whichever side is omitted),
/// decimated by simple stride to at most `max_points` samples if given —
/// every Nth record kept, not a real min/max or LTTB reduction. Good
/// enough to keep a zoomed-out row readable without shipping every raw
/// sample over IPC; re-request with a narrower range as the timeline zooms
/// in for finer detail, same as `max_points` being the row's pixel width.
#[tauri::command]
pub fn get_log_series(
    app: AppHandle,
    path: String,
    message_type: String,
    fields: Vec<String>,
    start_us: Option<u64>,
    end_us: Option<u64>,
    max_points: Option<usize>,
) -> Result<SeriesResponse, String> {
    let parsed = parsed_log(&app, &path)?;
    let fmt = parsed.formats.get(&message_type).ok_or_else(|| format!("unknown message type {message_type}"))?;
    let offsets = parsed.offsets.get(&message_type).cloned().unwrap_or_default();
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
    let payload_len = fmt.length.saturating_sub(3);

    let lo = start_us.unwrap_or(0);
    let hi = end_us.unwrap_or(u64::MAX);

    let mut time_us = Vec::new();
    let mut series: HashMap<String, Vec<f64>> = fields.iter().map(|f| (f.clone(), Vec::new())).collect();

    for &offset in &offsets {
        let start = offset as usize;
        let Some(payload) = data.get(start..start + payload_len) else { continue };
        let values = parser::decode_record(payload, fmt);
        let Some(t) = values.get("TimeUS").and_then(FieldValue::as_f64) else { continue };
        let t = t as u64;
        if t < lo || t > hi {
            continue;
        }
        time_us.push(t);
        for field in &fields {
            let v = values.get(field).and_then(FieldValue::as_f64).unwrap_or(f64::NAN);
            series.get_mut(field).unwrap().push(v);
        }
    }

    if let Some(max) = max_points {
        decimate(&mut time_us, &mut series, max);
    }

    Ok(SeriesResponse { time_us, series })
}

/// Thins `time_us` and every series to at most `max` samples by stride.
fn decimate(time_us: &mut Vec<u64>, series: &mut HashMap<String, Vec<f64>>, max: usize) {
    let len = time_us.len();
    if max == 0 || len <= max {
        return;
    }
    let stride = len.div_ceil(max);
    *time_us = time_us.iter().step_by(stride).copied().collect();
    for values in series.values_mut() {
        *values = values.iter().step_by(stride).copied().collect();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextEvent {
    pub time_us: u64,
    pub text: String,
}

/// Extracts one field of `message_type` as a time-ordered list of text —
/// every occurrence, never decimated, since these are sparse discrete
/// events (the console row's `MSG.Message`, mode names, arm-check
/// failures) rather than a dense line a chart needs thinning to render.
#[tauri::command]
pub fn get_log_text_events(app: AppHandle, path: String, message_type: String, field: String) -> Result<Vec<TextEvent>, String> {
    let parsed = parsed_log(&app, &path)?;
    let fmt = parsed.formats.get(&message_type).ok_or_else(|| format!("unknown message type {message_type}"))?;
    let offsets = parsed.offsets.get(&message_type).cloned().unwrap_or_default();
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
    let payload_len = fmt.length.saturating_sub(3);

    let mut out = Vec::new();
    for &offset in &offsets {
        let start = offset as usize;
        let Some(payload) = data.get(start..start + payload_len) else { continue };
        let values = parser::decode_record(payload, fmt);
        let Some(t) = values.get("TimeUS").and_then(FieldValue::as_f64) else { continue };
        let text = match values.get(&field) {
            Some(FieldValue::Text(s)) => s.clone(),
            Some(FieldValue::Number(n)) => n.to_string(),
            None => continue,
        };
        out.push(TextEvent { time_us: t as u64, text });
    }
    Ok(out)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisRowState {
    pub message_type: String,
    pub field: String,
    pub visible: bool,
    /// Row height in pixels, from the row's own resize handle. `None`
    /// keeps whatever default the frontend uses for a row that's never
    /// been resized.
    pub height: Option<f64>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisFileState {
    /// Order in the array is display order — no separate `position` field
    /// needed, reordering just means writing a differently-ordered array.
    pub rows: Vec<AnalysisRowState>,
    pub start_us: Option<u64>,
    pub end_us: Option<u64>,
}

/// The sidecar path for a log at `path` — `00000021.bin` alongside
/// `00000021.bin.analysis.json`, so the two stay associated just by sitting
/// next to each other rather than needing a separate index to relate them.
/// The whole file name is kept rather than the extension swapped because the
/// Logs page's Open… takes a log from anywhere on disk, where a `flight.json`
/// beside `flight.bin` may well be someone else's file.
fn sidecar_path(path: &str) -> PathBuf {
    let mut name = PathBuf::from(path).into_os_string();
    name.push(".analysis.json");
    PathBuf::from(name)
}

/// Where `sidecar_path` used to point — `00000021.json`. Still read so state
/// saved before the rename isn't lost; never written.
fn legacy_sidecar_path(path: &str) -> PathBuf {
    let mut p = PathBuf::from(path);
    p.set_extension("json");
    p
}

/// Reads the saved analysis state for the log at `path` — which rows were
/// on the timeline, their order/visibility/height, and the last-viewed
/// time window. `None` if nothing's been saved for it yet (a log opened
/// for the first time), not an error.
#[tauri::command]
pub fn load_analysis_state(path: String) -> Result<Option<AnalysisFileState>, String> {
    let sidecar = sidecar_path(&path);
    if sidecar.exists() {
        let content = std::fs::read_to_string(&sidecar).map_err(|e| e.to_string())?;
        return serde_json::from_str(&content).map(Some).map_err(|e| e.to_string());
    }
    // A legacy-named file that doesn't parse is someone else's JSON, not
    // broken state of ours — treated as nothing saved.
    let legacy = legacy_sidecar_path(&path);
    Ok(std::fs::read_to_string(&legacy).ok().and_then(|content| serde_json::from_str(&content).ok()))
}

#[tauri::command]
pub fn save_analysis_state(path: String, state: AnalysisFileState) -> Result<(), String> {
    let sidecar = sidecar_path(&path);
    let content = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
    std::fs::write(&sidecar, content).map_err(|e| e.to_string())
}
