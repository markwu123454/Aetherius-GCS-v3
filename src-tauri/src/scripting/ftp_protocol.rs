use std::{
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
use super::local_fs::validate_relative_path;

// MAVLink FTP: /APM/scripts on the vehicle.
// Protocol: https://mavlink.io/en/services/ftp.html
// `list_vehicle_dir_inner`'s entry parsing and `rename_vehicle_inner`'s
// two-path payload are the two pieces here assembled from protocol memory
// rather than tested against firmware — verify against SITL before trusting
// either.

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
/// `commands::on_ack` handles `COMMAND_ACK` — wired in from `dispatch.rs`.
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

    if reply.req_opcode != request.opcode || (reply.opcode != FTP_OP_ACK && reply.opcode != FTP_OP_NAK) {
        return Err("unexpected FTP response from vehicle".to_string());
    }
    Ok(reply)
}

fn nak_code(reply: &FtpReply) -> Option<u8> {
    (reply.opcode == FTP_OP_NAK).then(|| reply.data.first().copied().unwrap_or(0))
}

/// For requests where any Nak is a hard failure — everything except
/// `list_vehicle_dir_inner` and the read loop in `read_vehicle_file_bytes`,
/// which use EOF (a specific Nak code) as a normal end-of-data signal.
fn expect_ack(reply: FtpReply) -> Result<FtpReply, String> {
    if let Some(code) = nak_code(&reply) {
        return Err(format!("vehicle rejected the request (FTP error {code})"));
    }
    Ok(reply)
}

pub(super) fn vehicle_link(app: &AppHandle) -> Result<(Arc<dyn MavConnection<MavMessage> + Send + Sync>, (u8, u8)), String> {
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

pub(super) async fn ensure_vehicle_root(
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

pub(super) async fn list_vehicle_dir_inner(app: &AppHandle, path: String) -> Result<Vec<VehicleEntry>, String> {
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

pub(super) async fn read_vehicle_file_bytes(
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

pub(super) async fn write_vehicle_file_inner(app: &AppHandle, path: String, content: String) -> Result<(), String> {
    validate_relative_path(&path)?;
    let (connection, target) = vehicle_link(app)?;
    ensure_vehicle_root(app, &connection, target).await?;
    write_vehicle_file_bytes(app, &connection, target, &path, content.into_bytes()).await
}

pub(super) async fn write_vehicle_file_bytes(
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

pub(super) async fn create_vehicle_dir_inner(app: &AppHandle, path: String) -> Result<(), String> {
    validate_relative_path(&path)?;
    let (connection, target) = vehicle_link(&app)?;
    ensure_vehicle_root(&app, &connection, target).await?;
    let request = FtpRequest {seq_number: next_seq(app), session: 0, opcode: FTP_OP_CREATE_DIRECTORY, offset: 0, data: vehicle_path(&path).into_bytes()};
    expect_ack(send_ftp_request(&app, &connection, target, &request).await?)?;
    Ok(())
}

pub(super) async fn create_vehicle_file_inner(app: &AppHandle, path: String) -> Result<(), String> {
    validate_relative_path(&path)?;
    let (connection, target) = vehicle_link(&app)?;
    ensure_vehicle_root(&app, &connection, target).await?;
    let create = FtpRequest {seq_number: next_seq(app), session: 0, opcode: FTP_OP_CREATE_FILE, offset: 0, data: vehicle_path(&path).into_bytes()};
    let reply = expect_ack(send_ftp_request(&app, &connection, target, &create).await?)?;
    let terminate = FtpRequest {seq_number: next_seq(app), session: reply.session, opcode: FTP_OP_TERMINATE_SESSION, offset: 0, data: Vec::new()};
    let _ = send_ftp_request(&app, &connection, target, &terminate).await;
    Ok(())
}

pub(super) async fn delete_vehicle_inner(app: &AppHandle, path: String, is_dir: bool) -> Result<(), String> {
    validate_relative_path(&path)?;
    let (connection, target) = vehicle_link(&app)?;
    let opcode = if is_dir { FTP_OP_REMOVE_DIRECTORY } else { FTP_OP_REMOVE_FILE };
    let request = FtpRequest {seq_number: next_seq(app), session: 0, opcode, offset: 0, data: vehicle_path(&path).into_bytes()};
    expect_ack(send_ftp_request(&app, &connection, target, &request).await?)?;
    Ok(())
}

pub(super) async fn rename_vehicle_inner(app: &AppHandle, old_path: String, new_path: String) -> Result<(), String> {
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

pub(super) async fn with_ftp_lock<T>(app: &AppHandle, op: impl std::future::Future<Output = Result<T, String>>) -> Result<T, String> {
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