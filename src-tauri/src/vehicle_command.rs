use serde::Deserialize;
use tauri::{AppHandle, Manager};

use mavlink::dialects::ardupilotmega::{MavCmd, MavMessage, MavModeFlag, MavResult, RC_CHANNELS_OVERRIDE_DATA};

use crate::commands::{self, CommandError};
use crate::link::LinkState;

/// One MAVLink `COMMAND_LONG` action, as ordered from the UI. Each variant
/// carries exactly the parameters that command needs — nothing here knows
/// about MAVLink's flat `param1..param7` layout, `to_mav_command` is the
/// only place that translation happens.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum VehicleCommand {
    Arm,
    Disarm,
    SetMode { mode: u32 },
    Takeoff { altitude: f32 },
    ReturnToLaunch,
    Land,
    StartMission,
    Reboot,
    RebootToBootloader,
    StartRadioCalibration,
    StopRadioCalibration,
    StartAccelCalibration,
    ConfirmAccelPosition { position: f32 },
    CancelAccelCalibration,
    StartGyroCalibration,
    StartCompassCalibration,
    CancelCompassCalibration,
}

/// Translate an app-level command into the `MavCmd` and seven-float param
/// block `COMMAND_LONG` actually carries. Unused params are left at 0.0,
/// which is `COMMAND_LONG`'s documented meaning for "empty".
fn to_mav_command(command: &VehicleCommand) -> (MavCmd, [f32; 7]) {
    match command {
        VehicleCommand::Arm => (
            MavCmd::MAV_CMD_COMPONENT_ARM_DISARM,
            [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        ),
        VehicleCommand::Disarm => (
            MavCmd::MAV_CMD_COMPONENT_ARM_DISARM,
            [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        ),
        VehicleCommand::SetMode { mode } => (
            MavCmd::MAV_CMD_DO_SET_MODE,
            [
                MavModeFlag::MAV_MODE_FLAG_CUSTOM_MODE_ENABLED.bits() as f32,
                *mode as f32,
                0.0,
                0.0,
                0.0,
                0.0,
                0.0,
            ],
        ),
        VehicleCommand::Takeoff { altitude } => (
            MavCmd::MAV_CMD_NAV_TAKEOFF,
            [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, *altitude],
        ),
        VehicleCommand::ReturnToLaunch => (
            MavCmd::MAV_CMD_NAV_RETURN_TO_LAUNCH,
            [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        ),
        VehicleCommand::Land => (
            MavCmd::MAV_CMD_NAV_LAND,
            [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        ),
        VehicleCommand::StartMission => (
            MavCmd::MAV_CMD_MISSION_START,
            [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        ),
        VehicleCommand::Reboot => (
            MavCmd::MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN,
            [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        ),
        VehicleCommand::RebootToBootloader => (
            // param1 = 3: ArduPilot's own documented meaning is "reboot and
            // hold in the bootloader" rather than booting back into flight
            // firmware — sent before the firmware-flashing flow drops the
            // MAVLink link and starts talking the raw bootloader protocol on
            // the same serial port.
            MavCmd::MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN,
            [3.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        ),
        VehicleCommand::StartRadioCalibration => (
            // ArduPilot switches to streaming raw, unscaled RC input while
            // this is active — the whole reason it's safe to drive sticks to
            // their extremes without those extremes doing anything to the
            // vehicle. param4 = 1 is what QGroundControl itself sends here.
            MavCmd::MAV_CMD_PREFLIGHT_CALIBRATION,
            [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0],
        ),
        VehicleCommand::StopRadioCalibration => (
            MavCmd::MAV_CMD_PREFLIGHT_CALIBRATION,
            [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        ),
        VehicleCommand::StartAccelCalibration => (
            // Same shape as `Vehicle::startCalibration` for the 6-position
            // accel cal in QGroundControl: param5 = 1. No ack is required
            // for the calibration to actually proceed — the vehicle drives
            // the rest of the sequence itself by pushing
            // MAV_CMD_ACCELCAL_VEHICLE_POS back to us (see dispatch.rs).
            MavCmd::MAV_CMD_PREFLIGHT_CALIBRATION,
            [0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        ),
        VehicleCommand::ConfirmAccelPosition { position } => (
            // Confirms whichever position the vehicle is currently waiting
            // on. ArduPilot checks param1 against its own current step
            // (AP_AccelCal::gcs_vehicle_position) before advancing — this is
            // the real command, not QGroundControl's legacy trick of sending
            // back an unrelated COMMAND_ACK (ArduPilot's own source calls
            // that out as unchecked and asks GCSs to move off it).
            MavCmd::MAV_CMD_ACCELCAL_VEHICLE_POS,
            [*position, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        ),
        VehicleCommand::CancelAccelCalibration => (
            MavCmd::MAV_CMD_PREFLIGHT_CALIBRATION,
            [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        ),
        VehicleCommand::StartGyroCalibration => (
            // ArduPilot's whole gyro-cal flow: sample bias at rest and store
            // INS_GYROFFS_*. No position sequence like accel — one command, held
            // open for the few seconds it takes to sample.
            MavCmd::MAV_CMD_PREFLIGHT_CALIBRATION,
            [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        ),
        VehicleCommand::StartCompassCalibration => (
            // mask=0 (all fitted compasses), retry=1, autosave=1 (skip the
            // separate MAV_CMD_DO_ACCEPT_MAG_CAL step), delay=0, autoreboot=0 —
            // the frontend prompts for its own reboot instead of ArduPilot
            // forcing one immediately.
            MavCmd::MAV_CMD_DO_START_MAG_CAL,
            [0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0],
        ),
        VehicleCommand::CancelCompassCalibration => (
            MavCmd::MAV_CMD_DO_CANCEL_MAG_CAL,
            [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        ),
    }
}

fn describe(error: CommandError) -> String {
    match error {
        CommandError::NotConnected => "not connected to a vehicle".to_string(),
        CommandError::Timeout => "vehicle did not acknowledge the command in time".to_string(),
        CommandError::LinkReset => "link was reset while the command was in flight".to_string(),
    }
}

/// The one Tauri entrypoint for every vehicle action. `lib.rs` registers this
/// function alone — adding a new action later means a new `VehicleCommand`
/// variant and a new arm in `to_mav_command`, not a new `invoke_handler`
/// entry.
#[tauri::command]
pub async fn send_vehicle_command(app: AppHandle, command: VehicleCommand) -> Result<(), String> {
    let target = app
        .state::<LinkState>()
        .target
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .ok_or_else(|| "no vehicle has been heard from yet".to_string())?;

    let (mav_cmd, params) = to_mav_command(&command);

    match commands::send_sync(&app, mav_cmd, params, target, timeout_for(&command)).await {
        Ok(MavResult::MAV_RESULT_ACCEPTED) => Ok(()),
        Ok(other) => Err(format!("vehicle rejected the command: {other:?}")),
        Err(error) => Err(describe(error)),
    }
}

/// How long to wait for a command's terminal `COMMAND_ACK`. Most commands
/// resolve in well under a second; gyro calibration is the exception — it
/// holds the link for the several seconds ArduPilot spends sampling bias at
/// rest before the real accepted/failed result arrives (see
/// `commands::on_ack`'s handling of the intermediate `MAV_RESULT_IN_PROGRESS`
/// ack that comes first).
fn timeout_for(command: &VehicleCommand) -> std::time::Duration {
    match command {
        VehicleCommand::StartGyroCalibration => std::time::Duration::from_secs(8),
        _ => std::time::Duration::from_secs(3),
    }
}

/// Fire-and-forget `RC_CHANNELS_OVERRIDE` — the keyboard-stick joystick's one
/// path to the vehicle. It does NOT go through `commands::send_sync`/
/// `send_async`: those exist to send a `COMMAND_LONG` and wait for its
/// `COMMAND_ACK`, but `RC_CHANNELS_OVERRIDE` has no ack at all — MAVLink
/// gives no way to confirm one arrived. The frontend's own sense of whether
/// this is working comes from watching `RC_CHANNELS` telemetry echo the
/// override back, not from this call succeeding.
///
/// `channels` is always exactly 8 entries, one per RC channel 1-8 in order.
/// `65535` (`u16::MAX`) leaves that channel exactly as it is — the sentinel
/// MAVLink defines as "ignore this field" for this specific message. `0`
/// releases that channel back to the RC radio. Any other value is a raw
/// microsecond PWM value to command. The frontend never sends `0` today —
/// it only ever holds a channel — but the message supports it for whenever
/// a "give control back" action gets added.
#[tauri::command]
pub fn send_rc_override(app: AppHandle, channels: [u16; 8]) -> Result<(), String> {
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

    let data = RC_CHANNELS_OVERRIDE_DATA {
        chan1_raw: channels[0],
        chan2_raw: channels[1],
        chan3_raw: channels[2],
        chan4_raw: channels[3],
        chan5_raw: channels[4],
        chan6_raw: channels[5],
        chan7_raw: channels[6],
        chan8_raw: channels[7],
        target_system: target.0,
        target_component: target.1,
    };

    let _ = connection.send_default(&MavMessage::RC_CHANNELS_OVERRIDE(data));
    Ok(())
}