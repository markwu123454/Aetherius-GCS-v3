//! `script ls / pull / push / push --watch / rm / restart`. Paths are
//! relative to `APM/scripts` on the vehicle's SD card, which is as far as
//! the app's MAVLink FTP client reaches.

use std::{collections::HashMap, time::Duration};

use aetherius_cli::{catalog::Category, protocol::ClientMessage};
use base64::Engine;
use mavlink::dialects::ardupilotmega::{MavCmd, MavResult};
use serde_json::{json, Value};
use tauri::Manager;

use super::plain;
use crate::cli::{
    console,
    ctx::{vehicle_error, CliError, CliResult, Ctx},
    requests::{now_ms, RequestState},
    CliState, Policy,
};
use crate::{commands, link::LinkState, scripting};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;
/// `SCRIPTING_CMD_STOP_AND_RESTART`.
const SCRIPTING_RESTART: f32 = 3.0;
/// Longest script text sent to the panel for a diff.
const MAX_DIFF_TEXT: usize = 64 * 1024;

/// `APM/scripts/foo.lua`, `/APM/scripts/foo.lua` and `foo.lua` all mean
/// `foo.lua` under the scripts folder.
fn relative(raw: &str) -> String {
    let path = raw.trim().replace('\\', "/");
    let path = path.trim_start_matches('/');
    let lower = path.to_lowercase();
    let rest = if lower.starts_with("apm/scripts/") {
        &path["apm/scripts/".len()..]
    } else if lower == "apm/scripts" {
        ""
    } else {
        path
    };
    rest.trim_matches('/').to_string()
}

fn shown(relative: &str) -> String {
    if relative.is_empty() {
        "APM/scripts".to_string()
    } else {
        format!("APM/scripts/{relative}")
    }
}

fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{dir}/{name}")
    }
}

fn text(bytes: &[u8]) -> String {
    let mut s = String::from_utf8_lossy(bytes).to_string();
    if s.len() > MAX_DIFF_TEXT {
        let mut cut = MAX_DIFF_TEXT;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
    }
    s
}

pub async fn ls(ctx: &Ctx) -> CliResult {
    let dir = relative(ctx.str("dir").unwrap_or(""));
    ctx.authorize(plain()).await?;
    let entries = scripting::cli_list(&ctx.app, &dir).await.map_err(vehicle_error)?;
    let mut rows: Vec<Value> =
        entries.iter().map(|e| json!({"name": e.name, "bytes": e.size, "dir": e.is_dir})).collect();
    rows.sort_by(|a, b| {
        (b["dir"].as_bool(), a["name"].as_str()).cmp(&(a["dir"].as_bool(), b["name"].as_str()))
    });
    Ok(json!({"dir": shown(&dir), "entries": rows}))
}

pub async fn pull(ctx: &Ctx) -> CliResult {
    let path = relative(ctx.str("remote").unwrap_or(""));
    ctx.authorize(plain()).await?;
    let bytes = scripting::cli_read(&ctx.app, &path)
        .await
        .map_err(vehicle_error)?
        .ok_or_else(|| CliError::new("not_found", format!("no file {} on the vehicle", shown(&path))))?;
    Ok(json!({"remote": shown(&path), "local": ctx.str("local"), "bytes": bytes.len(), "contentBase64": B64.encode(&bytes)}))
}

