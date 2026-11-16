//! One request in flight: its arguments, the connection back to the CLI,
//! and the permission check every handler goes through before it acts.

use std::{
    io::Write,
    net::TcpStream,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::Receiver,
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use aetherius_cli::{
    catalog::{Category, CommandDef},
    protocol::{ClientMessage, ErrorBody, Event, Request},
};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};

use super::{
    requests::{self, now_ms, RequestState},
    CliState, Policy,
};
use crate::link::LinkState;

#[derive(Debug)]
pub struct CliError {
    pub code: &'static str,
    pub message: String,
    pub reason: Option<String>,
    /// Partial results to show alongside the error.
    pub data: Option<Value>,
}

impl CliError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        CliError { code, message: message.into(), reason: None, data: None }
    }

    pub fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }

    pub fn with_reason(mut self, reason: &str) -> Self {
        self.reason = Some(reason.to_string());
        self
    }
}

/// Maps an error string from the existing vehicle code to a CLI error:
/// "no vehicle" is its own code, everything else is the vehicle's refusal.
pub fn vehicle_error(message: String) -> CliError {
    if message.contains("no vehicle") || message == "not connected" {
        CliError::new("no_vehicle", "no vehicle connected")
    } else {
        CliError::new("vehicle_error", message)
    }
}

pub type CliResult<T = Value> = Result<T, CliError>;

pub struct Ctx {
    pub app: AppHandle,
    pub id: String,
    pub def: &'static CommandDef,
    pub args: Map<String, Value>,
    pub cwd: PathBuf,
    pub utc_offset: i32,
    timeout: Option<Duration>,
    no_wait: bool,
    sink: Mutex<Option<TcpStream>>,
    inbox: Mutex<Receiver<ClientMessage>>,
    gone: Arc<AtomicBool>,
}

impl Ctx {
    pub fn new(
        app: AppHandle,
        id: String,
        def: &'static CommandDef,
        request: Request,
        sink: TcpStream,
        inbox: Receiver<ClientMessage>,
        gone: Arc<AtomicBool>,
    ) -> Self {
        Ctx {
            app,
            id,
            def,
            args: request.args,
            cwd: PathBuf::from(request.cwd),
            utc_offset: request.utc_offset_minutes,
            timeout: (request.timeout_secs > 0).then(|| Duration::from_secs(request.timeout_secs)),
            no_wait: request.no_wait,
            sink: Mutex::new(Some(sink)),
            inbox: Mutex::new(inbox),
            gone,
        }
    }

