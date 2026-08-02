use serde::Deserialize;
use tauri::{AppHandle, Manager};

use mavlink::dialects::ardupilotmega::{MavCmd, MavModeFlag, MavResult};

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

    match commands::send_sync(&app, mav_cmd, params, target, std::time::Duration::from_secs(3)).await {
        Ok(MavResult::MAV_RESULT_ACCEPTED) => Ok(()),
        Ok(other) => Err(format!("vehicle rejected the command: {other:?}")),
        Err(error) => Err(describe(error)),
    }
}