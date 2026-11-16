//! One function per command. Each checks what it can up front, calls
//! `ctx.authorize` (with what the panel should show if it asks), then does
//! the work and returns the reply's `data`.

mod analysis;
mod expr;
mod logs;
mod params;
mod script;

use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::Manager;

use super::{
    console,
    ctx::{vehicle_error, CliError, CliResult, Ctx},
    modes,
    requests::RequestState,
    CliState,
};
use crate::{link::LinkState, telemetry::VehicleKind};

pub async fn run(ctx: &Ctx) -> CliResult {
    if ctx.def.needs_vehicle {
        ctx.vehicle_ready()?;
    }
    match ctx.def.name {
        "status" => status(ctx).await,
        "params get" => params::get(ctx).await,
        "params describe" => params::describe(ctx).await,
        "params set" => params::set(ctx).await,
        "params diff" => params::diff(ctx).await,
        "params apply" => params::apply(ctx).await,
        "params save" => params::save(ctx).await,
        "params refresh" => params::refresh(ctx).await,
        "script ls" => script::ls(ctx).await,
        "script pull" => script::pull(ctx).await,
        "script push" if ctx.str("watch").is_some() => script::watch(ctx).await,
        "script push" => script::push(ctx).await,
        "script rm" => script::rm(ctx).await,
        "script restart" => script::restart(ctx).await,
        "console" => console_cmd(ctx).await,
        "logs ls" => logs::ls(ctx).await,
        "logs pull" => logs::pull(ctx).await,
        "logs local" => logs::local(ctx).await,
        "logs info" | "logs schema" | "logs series" | "logs events" | "logs segments" | "logs stats" | "logs fft"
        | "logs track-error" | "logs eval" | "logs export" => logs::analyze(ctx).await,
        "reboot" => reboot(ctx).await,
        "requests ls" => requests_ls(ctx),
        "requests show" | "requests wait" => requests_reply(ctx).await,
        "requests stop" => requests_stop(ctx),
        other => Err(CliError::new("usage", format!("{other} isn't handled by the app"))),
    }
}

/// What a command asks approval for when there's nothing more specific to
/// show than the command itself.
pub fn plain() -> Value {
    json!({"kind": "command"})
}

