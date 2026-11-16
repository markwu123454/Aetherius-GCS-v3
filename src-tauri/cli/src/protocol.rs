//! The wire protocol between `aetherius-cli` and the app.
//!
//! One TCP connection per command, to `127.0.0.1` on the port the app writes
//! to its discovery file. Both directions are JSON lines: the CLI sends one
//! `Request` line first, the app answers with a stream of `Event` lines that
//! ends with exactly one `end` (or `pending`) event. Long-running commands
//! (`script push --watch`) keep the connection open and the CLI sends further
//! `ClientMessage` lines on it.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Bumped whenever a request or event changes shape. The app refuses a CLI
/// speaking a different protocol with `version_mismatch`.
pub const PROTOCOL: u32 = 1;

/// The app's Tauri identifier — the name of its folder under `%APPDATA%`.
pub const APP_IDENTIFIER: &str = "com.markw.aetherius-gcs-v3";

/// Written by the app into its data folder while CLI access is on.
pub const DISCOVERY_FILE: &str = "cli.json";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    pub port: u16,
    pub token: String,
    pub pid: u32,
    pub app_version: String,
    pub protocol: u32,
}

/// The first line the CLI sends.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub protocol: u32,
    pub token: String,
    /// The command's catalog name, e.g. `params set`.
    pub command: String,
    /// Parsed arguments, keyed by each argument's `key` in the catalog.
    pub args: serde_json::Map<String, Value>,
    /// The command line as typed, for the panel.
    pub argv: String,
    /// The folder the CLI ran in.
    pub cwd: String,
    /// The CLI's own process and its parents, nearest first
    /// (`["aetherius-cli.exe", "pwsh.exe", "claude.exe"]`). A hint for telling
    /// callers apart in the panel, not an identity.
    pub process: Vec<String>,
    /// How far the caller's local time is ahead of UTC, so replies can show
    /// wall-clock times the way the caller would read them.
    pub utc_offset_minutes: i32,
    /// Seconds to wait for approval; `0` waits forever.
    pub timeout_secs: u64,
    /// Return as soon as the request is waiting for approval, leaving it
    /// running in the app.
    pub no_wait: bool,
    pub cli_version: String,
}

/// Lines the CLI may send after the request, on commands that stay open.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum ClientMessage {
    /// `script push --watch`: a file changed and should be pushed.
    Push { file: String, content_base64: String },
    /// The caller wants a streaming command to finish (Ctrl+C).
    Stop,
}

/// Every line the app sends.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "event")]
pub enum Event {
    /// The request was received and given an id.
    Accepted { request: String },
    /// The request is waiting for approval, held (paused, or armed), or running.
    State {
        state: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    /// Progress of a long step, for stderr.
    Progress { data: Value },
    /// One item of a streaming command.
    Item { data: Value },
    /// `--no-wait`: the request is waiting and stays alive in the app.
    Pending { request: String },
    /// The final reply.
    End {
        ok: bool,
        command: String,
        #[serde(default, skip_serializing_if = "Value::is_null")]
        data: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<ErrorBody>,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Every error code, its exit code and what it means. The single list
/// `help errors` prints and the CLI maps exit codes from.
pub const ERRORS: &[(&str, i32, &str)] = &[
    ("vehicle_error", 1, "the vehicle refused or didn't confirm"),
    ("link_lost", 1, "the link dropped mid-command"),
    ("script_error", 1, "Lua errors after a restart"),
    ("io_error", 1, "a local file couldn't be read or written"),
    ("usage", 2, "bad arguments"),
    ("unknown_param", 2, "no parameter by that name"),
    ("invalid_value", 2, "not a valid value for that parameter"),
    ("out_of_range", 2, "outside the documented range"),
    ("not_found", 2, "no such file, log or vehicle path"),
    ("bad_file", 2, "a file with nothing usable in it"),
    ("not_enough_data", 2, "the range is too short for the analysis"),
    ("app_unavailable", 3, "app not running, or CLI access off"),
    ("version_mismatch", 3, "CLI and app versions don't match"),
    ("no_vehicle", 4, "no vehicle connected"),
    ("rejected", 5, "rejected in the app"),
    ("blocked", 6, "blocked by a setting or the armed state"),
    ("expired", 7, "nobody answered before --timeout"),
    ("stopped", 8, "stopped in the app"),
    ("pending", 9, "--no-wait, and the request is waiting"),
];

/// The exit code for an error code; `1` for anything unlisted.
pub fn exit_code(code: &str) -> i32 {
    ERRORS.iter().find(|(c, _, _)| *c == code).map(|(_, exit, _)| *exit).unwrap_or(1)
}

pub const EXIT_INTERRUPTED: i32 = 130;