/// Restarts scripting and collects Lua errors for `wait`. Returns
/// `(restarted, reboot_needed, lua_errors)`.
async fn restart_scripting(ctx: &Ctx, wait: Duration) -> (bool, bool, Vec<String>) {
    let Some(target) = *ctx.app.state::<LinkState>().target.lock().unwrap_or_else(|e| e.into_inner()) else {
        return (false, true, Vec::new());
    };
    let buffer = &ctx.app.state::<CliState>().console;
    let since = buffer.last_seq();
    let outcome = commands::send_sync(
        &ctx.app,
        MavCmd::MAV_CMD_SCRIPTING,
        [SCRIPTING_RESTART, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        target,
        Duration::from_secs(3),
    )
    .await;
    if !matches!(outcome, Ok(MavResult::MAV_RESULT_ACCEPTED)) {
        return (false, true, Vec::new());
    }
    tokio::time::sleep(wait).await;
    let errors = buffer.after(since).into_iter().filter(console::is_lua_error).map(|m| m.text).collect();
    (true, false, errors)
}

struct Upload {
    local: String,
    remote: String,
    bytes: Vec<u8>,
    old: Option<Vec<u8>>,
}

pub async fn push(ctx: &Ctx) -> CliResult {
    let to = relative(ctx.str("to").unwrap_or(""));
    let files = ctx.args.get("files").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut uploads = Vec::new();
    for file in files {
        let name = file.get("name").and_then(Value::as_str).unwrap_or_default();
        let bytes = B64
            .decode(file.get("contentBase64").and_then(Value::as_str).unwrap_or_default())
            .map_err(|e| CliError::new("usage", format!("bad file contents for {name}: {e}")))?;
        let remote = join(&to, name);
        let old = scripting::cli_read(&ctx.app, &remote).await.map_err(vehicle_error)?;
        uploads.push(Upload { local: file.get("local").and_then(Value::as_str).unwrap_or(name).to_string(), remote, bytes, old });
    }

    let detail = json!({
        "kind": "scriptFiles",
        "files": uploads.iter().map(|u| json!({
            "remote": shown(&u.remote),
            "local": u.local,
            "new": u.old.is_none(),
            "old": u.old.as_deref().map(text),
            "text": text(&u.bytes),
        })).collect::<Vec<_>>(),
    });
    ctx.authorize(detail).await?;

    let mut done = Vec::new();
    for u in &uploads {
        ctx.check()?;
        ctx.progress(json!({"text": format!("uploading {}", shown(&u.remote))}));
        scripting::cli_write(&ctx.app, &u.remote, u.bytes.clone()).await.map_err(vehicle_error)?;
        done.push(json!({"local": u.local, "remote": shown(&u.remote), "bytes": u.bytes.len(), "new": u.old.is_none()}));
    }

    let (restarted, reboot_needed, lua_errors) =
        if ctx.flag("noRestart") { (false, false, Vec::new()) } else { restart_scripting(ctx, Duration::from_secs(3)).await };
    let data = json!({"files": done, "restarted": restarted, "rebootNeeded": reboot_needed, "luaErrors": lua_errors});
    if !lua_errors.is_empty() {
        let n = lua_errors.len();
        return Err(CliError::new("script_error", format!("{n} Lua error{} after restart", if n == 1 { "" } else { "s" })).with_data(data));
    }
    Ok(data)
}

pub async fn rm(ctx: &Ctx) -> CliResult {
    let path = relative(ctx.str("remote").unwrap_or(""));
    let old = scripting::cli_read(&ctx.app, &path)
        .await
        .map_err(vehicle_error)?
        .ok_or_else(|| CliError::new("not_found", format!("no file {} on the vehicle", shown(&path))))?;
    ctx.authorize(json!({"kind": "scriptDelete", "remote": shown(&path), "old": text(&old)})).await?;
    scripting::cli_delete(&ctx.app, &path).await.map_err(vehicle_error)?;
    let (restarted, reboot_needed, lua_errors) =
        if ctx.flag("noRestart") { (false, false, Vec::new()) } else { restart_scripting(ctx, Duration::from_secs(3)).await };
    let data = json!({"removed": shown(&path), "restarted": restarted, "rebootNeeded": reboot_needed, "luaErrors": lua_errors});
    if !lua_errors.is_empty() {
        return Err(CliError::new("script_error", "Lua errors after restart").with_data(data));
    }
    Ok(data)
}

pub async fn restart(ctx: &Ctx) -> CliResult {
    ctx.authorize(json!({"kind": "command"})).await?;
    let (restarted, reboot_needed, lua_errors) = restart_scripting(ctx, Duration::from_secs(3)).await;
    let data = json!({"restarted": restarted, "rebootNeeded": reboot_needed, "luaErrors": lua_errors});
    if !lua_errors.is_empty() {
        return Err(CliError::new("script_error", "Lua errors after restart").with_data(data));
    }
    Ok(data)
}

struct Held {
    file: String,
    bytes: Vec<u8>,
}

struct Session {
    to: String,
    pushed: u64,
    held_count: u64,
    queue: Vec<Held>,
    last: HashMap<String, Vec<u8>>,
}

impl Session {
    fn summary(&self) -> Value {
        json!({"pushed": self.pushed, "held": self.held_count})
    }
}

/// What the settings say about a push right now, without asking.
fn push_policy(ctx: &Ctx) -> Policy {
    let p = ctx.app.state::<CliState>().settings().permissions;
    if ctx.armed() {
        p.while_armed.max(if p.scripts == Policy::Block { Policy::Block } else { Policy::Allow })
    } else if p.scripts == Policy::Block {
        Policy::Block
    } else {
        Policy::Allow
    }
}

async fn push_one(ctx: &Ctx, session: &mut Session, file: &str, bytes: Vec<u8>, was_held: bool) -> CliResult<()> {
    let remote = join(&session.to, file);
    let old = match session.last.get(file) {
        Some(previous) => Some(previous.clone()),
        None => scripting::cli_read(&ctx.app, &remote).await.map_err(vehicle_error)?,
    };
    let diff = json!({"old": old.as_deref().map(text), "new": text(&bytes)});
    let time = ctx.clock(now_ms());

    match push_policy(ctx) {
        Policy::Block if ctx.armed() => {
            session.held_count += 1;
            session.queue.retain(|h| h.file != file);
            session.queue.push(Held { file: file.to_string(), bytes });
            ctx.item(json!({"time": time, "file": file, "result": "held", "reason": "vehicle armed", "luaErrors": [], "diff": diff}));
            return Ok(());
        }
        Policy::Block => {
            ctx.item(json!({"time": time, "file": file, "result": "blocked", "reason": "script writes are set to Block", "luaErrors": [], "diff": diff}));
            return Ok(());
        }
        Policy::Ask => {
            let detail = json!({"kind": "scriptFiles", "files": [{"remote": shown(&remote), "local": file, "new": old.is_none(),
                "old": old.as_deref().map(text), "text": text(&bytes)}]});
            let outcome = ctx.authorize_as(Category::Always, true, true, detail).await;
            ctx.set_detail(watch_detail(ctx, session));
            match outcome {
                Ok(()) => {}
                Err(e) if e.code == "stopped" => return Err(e),
                Err(e) => {
                    ctx.set_state(RequestState::Running, None);
                    ctx.item(json!({"time": time, "file": file, "result": e.code, "reason": e.message, "luaErrors": [], "diff": diff}));
                    return Ok(());
                }
            }
        }
        Policy::Allow => {}
    }

    scripting::cli_write(&ctx.app, &remote, bytes.clone()).await.map_err(vehicle_error)?;
    let (restarted, reboot_needed, lua_errors) =
        if ctx.flag("noRestart") { (false, false, Vec::new()) } else { restart_scripting(ctx, Duration::from_secs(2)).await };
    session.pushed += 1;
    session.last.insert(file.to_string(), bytes);
    let result = if lua_errors.is_empty() { "pushed" } else { "pushed with errors" };
    let reason = if was_held {
        Some("was held".to_string())
    } else if reboot_needed && !restarted {
        Some("reboot to load".to_string())
    } else {
        None
    };
    ctx.item(json!({"time": ctx.clock(now_ms()), "file": file, "result": result, "reason": reason, "luaErrors": lua_errors, "diff": diff}));
    Ok(())
}

fn watch_detail(ctx: &Ctx, session: &Session) -> Value {
    json!({"kind": "watch", "folder": ctx.str("watch"), "target": shown(&session.to)})
}

pub async fn watch(ctx: &Ctx) -> CliResult {
    let mut session = Session { to: relative(ctx.str("to").unwrap_or("")), pushed: 0, held_count: 0, queue: Vec::new(), last: HashMap::new() };
    ctx.authorize(watch_detail(ctx, &session)).await?;
    ctx.set_detail(watch_detail(ctx, &session));

    loop {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if ctx.stop_requested() {
            return Err(CliError::new("stopped", "stopped in the app").with_data(session.summary()));
        }
        if ctx.caller_gone() {
            return Ok(session.summary());
        }
        while let Some(message) = ctx.recv() {
            match message {
                ClientMessage::Stop => return Ok(session.summary()),
                ClientMessage::Push { file, content_base64 } => {
                    let Ok(bytes) = B64.decode(content_base64) else { continue };
                    let file = file.replace('\\', "/");
                    if let Err(e) = push_one(ctx, &mut session, &file, bytes, false).await {
                        if e.code == "stopped" {
                            return Err(e.with_data(session.summary()));
                        }
                        ctx.item(json!({"time": ctx.clock(now_ms()), "file": file, "result": "failed", "reason": e.message, "luaErrors": []}));
                    }
                }
            }
        }
        if !session.queue.is_empty() && !ctx.armed() {
            let queued = std::mem::take(&mut session.queue);
            for held in queued {
                if let Err(e) = push_one(ctx, &mut session, &held.file, held.bytes, true).await {
                    if e.code == "stopped" {
                        return Err(e.with_data(session.summary()));
                    }
                    ctx.item(json!({"time": ctx.clock(now_ms()), "file": held.file, "result": "failed", "reason": e.message, "luaErrors": []}));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_paths() {
        assert_eq!(relative("APM/scripts/foo.lua"), "foo.lua");
        assert_eq!(relative("/APM/scripts/sub/foo.lua"), "sub/foo.lua");
        assert_eq!(relative("foo.lua"), "foo.lua");
        assert_eq!(relative("apm\\scripts"), "");
        assert_eq!(shown(""), "APM/scripts");
        assert_eq!(join("sub", "a.lua"), "sub/a.lua");
    }
}
