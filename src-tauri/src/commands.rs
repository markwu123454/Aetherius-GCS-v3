use std::{
    collections::HashMap,
    sync::{atomic::Ordering, Mutex},
    time::{Duration, Instant},
};

use mavlink::{
    dialects::ardupilotmega::{
        COMMAND_ACK_DATA, COMMAND_LONG_DATA, MavCmd, MavMessage, MavResult,
    },
    MavConnection,
};
use num_traits::ToPrimitive;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

use crate::link::LinkState;

#[derive(Default)]
pub struct CommandState {
    pending: Mutex<HashMap<u32, oneshot::Sender<MavResult>>>,
}

#[derive(Debug)]
pub enum CommandError {
    NotConnected,
    Timeout,
    LinkReset,
}

fn build_command_long(command: MavCmd, params: [f32; 7], target: (u8, u8), confirmation: u8) -> COMMAND_LONG_DATA {
    COMMAND_LONG_DATA {
        param1: params[0],
        param2: params[1],
        param3: params[2],
        param4: params[3],
        param5: params[4],
        param6: params[5],
        param7: params[6],
        command,
        target_system: target.0,
        target_component: target.1,
        confirmation,
    }
}

pub async fn send_sync(
    app: &AppHandle,
    command: MavCmd,
    params: [f32; 7],
    target: (u8, u8),
    timeout: Duration,
) -> Result<MavResult, CommandError> {
    let command_id = command
        .to_u32()
        .expect("MavCmd is #[repr(u32)] and always converts");

    let link = app.state::<LinkState>();
    let generation = link.generation.load(Ordering::SeqCst);

    let connection = link
        .connection
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or(CommandError::NotConnected)?;

    let (tx, mut rx) = oneshot::channel();
    app.state::<CommandState>()
        .pending
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(command_id, tx);

    let deadline = Instant::now() + timeout;
    let mut confirmation: u8 = 0;

    let outcome = loop {
        let data = build_command_long(command, params, target, confirmation);
        let _ = connection.send_default(&MavMessage::COMMAND_LONG(data));

        if link.generation.load(Ordering::SeqCst) != generation {
            break Err(CommandError::LinkReset);
        }

        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break Err(CommandError::Timeout);
        }

        match tokio::time::timeout(remaining.min(Duration::from_secs(1)), &mut rx).await {
            Ok(Ok(result)) => break Ok(result),
            Ok(Err(_)) => break Err(CommandError::Timeout),
            Err(_) => {
                confirmation = confirmation.saturating_add(1);
            }
        }
    };

    app.state::<CommandState>()
        .pending
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&command_id);

    outcome
}

/// How a command ended that, if it succeeds, can take the vehicle off the
/// air before its ack gets back.
pub enum AckOrSilence {
    Ack(MavResult),
    /// No ack, but the vehicle stopped sending heartbeats — it acted on the
    /// command (a reboot) and the ack was lost on the way out.
    Silent,
}

/// `send_sync` for a command whose success silences the vehicle (reboot).
/// Between attempts, a vehicle that has stopped sending heartbeats counts
/// as having acted on it rather than as a reason to retry: a retry then
/// would land on the freshly booted vehicle and reboot it a second time.
pub async fn send_expecting_silence(
    app: &AppHandle,
    command: MavCmd,
    params: [f32; 7],
    target: (u8, u8),
    attempts: u8,
    silence: Duration,
) -> Result<AckOrSilence, CommandError> {
    let command_id = command
        .to_u32()
        .expect("MavCmd is #[repr(u32)] and always converts");

    let link = app.state::<LinkState>();
    let generation = link.generation.load(Ordering::SeqCst);

    let connection = link
        .connection
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or(CommandError::NotConnected)?;

    let (tx, mut rx) = oneshot::channel();
    app.state::<CommandState>()
        .pending
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(command_id, tx);

    let heartbeat_silent = || {
        let last = link.last_heartbeat_ms.load(Ordering::SeqCst);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        last != 0 && now.saturating_sub(last) > silence.as_millis() as u64
    };

    let mut outcome = Err(CommandError::Timeout);
    for confirmation in 0..attempts {
        let data = build_command_long(command, params, target, confirmation);
        let _ = connection.send_default(&MavMessage::COMMAND_LONG(data));

        match tokio::time::timeout(Duration::from_secs(1), &mut rx).await {
            Ok(Ok(result)) => {
                outcome = Ok(AckOrSilence::Ack(result));
                break;
            }
            Ok(Err(_)) => break,
            Err(_) => {}
        }
        if link.generation.load(Ordering::SeqCst) != generation {
            outcome = Err(CommandError::LinkReset);
            break;
        }
        if heartbeat_silent() {
            outcome = Ok(AckOrSilence::Silent);
            break;
        }
    }

    app.state::<CommandState>()
        .pending
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&command_id);

    outcome
}

pub fn send_async(
    app: &AppHandle,
    command: MavCmd,
    params: [f32; 7],
    target: (u8, u8),
) -> Result<(), CommandError> {
    let connection = app
        .state::<LinkState>()
        .connection
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or(CommandError::NotConnected)?;

    let data = build_command_long(command, params, target, 0);
    let _ = connection.send_default(&MavMessage::COMMAND_LONG(data));
    Ok(())
}

pub fn on_ack(app: &AppHandle, data: &COMMAND_ACK_DATA) {
    let _ = app.emit(
        "command-ack",
        serde_json::json!({
            "command": format!("{:?}", data.command),
            "result": format!("{:?}", data.result),
            "accepted": matches!(data.result, MavResult::MAV_RESULT_ACCEPTED),
        }),
    );

    // A long-running command (gyro calibration, others like it) acks
    // MAV_RESULT_IN_PROGRESS immediately and sends the real accepted/failed
    // result later, for the same command id — resolving the pending sender
    // here would hand send_sync's caller that placeholder instead of the
    // actual outcome. Leave it pending and wait for the terminal ack.
    if matches!(data.result, MavResult::MAV_RESULT_IN_PROGRESS) {
        return;
    }

    let Some(command_id) = data.command.to_u32() else {
        return;
    };

    if let Some(sender) = app
        .state::<CommandState>()
        .pending
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&command_id)
    {
        let _ = sender.send(data.result);
    }
}