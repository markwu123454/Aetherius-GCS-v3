use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::State;

/// ArduPilot ships one binary per vehicle type. Reject anything unexpected
/// rather than passing a string from the UI straight into a command.
fn binary_for(vehicle: &str) -> Result<&'static str, String> {
    match vehicle {
        "ArduCopter" => Ok("arducopter"),
        "ArduPlane" => Ok("arduplane"),
        "ArduRover" => Ok("ardurover"),
        "ArduSub" => Ok("ardusub"),
        other => Err(format!("unknown vehicle: {other}")),
    }
}

/// Holds the SITL process while it runs. `Mutex` because Tauri calls commands
/// from multiple threads, and `Option` because most of the time nothing is running.
#[derive(Default)]
pub struct SitlState(pub Mutex<Option<Child>>);

impl SitlState {
    /// Kill the simulator if one is running. Safe to call when none is.
    pub fn shutdown(&self) {
        // A panic elsewhere poisons the mutex. During shutdown we still want the
        // child dead, so take the value regardless.
        let mut guard = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[tauri::command]
pub fn start_sitl(vehicle: String, state: State<SitlState>) -> Result<String, String> {
    let mut guard = state.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

    if guard.is_some() {
        return Err("SITL is already running".into());
    }

    let binary = binary_for(&vehicle)?;
    let model = model_for(&vehicle);

    let child = sitl_command(binary, model)
        .spawn()
        .map_err(|e| format!("could not start {binary}: {e}"))?;

    *guard = Some(child);
    Ok("tcp:127.0.0.1:5760".to_string())
}

#[tauri::command]
pub fn stop_sitl(state: State<SitlState>) -> Result<(), String> {
    state.shutdown();
    Ok(())
}

#[tauri::command]
pub fn list_serial_ports() -> Result<Vec<String>, String> {
    let ports = serialport::available_ports().map_err(|e| e.to_string())?;
    Ok(ports.into_iter().map(|p| p.port_name).collect())
}

/// Each vehicle binary expects a matching physics model. A mismatch is not an
/// error — SITL starts and then behaves like the wrong airframe.
fn model_for(vehicle: &str) -> &'static str {
    match vehicle {
        "ArduPlane" => "plane",
        "ArduRover" => "rover",
        "ArduSub" => "vectored",
        _ => "quad",
    }
}

/// Where a source build puts the SITL binaries inside WSL.
const WSL_ARDUPILOT_DIR: &str = "~/ardupilot";

/// Build the launch command.
///
/// On Windows the binaries live inside WSL, so this goes through `wsl.exe`.
/// A login shell (`bash -lc`) is used for two reasons: `~` needs expanding,
/// and SITL writes `eeprom.bin` into its working directory — which has to be a
/// Linux path, not the Windows cwd it would otherwise inherit.
#[cfg(target_os = "windows")]
fn sitl_command(binary: &str, model: &str) -> Command {
    let script = format!(
        "cd {WSL_ARDUPILOT_DIR} && ./build/sitl/bin/{binary} --model {model} --speedup 1 -I0"
    );

    let mut command = Command::new("wsl.exe");
    command.args(["--", "bash", "-lc", &script]);
    command
}

#[cfg(not(target_os = "windows"))]
fn sitl_command(binary: &str, model: &str) -> Command {
    let mut command = Command::new(binary);
    command.args(["--model", model, "--speedup", "1", "-I0"]);
    command
}