//! The control server `aetherius-cli` talks to.
//!
//! While Settings › CLI › CLI access is on, the app listens on 127.0.0.1 and
//! writes the port and a fresh token to `cli.json` in its data folder. Each
//! CLI invocation is one request: it's recorded (`requests.rs`), shown in the
//! CLI panel through `cli-activity` events, checked against the permission
//! settings (`ctx.rs`), and carried out over the app's own vehicle link by a
//! handler (`handlers/`). Commands, categories and reply shapes come from the
//! shared catalog in the `aetherius-cli` crate.

pub mod console;
mod ctx;
mod handlers;
mod metadata;
mod modes;
mod requests;
mod server;

use std::sync::{atomic::{AtomicBool, Ordering}, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

pub use requests::Registry;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Policy {
    Allow,
    Ask,
    Block,
}

impl Policy {
    pub fn key(self) -> &'static str {
        match self {
            Policy::Allow => "allow",
            Policy::Ask => "ask",
            Policy::Block => "block",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    pub reads: Policy,
    pub logs: Policy,
    pub params: Policy,
    pub scripts: Policy,
    pub reboot: Policy,
    pub while_armed: Policy,
}

impl Default for Permissions {
    fn default() -> Self {
        Permissions {
            reads: Policy::Allow,
            logs: Policy::Allow,
            params: Policy::Ask,
            scripts: Policy::Ask,
            reboot: Policy::Ask,
            while_armed: Policy::Block,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliSettings {
    pub enabled: bool,
    pub permissions: Permissions,
    /// Days of request history to keep on disk; `0` keeps it forever.
    pub history_days: u32,
}

#[derive(Default)]
pub struct CliState {
    settings: Mutex<CliSettings>,
    server: Mutex<Option<server::ServerHandle>>,
    paused: AtomicBool,
    pub registry: Registry,
    pub console: console::Buffer,
}

impl CliState {
    pub fn settings(&self) -> CliSettings {
        self.settings.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    pub enabled: bool,
    pub listening: bool,
    pub port: Option<u16>,
    pub paused: bool,
    pub error: Option<String>,
}

fn status(app: &AppHandle, error: Option<String>) -> CliStatus {
    let state = app.state::<CliState>();
    let server = state.server.lock().unwrap_or_else(|e| e.into_inner());
    CliStatus {
        enabled: state.settings().enabled,
        listening: server.is_some(),
        port: server.as_ref().map(|s| s.port()),
        paused: state.paused(),
        error,
    }
}

fn publish_status(app: &AppHandle, error: Option<String>) {
    let _ = app.emit("cli-status", status(app, error));
}

/// Where request history is kept.
pub fn history_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("cli"))
}

/// Applies the CLI settings from the frontend: starts or stops the server
/// and prunes old history.
#[tauri::command]
pub fn set_cli_settings(app: AppHandle, settings: CliSettings) -> CliStatus {
    let state = app.state::<CliState>();
    let enabled = settings.enabled;
    let history_days = settings.history_days;
    *state.settings.lock().unwrap_or_else(|e| e.into_inner()) = settings;

    let mut error = None;
    {
        let mut server = state.server.lock().unwrap_or_else(|e| e.into_inner());
        match (enabled, server.is_some()) {
            (true, false) => match server::start(&app) {
                Ok(handle) => *server = Some(handle),
                Err(e) => error = Some(e),
            },
            (false, true) => {
                if let Some(handle) = server.take() {
                    handle.stop(&app);
                }
            }
            _ => {}
        }
    }
    if let Ok(dir) = history_dir(&app) {
        requests::prune_history(&dir, history_days);
    }
    publish_status(&app, error.clone());
    status(&app, error)
}

#[tauri::command]
pub fn cli_status(app: AppHandle) -> CliStatus {
    status(&app, None)
}

/// Every request this session, oldest first, for the panel to start from.
#[tauri::command]
pub fn cli_requests(app: AppHandle) -> Vec<requests::Record> {
    app.state::<CliState>().registry.all()
}

/// Approve or reject a waiting request.
#[tauri::command]
pub fn cli_resolve(app: AppHandle, id: String, approve: bool) -> Result<(), String> {
    app.state::<CliState>().registry.decide(&id, approve)
}

/// Stop a waiting or running request.
#[tauri::command]
pub fn cli_stop(app: AppHandle, id: String) -> Result<(), String> {
    app.state::<CliState>().registry.request_stop(&id)
}

#[tauri::command]
pub fn cli_set_paused(app: AppHandle, paused: bool) {
    app.state::<CliState>().paused.store(paused, Ordering::SeqCst);
    publish_status(&app, None);
}

/// Forgets finished requests from the panel. History on disk is kept.
#[tauri::command]
pub fn cli_clear(app: AppHandle) {
    app.state::<CliState>().registry.clear_finished(&app);
}

#[tauri::command]
pub fn cli_history_dir(app: AppHandle) -> Result<String, String> {
    let dir = history_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}
