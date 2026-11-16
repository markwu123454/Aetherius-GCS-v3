//! The vehicle's text messages, kept on the backend for `console` and for
//! the Lua error check after a script push. The Console panel has its own
//! copy in the frontend; this one doesn't depend on the panel being open.

use std::{
    collections::VecDeque,
    sync::{atomic::{AtomicU64, Ordering}, Mutex},
};

use tauri::{AppHandle, Manager};

use super::{requests::now_ms, CliState};

const CAPACITY: usize = 2000;

pub const SEVERITIES: [&str; 8] = ["emergency", "alert", "critical", "error", "warning", "notice", "info", "debug"];

#[derive(Clone)]
pub struct Message {
    pub seq: u64,
    pub at: u64,
    pub severity: u8,
    pub text: String,
}

#[derive(Default)]
pub struct Buffer {
    messages: Mutex<VecDeque<Message>>,
    seq: AtomicU64,
}

impl Buffer {
    pub fn push(&self, severity: u8, text: &str) {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let mut messages = self.messages.lock().unwrap_or_else(|e| e.into_inner());
        if messages.len() >= CAPACITY {
            messages.pop_front();
        }
        messages.push_back(Message { seq, at: now_ms(), severity, text: text.to_string() });
    }

    pub fn all(&self) -> Vec<Message> {
        self.messages.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect()
    }

    pub fn after(&self, seq: u64) -> Vec<Message> {
        self.messages.lock().unwrap_or_else(|e| e.into_inner()).iter().filter(|m| m.seq > seq).cloned().collect()
    }

    pub fn last_seq(&self) -> u64 {
        self.seq.load(Ordering::SeqCst)
    }
}

/// Called for every complete STATUSTEXT (see `dispatch.rs`).
pub fn record(app: &AppHandle, severity: u8, text: &str) {
    if let Some(state) = app.try_state::<CliState>() {
        state.console.push(severity, text);
    }
}

pub fn severity_name(severity: u8) -> &'static str {
    SEVERITIES.get(severity as usize).copied().unwrap_or("info")
}

pub fn severity_from_name(name: &str) -> Option<u8> {
    SEVERITIES.iter().position(|s| s.eq_ignore_ascii_case(name)).map(|i| i as u8)
}

/// A Lua error as ArduPilot reports it: `Lua: <file>:<line>: <message>`
/// at error severity or worse, or any message naming a `.lua:` line.
pub fn is_lua_error(message: &Message) -> bool {
    let text = message.text.as_str();
    (text.starts_with("Lua") && message.severity <= 3) || (text.contains(".lua:") && message.severity <= 4)
}