    fn state(&self) -> tauri::State<'_, CliState> {
        self.app.state::<CliState>()
    }

    pub fn send(&self, event: &Event) {
        let mut sink = self.sink.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(stream) = sink.as_mut() {
            let line = serde_json::to_string(event).unwrap_or_default();
            if writeln!(stream, "{line}").and_then(|_| stream.flush()).is_err() {
                *sink = None;
            }
        }
    }

    pub fn set_state(&self, state: RequestState, reason: Option<String>) {
        self.state().registry.update(&self.app, &self.id, |r| {
            r.state = state;
            r.reason = reason.clone();
        });
        self.send(&Event::State { state: state.key().to_string(), reason });
    }

    pub fn progress(&self, data: Value) {
        self.state().registry.update(&self.app, &self.id, |r| r.progress = Some(data.clone()));
        self.send(&Event::Progress { data });
    }

    pub fn item(&self, data: Value) {
        self.state().registry.update(&self.app, &self.id, |r| r.items.push(data.clone()));
        self.send(&Event::Item { data });
    }

    /// Sets what the panel shows for this request outside of approval, e.g.
    /// a watch session's folder.
    pub fn set_detail(&self, detail: Value) {
        self.state().registry.update(&self.app, &self.id, |r| r.approval = Some(detail));
    }

    /// Sets something only the panel draws.
    pub fn set_view(&self, view: Value) {
        self.state().registry.update(&self.app, &self.id, |r| r.view = Some(view));
    }

    pub fn stop_requested(&self) -> bool {
        self.state().registry.get(&self.id).is_some_and(|r| r.stop)
    }

    fn detached(&self) -> bool {
        self.state().registry.get(&self.id).is_some_and(|r| r.detached)
    }

    /// The CLI went away without `--no-wait`.
    pub fn caller_gone(&self) -> bool {
        self.gone.load(Ordering::SeqCst) && !self.detached()
    }

    /// Fails with `stopped` if Stop was pressed or the caller went away.
    pub fn check(&self) -> CliResult<()> {
        if self.stop_requested() {
            return Err(CliError::new("stopped", "stopped in the app"));
        }
        if self.caller_gone() {
            return Err(CliError::new("stopped", "the caller went away").with_reason("cancelled"));
        }
        Ok(())
    }

    pub fn recv(&self) -> Option<ClientMessage> {
        self.inbox.lock().unwrap_or_else(|e| e.into_inner()).try_recv().ok()
    }

    pub fn armed(&self) -> bool {
        self.app.state::<LinkState>().snapshot.lock().unwrap_or_else(|e| e.into_inner()).armed == Some(true)
    }

    pub fn vehicle_ready(&self) -> CliResult<()> {
        let connected = self.app.state::<LinkState>().target.lock().unwrap_or_else(|e| e.into_inner()).is_some();
        if connected {
            Ok(())
        } else {
            Err(CliError::new("no_vehicle", "no vehicle connected"))
        }
    }

    /// The setting that decides `category` right now, and why it blocks if
    /// it does.
    fn policy(&self, category: Category, while_armed: bool, force_ask: bool) -> (Policy, Option<CliError>) {
        let settings = self.state().settings();
        let p = &settings.permissions;
        let base = match category {
            Category::Reads => p.reads,
            Category::Logs => p.logs,
            Category::Params => p.params,
            Category::Scripts => p.scripts,
            Category::Reboot => p.reboot,
            Category::Always => Policy::Allow,
        };
        let armed = while_armed && self.armed();
        let mut effective = if armed { base.max(p.while_armed) } else { base };
        if force_ask {
            effective = effective.max(Policy::Ask);
        }
        let blocked = (effective == Policy::Block).then(|| {
            if base == Policy::Block {
                let label = category.label();
                let mut chars = label.chars();
                let capital: String = chars.next().map(|c| c.to_uppercase().collect::<String>()).unwrap_or_default() + chars.as_str();
                CliError::new("blocked", format!("{capital} set to Block in Settings › CLI")).with_reason("setting")
            } else {
                CliError::new("blocked", "vehicle is armed").with_reason("armed")
            }
        });
        (effective, blocked)
    }

    /// The command's own category, with `approval` shown if it asks.
    pub async fn authorize(&self, approval: Value) -> CliResult<()> {
        self.authorize_as(self.def.category, self.def.while_armed, false, approval).await
    }

    /// Checks the permission settings and, if they say Ask, waits for the
    /// operator. Rechecked while waiting (the vehicle may arm) and again
    /// on approval, before anything is sent.
    pub async fn authorize_as(&self, category: Category, while_armed: bool, force_ask: bool, approval: Value) -> CliResult<()> {
        let started = Instant::now();
        let expired = |started: Instant| self.timeout.is_some_and(|t| started.elapsed() >= t);

        // Held while paused, before anything is decided.
        let mut held = false;
        while self.state().paused() {
            if !held {
                self.set_state(RequestState::Held, Some("paused in Aetherius".to_string()));
                held = true;
            }
            self.check()?;
            if expired(started) {
                return Err(CliError::new("expired", "the app stayed paused past --timeout"));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        let (policy, blocked) = self.policy(category, while_armed, force_ask);
        if let Some(error) = blocked {
            return Err(error);
        }
        if policy == Policy::Allow {
            if held {
                self.set_state(RequestState::Running, None);
            }
            self.state().registry.update(&self.app, &self.id, |r| {
                if r.approval.is_none() {
                    r.approval = Some(approval.clone());
                }
            });
            return Ok(());
        }

        self.state().registry.update(&self.app, &self.id, |r| {
            r.approval = Some(approval.clone());
            r.decision = None;
        });
        self.set_state(RequestState::Waiting, None);
        if self.no_wait {
            self.state().registry.update(&self.app, &self.id, |r| r.detached = true);
            self.send(&Event::Pending { request: self.id.clone() });
            *self.sink.lock().unwrap_or_else(|e| e.into_inner()) = None;
        }

        loop {
            tokio::time::sleep(Duration::from_millis(100)).await;
            self.check()?;
            let decision = self.state().registry.get(&self.id).and_then(|r| r.decision);
            if decision == Some(false) {
                return Err(CliError::new("rejected", "rejected in app"));
            }
            let (_, blocked) = self.policy(category, while_armed, force_ask);
            if let Some(error) = blocked {
                return Err(error);
            }
            if decision == Some(true) {
                self.set_state(RequestState::Running, None);
                return Ok(());
            }
            if expired(started) {
                return Err(CliError::new("expired", format!("no answer within {}", fmt_duration(self.timeout.unwrap_or_default()))));
            }
        }
    }

    pub fn str(&self, key: &str) -> Option<&str> {
        self.args.get(key).and_then(Value::as_str)
    }

    pub fn flag(&self, key: &str) -> bool {
        self.args.get(key).and_then(Value::as_bool).unwrap_or(false)
    }

    pub fn u64(&self, key: &str) -> Option<u64> {
        self.args.get(key).and_then(Value::as_u64)
    }

    pub fn f64(&self, key: &str) -> Option<f64> {
        self.args.get(key).and_then(Value::as_f64)
    }

    pub fn list(&self, key: &str) -> Vec<String> {
        self.args
            .get(key)
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default()
    }

    /// A path from the command line, resolved against the caller's folder.
    pub fn path(&self, raw: &str) -> PathBuf {
        let p = PathBuf::from(raw);
        if p.is_absolute() {
            p
        } else {
            self.cwd.join(p)
        }
    }

    pub fn clock(&self, ms: u64) -> String {
        requests::clock_local(ms, self.utc_offset)
    }

    pub fn iso(&self, ms: u64) -> String {
        requests::iso_local(ms, self.utc_offset)
    }

    /// Records the outcome, sends the final reply and writes history.
    pub fn finish(&self, outcome: CliResult) {
        let state = match &outcome {
            Ok(_) => RequestState::Done,
            Err(e) => match e.code {
                "rejected" => RequestState::Rejected,
                "blocked" => RequestState::Blocked,
                "expired" => RequestState::Expired,
                "stopped" if e.reason.as_deref() == Some("cancelled") => RequestState::Cancelled,
                "stopped" => RequestState::Stopped,
                _ => RequestState::Failed,
            },
        };
        let (ok, data, error) = match outcome {
            Ok(data) => (true, data, None),
            Err(e) => (
                false,
                e.data.unwrap_or(Value::Null),
                Some(ErrorBody { code: e.code.to_string(), message: e.message, reason: e.reason }),
            ),
        };
        // `requests show/wait` forward another request's reply under that
        // request's own command, so the CLI prints it the same way.
        let (command, data) = match data.get("__command").and_then(Value::as_str).map(String::from) {
            Some(original) => (original, data.get("__data").cloned().unwrap_or(Value::Null)),
            None => (self.def.name.to_string(), data),
        };
        let result = json!({"ok": ok, "data": data, "error": error});
        let record = self.state().registry.update(&self.app, &self.id, |r| {
            r.state = state;
            r.ended_at = Some(now_ms());
            r.progress = None;
            r.result = Some(result.clone());
        });
        self.send(&Event::End { ok, command, data, error });
        if let (Some(record), Ok(dir)) = (record, super::history_dir(&self.app)) {
            requests::append_history(&dir, &record);
        }
    }
}

pub fn fmt_duration(d: Duration) -> String {
    let secs = d.as_secs();
    if secs % 3600 == 0 && secs > 0 {
        format!("{}h", secs / 3600)
    } else if secs % 60 == 0 && secs > 0 {
        format!("{}m", secs / 60)
    } else {
        format!("{secs}s")
    }
}
