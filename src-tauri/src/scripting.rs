use std::{
    fs,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use mavlink::{
    dialects::ardupilotmega::{FILE_TRANSFER_PROTOCOL_DATA, MavMessage},
    MavConnection,
};
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;

use crate::link::LinkState;

// --- Local: $APPDATA/scripts ---

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEntry {
    pub name: String,
    pub is_dir: bool,
}

fn scripts_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("scripts");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn vehicle_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("vehicle_scripts");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn resolve_vehicle_cache_path(app: &AppHandle, relative: &str) -> Result<PathBuf, String> {
    validate_relative_path(relative)?;
    let mut resolved = vehicle_cache_dir(app)?;
    for component in Path::new(relative).components() {
        resolved.push(component);
    }
    Ok(resolved)
}

fn sync_vehicle_dir<'a>(
    app: &'a AppHandle,
    connection: &'a Arc<dyn MavConnection<MavMessage> + Send + Sync>,
    target: (u8, u8),
    relative: String,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
    Box::pin(async move {
        let entries = list_vehicle_dir_inner(app, relative.clone()).await?;
        for entry in entries {
            let child = if relative.is_empty() { entry.name.clone() } else { format!("{relative}/{}", entry.name) };
            let cache_path = resolve_vehicle_cache_path(app, &child)?;
            if entry.is_dir {
                fs::create_dir_all(&cache_path).map_err(|e| e.to_string())?;
                sync_vehicle_dir(app, connection, target, child).await?;
            } else {
                let bytes = read_vehicle_file_bytes(app, connection, target, &child).await?;
                fs::write(&cache_path, bytes).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    })
}

/// Every path this module accepts from the frontend is relative and
/// forward-slash separated (`"utils/helper.lua"`, `""` for a root). This is
/// the one check every one of them goes through before touching a real
/// filesystem or being embedded in an FTP request: only "normal" components
/// allowed — no `..`, no drive prefixes, no root anchors — so nothing can
/// walk outside the tree it was handed for.
fn validate_relative_path(relative: &str) -> Result<(), String> {
    for component in Path::new(relative).components() {
        if !matches!(component, Component::Normal(_)) {
            return Err("invalid path".to_string());
        }
    }
    Ok(())
}

fn resolve_local_path(app: &AppHandle, relative: &str) -> Result<PathBuf, String> {
    validate_relative_path(relative)?;
    let mut resolved = scripts_dir(app)?;
    for component in Path::new(relative).components() {
        resolved.push(component);
    }
    Ok(resolved)
}

#[tauri::command]
pub fn list_local_dir(app: AppHandle, path: String) -> Result<Vec<LocalEntry>, String> {
    let dir = resolve_local_path(&app, &path)?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let is_dir = entry.metadata().map_err(|e| e.to_string())?.is_dir();
        entries.push(LocalEntry {name: entry.file_name().to_string_lossy().to_string(), is_dir});
    }
    Ok(entries)
}

#[tauri::command]
pub fn read_local_file(app: AppHandle, path: String) -> Result<String, String> {
    fs::read_to_string(resolve_local_path(&app, &path)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_local_file(app: AppHandle, path: String, content: String) -> Result<(), String> {
    fs::write(resolve_local_path(&app, &path)?, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_local_file(app: AppHandle, path: String) -> Result<(), String> {
    let resolved = resolve_local_path(&app, &path)?;
    if resolved.exists() {
        return Err("already exists".to_string());
    }
    fs::write(resolved, "").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_local_dir(app: AppHandle, path: String) -> Result<(), String> {
    let resolved = resolve_local_path(&app, &path)?;
    if resolved.exists() {
        return Err("already exists".to_string());
    }
    fs::create_dir(resolved).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_local(app: AppHandle, path: String) -> Result<(), String> {
    let resolved = resolve_local_path(&app, &path)?;
    if resolved.is_dir() {
        fs::remove_dir_all(resolved).map_err(|e| e.to_string())
    } else {
        fs::remove_file(resolved).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn rename_local(app: AppHandle, old_path: String, new_path: String, overwrite: bool) -> Result<(), String> {
    let old_resolved = resolve_local_path(&app, &old_path)?;
    let new_resolved = resolve_local_path(&app, &new_path)?;
    if new_resolved.exists() {
        if !overwrite || new_resolved.is_dir() {
            return Err("already exists".to_string());
        }
        fs::remove_file(&new_resolved).map_err(|e| e.to_string())?;
    }
    fs::rename(old_resolved, new_resolved).map_err(|e| e.to_string())
}

// --- MAVLink FTP: /APM/scripts on the vehicle ---
// Protocol: https://mavlink.io/en/services/ftp.html
// `list_vehicle_dir`'s entry parsing and `rename_vehicle`'s two-path payload
// are the two pieces here assembled from protocol memory rather than tested
// against firmware — verify against SITL before trusting either.

const FTP_OP_TERMINATE_SESSION: u8 = 1;
const FTP_OP_LIST_DIRECTORY: u8 = 3;
const FTP_OP_OPEN_FILE_RO: u8 = 4;
const FTP_OP_READ_FILE: u8 = 5;
const FTP_OP_CREATE_FILE: u8 = 6;
const FTP_OP_WRITE_FILE: u8 = 7;
const FTP_OP_REMOVE_FILE: u8 = 8;
const FTP_OP_CREATE_DIRECTORY: u8 = 9;
const FTP_OP_REMOVE_DIRECTORY: u8 = 10;
const FTP_OP_RENAME: u8 = 13;
const FTP_OP_ACK: u8 = 128;
const FTP_OP_NAK: u8 = 129;
const FTP_ERROR_EOF: u8 = 6;
const FTP_MAX_DATA_LEN: usize = 239;
const FTP_TIMEOUT: Duration = Duration::from_secs(2);
const VEHICLE_ROOT: &str = "/APM/scripts";
const FTP_ERROR_FILE_EXISTS: u8 = 8;
const FTP_ERROR_FILE_NOT_FOUND: u8 = 10;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VehicleEntry {
    pub name: String,
    pub is_dir: bool,
}

struct FtpRequest {
    seq_number: u16,
    session: u8,
    opcode: u8,
    offset: u32,
    data: Vec<u8>,
}

impl FtpRequest {
    /// Packs the 12-byte FTP header (seq, session, opcode, size, offset) plus
    /// `data` into the message's fixed 251-byte payload.
    fn encode(&self) -> [u8; 251] {
        let mut payload = [0u8; 251];
        payload[0..2].copy_from_slice(&self.seq_number.to_le_bytes());
        payload[2] = self.session;
        payload[3] = self.opcode;
        payload[4] = self.data.len() as u8;
        payload[8..12].copy_from_slice(&self.offset.to_le_bytes());
        payload[12..12 + self.data.len()].copy_from_slice(&self.data);
        payload
    }
}

struct FtpReply {
    opcode: u8,
    /// The opcode of the request this replies to — how a reply is matched to
    /// what was asked, since `on_ftp_reply` has no other context to go on.
    req_opcode: u8,
    session: u8,
    data: Vec<u8>,
}

impl FtpReply {
    fn decode(payload: &[u8; 251]) -> Self {
        let size = (payload[4] as usize).min(FTP_MAX_DATA_LEN);
        FtpReply {
            session: payload[2],
            opcode: payload[3],
            req_opcode: payload[5],
            data: payload[12..12 + size].to_vec(),
        }
    }
}

/// One outstanding FTP request at a time — this client never pipelines
/// requests, so a single slot is enough. `busy` guards the whole multi-request
/// operations (upload, download, a paginated directory listing) built on top
/// of that one slot, so two of them can't race on it.
#[derive(Default)]
pub struct FtpState {
    pending: Mutex<Option<oneshot::Sender<FtpReply>>>,
    busy: Mutex<bool>,
    next_seq: std::sync::atomic::AtomicU16,
}

fn next_seq(app: &AppHandle) -> u16 {
    app.state::<FtpState>().next_seq.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// Every `FILE_TRANSFER_PROTOCOL` reply lands here, the same way
/// `commands::on_ack` handles `COMMAND_ACK` — wire this into `dispatch.rs`.
pub fn on_ftp_reply(app: &AppHandle, data: &FILE_TRANSFER_PROTOCOL_DATA) {
    let reply = FtpReply::decode(&data.payload);
    if let Some(sender) = app.state::<FtpState>().pending.lock().unwrap_or_else(|e| e.into_inner()).take() {
        let _ = sender.send(reply);
    }
}

async fn send_ftp_request(
    app: &AppHandle,
    connection: &Arc<dyn MavConnection<MavMessage> + Send + Sync>,
    target: (u8, u8),
    request: &FtpRequest,
) -> Result<FtpReply, String> {
    let (tx, rx) = oneshot::channel();
    *app.state::<FtpState>().pending.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx);

    eprintln!(
        "FTP -> opcode={} session={} offset={} seq={} data={:?}",
        request.opcode, request.session, request.offset, request.seq_number, request.data
    );

    let _ = connection.send_default(&MavMessage::FILE_TRANSFER_PROTOCOL(FILE_TRANSFER_PROTOCOL_DATA {
        target_network: 0,
        target_system: target.0,
        target_component: target.1,
        payload: request.encode(),
    }));

    let reply = tokio::time::timeout(FTP_TIMEOUT, rx)
        .await
        .map_err(|_| "vehicle didn't respond (FTP timeout)".to_string())?
        .map_err(|_| "connection reset mid-transfer".to_string())?;

    eprintln!(
        "FTP <- opcode={} req_opcode={} session={} data={:?}",
        reply.opcode, reply.req_opcode, reply.session, reply.data
    );

    if reply.req_opcode != request.opcode || (reply.opcode != FTP_OP_ACK && reply.opcode != FTP_OP_NAK) {
        return Err("unexpected FTP response from vehicle".to_string());
    }
    Ok(reply)
}

fn nak_code(reply: &FtpReply) -> Option<u8> {
    (reply.opcode == FTP_OP_NAK).then(|| reply.data.first().copied().unwrap_or(0))
}

/// For requests where any Nak is a hard failure — everything except
/// `list_vehicle_dir` and the read loop in `download_vehicle_file_inner`,
/// which use EOF (a specific Nak code) as a normal end-of-data signal.
fn expect_ack(reply: FtpReply) -> Result<FtpReply, String> {
    if let Some(code) = nak_code(&reply) {
        return Err(format!("vehicle rejected the request (FTP error {code})"));
    }
    Ok(reply)
}

fn vehicle_link(app: &AppHandle) -> Result<(Arc<dyn MavConnection<MavMessage> + Send + Sync>, (u8, u8)), String> {
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
    Ok((connection, target))
}

fn vehicle_path(relative: &str) -> String {
    if relative.is_empty() {
        VEHICLE_ROOT.to_string()
    } else {
        format!("{VEHICLE_ROOT}/{relative}")
    }
}

async fn ensure_vehicle_root(
    app: &AppHandle,
    connection: &Arc<dyn MavConnection<MavMessage> + Send + Sync>,
    target: (u8, u8),
) -> Result<(), String> {
    let mut path = String::new();
    for component in VEHICLE_ROOT.split('/').filter(|c| !c.is_empty()) {
        path.push('/');
        path.push_str(component);
        let request = FtpRequest {
            seq_number: next_seq(app),
            session: 0,
            opcode: FTP_OP_CREATE_DIRECTORY,
            offset: 0,
            data: path.clone().into_bytes(),
        };
        let reply = send_ftp_request(app, connection, target, &request).await?;
        match nak_code(&reply) {
            None | Some(FTP_ERROR_FILE_EXISTS) => {}
            Some(code) => return Err(format!("couldn't prepare the scripts folder on the vehicle (FTP error {code})")),
        }
    }
    Ok(())
}

pub async fn list_vehicle_dir_inner(app: &AppHandle, path: String) -> Result<Vec<VehicleEntry>, String> {
    validate_relative_path(&path)?;
    let (connection, target) = vehicle_link(&app)?;
    let remote_dir = vehicle_path(&path);

    let mut entries = Vec::new();
    let mut offset: u32 = 0;

    loop {
        let request = FtpRequest {
            seq_number: next_seq(app),
            session: 0,
            opcode: FTP_OP_LIST_DIRECTORY,
            offset,
            data: remote_dir.clone().into_bytes(),
        };
        let reply = send_ftp_request(&app, &connection, target, &request).await?;

        if let Some(code) = nak_code(&reply) {
            if code == FTP_ERROR_EOF || code == FTP_ERROR_FILE_NOT_FOUND {
                break;
            }
            return Err(format!("vehicle rejected the directory listing (FTP error {code})"));
        }

        // Entries are NUL-separated, each prefixed with a type character:
        // 'D' for a subdirectory, 'F' for a file (name and size, tab
        // separated — the size is discarded here, the tree doesn't show it).
        // Anything else is skipped rather than treated as an error.
        let mut received = 0;
        for raw in reply.data.split(|&b| b == 0) {
            if raw.is_empty() {
                continue;
            }
            received += 1;
            let Ok(text) = std::str::from_utf8(raw) else { continue };
            let Some((prefix, rest)) = text.split_at_checked(1) else { continue };
            match prefix {
                "D" if rest != "." && rest != ".." => entries.push(VehicleEntry {name: rest.to_string(), is_dir: true}),
                "F" => {
                    let name = rest.split('\t').next().unwrap_or(rest);
                    entries.push(VehicleEntry {name: name.to_string(), is_dir: false});
                }
                _ => {}
            }
        }

        if received == 0 {
            break;
        }
        offset += received as u32;
    }

    Ok(entries)
}

async fn upload_to_vehicle_inner(app: &AppHandle, local_path: &str, remote_path: &str) -> Result<(), String> {
    validate_relative_path(remote_path)?;
    let bytes = fs::read(resolve_local_path(app, local_path)?).map_err(|e| e.to_string())?;
    let (connection, target) = vehicle_link(app)?;
    ensure_vehicle_root(app, &connection, target).await?;
    write_vehicle_file_bytes(app, &connection, target, remote_path, bytes).await
}

async fn download_vehicle_file_inner(app: &AppHandle, remote_path: &str, local_path: &str) -> Result<(), String> {
    validate_relative_path(remote_path)?;
    let resolved_local = resolve_local_path(app, local_path)?;
    if resolved_local.exists() {
        return Err("already exists locally".to_string());
    }
    let (connection, target) = vehicle_link(app)?;
    let bytes = read_vehicle_file_bytes(app, &connection, target, remote_path).await?;
    fs::write(resolved_local, bytes).map_err(|e| e.to_string())
}

async fn read_vehicle_file_bytes(
    app: &AppHandle,
    connection: &Arc<dyn MavConnection<MavMessage> + Send + Sync>,
    target: (u8, u8),
    remote_path: &str,
) -> Result<Vec<u8>, String> {
    let open = FtpRequest {
        seq_number: next_seq(app),
        session: 0,
        opcode: FTP_OP_OPEN_FILE_RO,
        offset: 0,
        data: vehicle_path(remote_path).into_bytes(),
    };
    let reply = expect_ack(send_ftp_request(app, connection, target, &open).await?)?;
    let session = reply.session;

    let mut bytes = Vec::new();
    let mut offset: u32 = 0;
    loop {
        let read = FtpRequest {
            seq_number: next_seq(app),
            session,
            opcode: FTP_OP_READ_FILE,
            offset,
            data: vec![0u8; FTP_MAX_DATA_LEN],
        };
        let reply = send_ftp_request(app, connection, target, &read).await?;

        if let Some(code) = nak_code(&reply) {
            if code == FTP_ERROR_EOF {
                break;
            }
            return Err(format!("vehicle rejected the read (FTP error {code})"));
        }
        if reply.data.is_empty() {
            break;
        }
        offset += reply.data.len() as u32;
        bytes.extend(reply.data);
    }

    let terminate = FtpRequest {seq_number: next_seq(app), session, opcode: FTP_OP_TERMINATE_SESSION, offset: 0, data: Vec::new()};
    let _ = send_ftp_request(app, connection, target, &terminate).await;

    Ok(bytes)
}

async fn read_vehicle_file_inner(app: &AppHandle, path: String) -> Result<String, String> {
    validate_relative_path(&path)?;
    let (connection, target) = vehicle_link(app)?;
    let bytes = read_vehicle_file_bytes(app, &connection, target, &path).await?;
    String::from_utf8(bytes).map_err(|_| "file is not valid UTF-8 text".to_string())
}

async fn write_vehicle_file_inner(app: &AppHandle, path: String, content: String) -> Result<(), String> {
    validate_relative_path(&path)?;
    let (connection, target) = vehicle_link(app)?;
    ensure_vehicle_root(app, &connection, target).await?;
    write_vehicle_file_bytes(app, &connection, target, &path, content.into_bytes()).await
}

async fn write_vehicle_file_bytes(
    app: &AppHandle,
    connection: &Arc<dyn MavConnection<MavMessage> + Send + Sync>,
    target: (u8, u8),
    remote_path: &str,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let create = FtpRequest {
        seq_number: next_seq(app),
        session: 0,
        opcode: FTP_OP_CREATE_FILE,
        offset: 0,
        data: vehicle_path(remote_path).into_bytes(),
    };
    let reply = expect_ack(send_ftp_request(app, connection, target, &create).await?)?;
    let session = reply.session;

    let mut offset: u32 = 0;
    for chunk in bytes.chunks(FTP_MAX_DATA_LEN) {
        let write = FtpRequest {
            seq_number: next_seq(app),
            session,
            opcode: FTP_OP_WRITE_FILE,
            offset,
            data: chunk.to_vec(),
        };
        expect_ack(send_ftp_request(app, connection, target, &write).await?)?;
        offset += chunk.len() as u32;
    }

    let terminate = FtpRequest {seq_number: next_seq(app), session, opcode: FTP_OP_TERMINATE_SESSION, offset: 0, data: Vec::new()};
    let _ = send_ftp_request(app, connection, target, &terminate).await;
    Ok(())
}

pub async fn create_vehicle_dir_inner(app: &AppHandle, path: String) -> Result<(), String>  {
    validate_relative_path(&path)?;
    let (connection, target) = vehicle_link(&app)?;
    ensure_vehicle_root(&app, &connection, target).await?;
    let request = FtpRequest {seq_number: next_seq(app), session: 0, opcode: FTP_OP_CREATE_DIRECTORY, offset: 0, data: vehicle_path(&path).into_bytes()};
    expect_ack(send_ftp_request(&app, &connection, target, &request).await?)?;
    Ok(())
}

pub async fn create_vehicle_file_inner(app: &AppHandle, path: String) -> Result<(), String> {
    validate_relative_path(&path)?;
    let (connection, target) = vehicle_link(&app)?;
    ensure_vehicle_root(&app, &connection, target).await?;
    let create = FtpRequest {seq_number: next_seq(app), session: 0, opcode: FTP_OP_CREATE_FILE, offset: 0, data: vehicle_path(&path).into_bytes()};
    let reply = expect_ack(send_ftp_request(&app, &connection, target, &create).await?)?;
    let terminate = FtpRequest {seq_number: next_seq(app), session: reply.session, opcode: FTP_OP_TERMINATE_SESSION, offset: 0, data: Vec::new()};
    let _ = send_ftp_request(&app, &connection, target, &terminate).await;
    Ok(())
}

pub async fn delete_vehicle_inner(app: &AppHandle, path: String, is_dir: bool) -> Result<(), String> {
    validate_relative_path(&path)?;
    let (connection, target) = vehicle_link(&app)?;
    let opcode = if is_dir { FTP_OP_REMOVE_DIRECTORY } else { FTP_OP_REMOVE_FILE };
    let request = FtpRequest {seq_number: next_seq(app), session: 0, opcode, offset: 0, data: vehicle_path(&path).into_bytes()};
    expect_ack(send_ftp_request(&app, &connection, target, &request).await?)?;
    Ok(())
}

pub async fn rename_vehicle_inner(app: &AppHandle, old_path: String, new_path: String) -> Result<(), String> {
    validate_relative_path(&old_path)?;
    validate_relative_path(&new_path)?;
    let (connection, target) = vehicle_link(&app)?;
    // Rename's request data is both paths, NUL-separated, in one payload.
    let mut data = vehicle_path(&old_path).into_bytes();
    data.push(0);
    data.extend(vehicle_path(&new_path).into_bytes());
    let request = FtpRequest {seq_number: next_seq(app), session: 0, opcode: FTP_OP_RENAME, offset: 0, data};
    expect_ack(send_ftp_request(&app, &connection, target, &request).await?)?;
    Ok(())
}

async fn with_ftp_lock<T>(app: &AppHandle, op: impl std::future::Future<Output = Result<T, String>>) -> Result<T, String> {
    {
        let state = app.state::<FtpState>();
        let mut busy = state.busy.lock().unwrap_or_else(|e| e.into_inner());
        if *busy {
            return Err("another file transfer is already in progress".to_string());
        }
        *busy = true;
    }
    let result = op.await;
    *app.state::<FtpState>().busy.lock().unwrap_or_else(|e| e.into_inner()) = false;
    result
}
#[tauri::command]
pub fn list_vehicle_dir(app: AppHandle, path: String) -> Result<Vec<VehicleEntry>, String> {
    let dir = resolve_vehicle_cache_path(&app, &path)?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let is_dir = entry.metadata().map_err(|e| e.to_string())?.is_dir();
        entries.push(VehicleEntry {name: entry.file_name().to_string_lossy().to_string(), is_dir});
    }
    Ok(entries)
}

#[tauri::command]
pub fn read_vehicle_file(app: AppHandle, path: String) -> Result<String, String> {
    fs::read_to_string(resolve_vehicle_cache_path(&app, &path)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn write_vehicle_file(app: AppHandle, path: String, content: String) -> Result<(), String> {
    with_ftp_lock(&app, write_vehicle_file_inner(&app, path.clone(), content.clone())).await?;
    fs::write(resolve_vehicle_cache_path(&app, &path)?, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_vehicle_file(app: AppHandle, path: String) -> Result<(), String> {
    let cache_path = resolve_vehicle_cache_path(&app, &path)?;
    if cache_path.exists() {
        return Err("already exists".to_string());
    }
    with_ftp_lock(&app, create_vehicle_file_inner(&app, path.clone())).await?;
    fs::write(cache_path, "").map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_vehicle_dir(app: AppHandle, path: String) -> Result<(), String> {
    let cache_path = resolve_vehicle_cache_path(&app, &path)?;
    if cache_path.exists() {
        return Err("already exists".to_string());
    }
    with_ftp_lock(&app, create_vehicle_dir_inner(&app, path.clone())).await?;
    fs::create_dir(cache_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_vehicle(app: AppHandle, path: String, is_dir: bool) -> Result<(), String> {
    with_ftp_lock(&app, delete_vehicle_inner(&app, path.clone(), is_dir)).await?;
    let cache_path = resolve_vehicle_cache_path(&app, &path)?;
    if is_dir { fs::remove_dir_all(cache_path) } else { fs::remove_file(cache_path) }.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rename_vehicle(app: AppHandle, old_path: String, new_path: String, overwrite: bool) -> Result<(), String> {
    let new_cache_path = resolve_vehicle_cache_path(&app, &new_path)?;
    if new_cache_path.exists() && (!overwrite || new_cache_path.is_dir()) {
        return Err("already exists".to_string());
    }
    let existed = new_cache_path.exists();
    with_ftp_lock(&app, async {
        if existed {
            delete_vehicle_inner(&app, new_path.clone(), false).await?;
        }
        rename_vehicle_inner(&app, old_path.clone(), new_path.clone()).await
    })
        .await?;
    if existed {
        fs::remove_file(&new_cache_path).map_err(|e| e.to_string())?;
    }
    fs::rename(resolve_vehicle_cache_path(&app, &old_path)?, new_cache_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn upload_to_vehicle(app: AppHandle, local_path: String, remote_path: String) -> Result<(), String> {
    with_ftp_lock(&app, upload_to_vehicle_inner(&app, &local_path, &remote_path)).await?;
    let bytes = fs::read(resolve_local_path(&app, &local_path)?).map_err(|e| e.to_string())?;
    fs::write(resolve_vehicle_cache_path(&app, &remote_path)?, bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn download_vehicle_file(app: AppHandle, remote_path: String, local_path: String, overwrite: bool) -> Result<(), String> {
    let resolved_local = resolve_local_path(&app, &local_path)?;
    if resolved_local.exists() && (!overwrite || resolved_local.is_dir()) {
        return Err("already exists locally".to_string());
    }
    let bytes = fs::read(resolve_vehicle_cache_path(&app, &remote_path)?).map_err(|e| e.to_string())?;
    fs::write(resolved_local, bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn absolute_local_path(app: AppHandle, path: String) -> Result<String, String> {
    Ok(resolve_local_path(&app, &path)?.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn sync_vehicle_scripts(app: AppHandle) -> Result<(), String> {
    with_ftp_lock(&app, async {
        let cache = vehicle_cache_dir(&app)?;
        let _ = fs::remove_dir_all(&cache);
        fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
        let (connection, target) = vehicle_link(&app)?;
        ensure_vehicle_root(&app, &connection, target).await?;
        sync_vehicle_dir(&app, &connection, target, String::new()).await
    }).await
}

#[tauri::command]
pub fn clear_vehicle_cache(app: AppHandle) -> Result<(), String> {
    let _ = fs::remove_dir_all(vehicle_cache_dir(&app)?);
    Ok(())
}

#[tauri::command]
pub fn absolute_vehicle_path(app: AppHandle, path: String) -> Result<String, String> {
    Ok(resolve_vehicle_cache_path(&app, &path)?.to_string_lossy().to_string())
}