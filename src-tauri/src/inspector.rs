use std::{
    collections::{HashMap, VecDeque},
    sync::Mutex,
    time::{Duration, Instant},
};

use mavlink::{dialects::ardupilotmega::MavMessage, Message};
use tauri::{AppHandle, Emitter, Manager};

/// Snapshots are pushed at most this often, regardless of how fast the wire
/// itself is moving — telemetry alone can run up to 20 Hz, and several
/// message types besides, so pushing one event per message would flood the
/// frontend with updates nobody can read that fast anyway. This bounds the
/// emit rate independent of link traffic.
const EMIT_INTERVAL: Duration = Duration::from_millis(200);

/// Rolling window the per-type Hz estimate is computed over: long enough to
/// smooth a bursty sender (e.g. a run of STATUSTEXT chunks landing
/// back-to-back), short enough that a message type which stops arriving
/// reads as "stopped" within a couple of seconds instead of staying pinned
/// at its last average.
const HZ_WINDOW: Duration = Duration::from_secs(2);

/// How many of a type's most recent messages are kept for the detail view's
/// scrolling history — bounded so a high-rate type (ATTITUDE, VFR_HUD) can't
/// grow this without limit.
const MAX_HISTORY: usize = 10;

struct TypeStats {
    count: u64,
    /// Arrival timestamps within `HZ_WINDOW`, oldest first — pruned on every
    /// observation rather than kept exact, since only the count within the
    /// window is ever read back out.
    recent: VecDeque<Instant>,
    last_seen: Instant,
    /// The most recent `MAX_HISTORY` messages, oldest first, each serialized
    /// whole — `MavMessage` derives `Serialize` with `#[serde(tag = "type")]`
    /// (the `serde` feature is on by default for the `mavlink` crate and
    /// nothing in this project's Cargo.toml turns it off), so each entry
    /// already carries both the variant name and every field with no
    /// hand-written per-message-type mapping to maintain.
    history: VecDeque<serde_json::Value>,
}

#[derive(Default)]
pub struct InspectorState {
    stats: Mutex<HashMap<&'static str, TypeStats>>,
    last_emit: Mutex<Option<Instant>>,
}

/// Called from `dispatch::route` for every inbound message, ahead of (and
/// regardless of) whatever domain handler below it recognizes — this owns no
/// interpretation of any message, just records that it arrived, so it never
/// needs updating when a new message type gains real handling elsewhere.
pub fn observe(app: &AppHandle, message: &MavMessage) {
    {
        let state = app.state::<InspectorState>();
        let mut stats = state.stats.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        let entry = stats.entry(message.message_name()).or_insert_with(|| TypeStats {
            count: 0,
            recent: VecDeque::new(),
            last_seen: now,
            history: VecDeque::new(),
        });
        entry.count += 1;
        entry.last_seen = now;
        entry.recent.push_back(now);
        while let Some(&front) = entry.recent.front() {
            if now.duration_since(front) > HZ_WINDOW {
                entry.recent.pop_front();
            } else {
                break;
            }
        }
        entry.history.push_back(serde_json::to_value(message).unwrap_or(serde_json::Value::Null));
        if entry.history.len() > MAX_HISTORY {
            entry.history.pop_front();
        }
    }
    maybe_emit(app);
}

/// A rate needs two points to exist at all — one arrival has no interval to
/// measure yet, so this reports `0.0` (not-yet-known) rather than the
/// misleading `1 / HZ_WINDOW` a naive "count in window ÷ window size" would
/// give a message type seen exactly once.
///
/// With two or more, the rate is the actual span between the oldest and
/// newest sample still in the window, not the fixed window size — dividing
/// by a constant `HZ_WINDOW` regardless of how much of it is really spanned
/// understates a fast sender until the window happens to fill up (two
/// samples 100ms apart, a real 10 Hz burst, would otherwise read as
/// `2 / 2s = 1 Hz` for the next ~1.9 seconds).
fn type_hz(recent: &VecDeque<Instant>) -> f32 {
    let (Some(&oldest), Some(&newest)) = (recent.front(), recent.back()) else {
        return 0.0;
    };
    let span = newest.duration_since(oldest).as_secs_f32();
    if span <= 0.0 {
        return 0.0;
    }
    (recent.len() - 1) as f32 / span
}

fn maybe_emit(app: &AppHandle) {
    let state = app.state::<InspectorState>();
    {
        let mut last_emit = state.last_emit.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        if let Some(previous) = *last_emit {
            if now.duration_since(previous) < EMIT_INTERVAL {
                return;
            }
        }
        *last_emit = Some(now);
    }

    let stats = state.stats.lock().unwrap_or_else(|e| e.into_inner());
    let now = Instant::now();
    let rows: Vec<serde_json::Value> = stats
        .iter()
        .map(|(name, s)| {
            // Newest first — the detail view reads top-to-bottom as
            // "most recent first", same direction as the console.
            let history: Vec<&serde_json::Value> = s.history.iter().rev().collect();
            serde_json::json!({
                "name": name,
                "count": s.count,
                "hz": type_hz(&s.recent),
                "ageMs": now.duration_since(s.last_seen).as_millis() as u64,
                "history": history,
            })
        })
        .collect();
    let _ = app.emit("inspector-stats", rows);
}

/// Zeroes every counter without waiting for the next natural traffic burst —
/// the frontend's "Clear" action. Message types themselves are dropped too,
/// not just their counts, so a type that's stopped arriving disappears from
/// the table instead of sitting at a stale age forever.
#[tauri::command]
pub fn reset_inspector_stats(app: AppHandle) {
    let state = app.state::<InspectorState>();
    state.stats.lock().unwrap_or_else(|e| e.into_inner()).clear();
    let _ = app.emit("inspector-stats", Vec::<serde_json::Value>::new());
}