/// `*` and `?` wildcards, ignoring case.
pub fn glob(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.to_uppercase().chars().collect();
    let t: Vec<char> = text.to_uppercase().chars().collect();
    let (mut pi, mut ti, mut star, mut mark) = (0, 0, None, 0);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

pub fn is_plane(ctx: &Ctx) -> bool {
    ctx.app.state::<LinkState>().snapshot.lock().unwrap_or_else(|e| e.into_inner()).vehicle_kind == Some(VehicleKind::Plane)
}

/// `ArduCopter V4.6.2`, once AUTOPILOT_VERSION has arrived.
pub fn firmware(ctx: &Ctx) -> Option<String> {
    let snapshot = ctx.app.state::<LinkState>().snapshot.lock().unwrap_or_else(|e| e.into_inner()).clone();
    snapshot.flight_sw_major.map(|major| {
        let name = match snapshot.vehicle_kind {
            Some(VehicleKind::Plane) => "ArduPlane",
            Some(VehicleKind::Multirotor) => "ArduCopter",
            _ => "ArduPilot",
        };
        format!("{name} V{major}.{}.{}", snapshot.flight_sw_minor.unwrap_or(0), snapshot.flight_sw_patch.unwrap_or(0))
    })
}

async fn status(ctx: &Ctx) -> CliResult {
    ctx.authorize(plain()).await?;
    let link = ctx.app.state::<LinkState>();
    let connected = link.target.lock().unwrap_or_else(|e| e.into_inner()).is_some();
    let snapshot = link.snapshot.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let endpoint = link.endpoint.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let board = endpoint.as_ref().and_then(|address| {
        link.available.lock().unwrap_or_else(|e| e.into_inner()).iter().find(|l| &l.address == address).map(|l| l.label.clone())
    });
    let shown_endpoint = endpoint.as_deref().map(|e| {
        // `serial:COM5:115200` reads better as COM5.
        e.strip_prefix("serial:").map(|rest| rest.split(':').next().unwrap_or(rest).to_string()).unwrap_or_else(|| e.to_string())
    });

    let plane = snapshot.vehicle_kind == Some(VehicleKind::Plane);
    let firmware = firmware(ctx);
    let vehicle = snapshot.vehicle_kind.map(|k| match k {
        VehicleKind::Plane => "plane",
        VehicleKind::Multirotor => "copter",
        VehicleKind::Other => "other",
    });
    let (loaded, total) = crate::params::loaded_counts(&ctx.app);
    let p = ctx.app.state::<CliState>().settings().permissions;

    Ok(json!({
        "link": if connected { json!({"endpoint": shown_endpoint, "board": board}) } else { Value::Null },
        "firmware": if connected { json!(firmware) } else { Value::Null },
        "vehicle": if connected { json!(vehicle) } else { Value::Null },
        "armed": if connected { json!(snapshot.armed) } else { Value::Null },
        "mode": if connected { json!(snapshot.custom_mode.map(|m| modes::name(plane, m))) } else { Value::Null },
        "params": {"loaded": loaded, "total": total},
        "permissions": {
            "reads": p.reads.key(), "logs": p.logs.key(), "params": p.params.key(),
            "scripts": p.scripts.key(), "reboot": p.reboot.key(), "whileArmed": p.while_armed.key(),
        },
    }))
}

fn console_json(ctx: &Ctx, m: &console::Message) -> Value {
    json!({"time": ctx.clock(m.at), "severity": console::severity_name(m.severity), "text": m.text})
}

async fn console_cmd(ctx: &Ctx) -> CliResult {
    let level = match ctx.str("level") {
        Some(name) => Some(console::severity_from_name(name).ok_or_else(|| {
            CliError::new("usage", format!("unknown level {name}; use one of {}", console::SEVERITIES.join(", ")))
        })?),
        None => None,
    };
    let since_ms = match ctx.str("since") {
        Some(text) => Some(parse_since(text, ctx.utc_offset).ok_or_else(|| CliError::new("usage", format!("--since takes HH:MM:SS or a duration like 5m, got {text}")))?),
        None => None,
    };
    let grep = ctx.str("grep").map(str::to_lowercase);
    let keep = |m: &console::Message| {
        level.is_none_or(|l| m.severity <= l)
            && since_ms.is_none_or(|s| m.at >= s)
            && grep.as_ref().is_none_or(|g| m.text.to_lowercase().contains(g))
    };

    ctx.authorize(plain()).await?;
    let buffer = &ctx.app.state::<CliState>().console;
    let mut messages: Vec<console::Message> = buffer.all().into_iter().filter(|m| keep(m)).collect();
    if since_ms.is_none() || ctx.u64("last").is_some() {
        let last = ctx.u64("last").unwrap_or(50) as usize;
        if messages.len() > last {
            messages.drain(..messages.len() - last);
        }
    }

    if !ctx.flag("follow") {
        return Ok(json!({"messages": messages.iter().map(|m| console_json(ctx, m)).collect::<Vec<_>>()}));
    }

    for m in &messages {
        ctx.item(console_json(ctx, m));
    }
    let mut seen = buffer.last_seq();
    loop {
        tokio::time::sleep(Duration::from_millis(200)).await;
        if ctx.stop_requested() {
            return Err(CliError::new("stopped", "stopped in the app"));
        }
        if ctx.caller_gone() || matches!(ctx.recv(), Some(aetherius_cli::protocol::ClientMessage::Stop)) {
            return Ok(json!({"messages": []}));
        }
        for m in buffer.after(seen) {
            seen = seen.max(m.seq);
            if keep(&m) {
                ctx.item(console_json(ctx, &m));
            }
        }
    }
}

/// `HH:MM:SS` today in the caller's time, or a duration back from now.
fn parse_since(text: &str, utc_offset_minutes: i32) -> Option<u64> {
    let now = super::requests::now_ms();
    if text.contains(':') {
        let parts: Vec<u64> = text.split(':').map(|p| p.parse().ok()).collect::<Option<Vec<_>>>()?;
        let secs = match parts.as_slice() {
            [h, m] => h * 3600 + m * 60,
            [h, m, s] => h * 3600 + m * 60 + s,
            _ => return None,
        };
        let offset = utc_offset_minutes as i64 * 60_000;
        let local_now = now as i64 + offset;
        let local_midnight = local_now - local_now.rem_euclid(86_400_000);
        Some((local_midnight + secs as i64 * 1000 - offset).max(0) as u64)
    } else {
        let secs = aetherius_cli::parse::parse_duration(text).ok()?;
        Some(now.saturating_sub(secs * 1000))
    }
}

async fn reboot(ctx: &Ctx) -> CliResult {
    ctx.authorize(json!({"kind": "reboot"})).await?;
    ctx.progress(json!({"text": "rebooting"}));
    let started = Instant::now();
    crate::link::reboot_link(false, ctx.app.clone()).await.map_err(vehicle_error)?;
    if ctx.flag("noReconnect") {
        return Ok(json!({"reconnected": false, "seconds": null, "params": null}));
    }

    let link = ctx.app.state::<LinkState>();
    let mut back_at = None;
    let mut last_report = Instant::now();
    loop {
        tokio::time::sleep(Duration::from_millis(250)).await;
        ctx.check()?;
        if started.elapsed() > Duration::from_secs(60) {
            return Err(CliError::new("vehicle_error", "the link didn't come back within 60 s"));
        }
        let connected = link.target.lock().unwrap_or_else(|e| e.into_inner()).is_some()
            && matches!(*link.status.lock().unwrap_or_else(|e| e.into_inner()), Some(crate::link::LinkStatus::Connected));
        if !connected {
            continue;
        }
        let seconds = *back_at.get_or_insert_with(|| {
            let s = started.elapsed().as_secs_f64();
            ctx.progress(json!({"text": format!("link back after {s:.1} s")}));
            s
        });
        let (loaded, total) = crate::params::loaded_counts(&ctx.app);
        match total {
            Some(total) if loaded >= total as usize && total > 0 => {
                return Ok(json!({"reconnected": true, "seconds": (seconds * 10.0).round() / 10.0, "params": loaded}));
            }
            _ => {
                if last_report.elapsed() > Duration::from_secs(1) {
                    last_report = Instant::now();
                    ctx.progress(json!({"text": format!("loading parameters {loaded}/{}", total.map(|t| t.to_string()).unwrap_or("?".into()))}));
                }
            }
        }
    }
}

fn requests_ls(ctx: &Ctx) -> CliResult {
    let all = ctx.flag("all");
    let records = ctx.app.state::<CliState>().registry.all();
    let rows: Vec<Value> = records
        .iter()
        .filter(|r| r.id != ctx.id && (all || !r.state.finished()))
        .map(|r| json!({"id": r.id, "time": ctx.clock(r.started_at), "state": r.state.key(), "command": r.argv, "folder": r.folder}))
        .collect();
    Ok(json!({"requests": rows}))
}

async fn requests_reply(ctx: &Ctx) -> CliResult {
    let id = ctx.str("id").unwrap_or_default().to_string();
    let registry = &ctx.app.state::<CliState>().registry;
    loop {
        let record = registry.get(&id).ok_or_else(|| CliError::new("not_found", format!("no request {id} in this app session")))?;
        if record.state.finished() {
            let result = record.result.unwrap_or(Value::Null);
            let data = result.get("data").cloned().unwrap_or(Value::Null);
            if result.get("ok").and_then(Value::as_bool) == Some(true) {
                return Ok(json!({"__command": record.command, "__data": data}));
            }
            let error = result.get("error").cloned().unwrap_or(Value::Null);
            let code = error.get("code").and_then(Value::as_str).unwrap_or("vehicle_error");
            let code = aetherius_cli::protocol::ERRORS.iter().find(|(c, _, _)| *c == code).map(|(c, _, _)| *c).unwrap_or("vehicle_error");
            let message = error.get("message").and_then(Value::as_str).unwrap_or("failed").to_string();
            return Err(CliError::new(code, message).with_data(json!({"__command": record.command, "__data": data})));
        }
        if ctx.def.name == "requests show" {
            return Err(CliError::new("not_found", format!("{id} hasn't finished yet ({})", record.state.key())));
        }
        if record.state == RequestState::Waiting || record.state == RequestState::Held || record.state == RequestState::Running {
            tokio::time::sleep(Duration::from_millis(200)).await;
            ctx.check()?;
        }
    }
}

fn requests_stop(ctx: &Ctx) -> CliResult {
    let id = ctx.str("id").unwrap_or_default().to_string();
    ctx.app
        .state::<CliState>()
        .registry
        .request_stop(&id)
        .map_err(|e| CliError::new("not_found", format!("{id}: {e}")))?;
    Ok(json!({"stopped": id}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_matches() {
        assert!(glob("INS_HNTCH_*", "INS_HNTCH_FREQ"));
        assert!(glob("ins_hntch_*", "INS_HNTCH_FREQ"));
        assert!(glob("*", "ANYTHING"));
        assert!(glob("ATC_RAT_???_P", "ATC_RAT_RLL_P"));
        assert!(!glob("ATC_RAT_???_P", "ATC_RAT_RLL_I"));
        assert!(glob("*_P", "ATC_RAT_RLL_P"));
        assert!(!glob("INS_*", "ATC_RAT_RLL_P"));
    }

    #[test]
    fn since_parses() {
        assert!(parse_since("5m", 0).is_some());
        assert!(parse_since("14:02:11", 60).is_some());
        assert!(parse_since("nope", 0).is_none());
    }
}
