//! Per-vehicle persistent storage: which directory a connected board's own
//! data (dataflash logs today, more later just by adding sibling folders)
//! lives under, and the small metadata file (`fc.json`) that directory can
//! hold — a display name today, room to grow. Keyed off
//! `AUTOPILOT_VERSION`'s hardware UID (`VehicleSnapshot::board_uid`, set in
//! `telemetry/autopilot_version.rs`), not `sysid` — that's just the
//! configurable `SYSID_THISMAV` parameter and collides constantly across
//! different vehicles left at its default.

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::link::LinkState;

/// Folder name used when the connected board hasn't reported a UID (yet,
/// or ever — very old firmware predates both `uid` and `uid2`) — a real
/// bucket rather than refusing to save that vehicle's data.
const UNKNOWN_VEHICLE_DIR: &str = "unknown";

/// The directory the currently connected vehicle's own data lives under —
/// `$APPDATA/<uid-hex>/`, or `$APPDATA/unknown/` if it hasn't reported a
/// UID. Created if it doesn't exist yet. Doesn't require a link itself —
/// callers needing "must be connected" (like `download_log`) already check
/// that via `logs::current_link` before reaching here; this only cares
/// whether a UID happens to be known.
pub fn vehicle_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let uid = {
        let link = app.state::<LinkState>();
        let snapshot = link.snapshot.lock().unwrap_or_else(|e| e.into_inner());
        snapshot.board_uid.clone()
    };
    let name = uid.unwrap_or_else(|| UNKNOWN_VEHICLE_DIR.to_string());
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join(name);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VehicleProfile {
    pub display_name: Option<String>,
}

fn profile_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(vehicle_dir(app)?.join("fc.json"))
}

/// Reads the connected vehicle's stored profile — a default (empty) one if
/// nothing's been saved for it yet, not an error, since "no profile saved
/// yet" is the ordinary state for a board seen for the first time.
#[tauri::command]
pub fn get_vehicle_profile(app: AppHandle) -> Result<VehicleProfile, String> {
    let path = profile_path(&app)?;
    if !path.exists() {
        return Ok(VehicleProfile::default());
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_vehicle_profile(app: AppHandle, profile: VehicleProfile) -> Result<(), String> {
    let path = profile_path(&app)?;
    let content = serde_json::to_string_pretty(&profile).map_err(|e| e.to_string())?;
    fs::write(&path, content).map_err(|e| e.to_string())
}

/// One-time migration for logs downloaded before per-vehicle folders
/// existed. Anything sitting directly in the old flat `$APPDATA/logs/` has
/// no recorded vehicle identity, so it moves into `unknown/logs/` rather
/// than being orphaned or silently deleted. Called once from `lib.rs` at
/// startup; a no-op on every run after the first, since the old `logs/`
/// directory won't exist anymore once this has run once.
pub fn migrate_legacy_logs(app: &AppHandle) {
    let Ok(app_data) = app.path().app_data_dir() else { return };
    migrate_legacy_logs_in(&app_data);
}

/// The actual move logic, taking a plain directory rather than an
/// `AppHandle` so it can run against a temp directory in tests instead of
/// the real `$APPDATA`.
fn migrate_legacy_logs_in(app_data: &Path) {
    let old_dir = app_data.join("logs");
    if !old_dir.is_dir() {
        return;
    }
    let new_dir = app_data.join(UNKNOWN_VEHICLE_DIR).join("logs");
    if fs::create_dir_all(&new_dir).is_err() {
        return;
    }
    let Ok(entries) = fs::read_dir(&old_dir) else { return };
    for entry in entries.flatten() {
        let from = entry.path();
        if from.is_file() {
            let _ = fs::rename(&from, new_dir.join(entry.file_name()));
        }
    }
    // Only removed once empty — a stray non-log file (or a rename that
    // failed) leaves the old directory behind rather than losing it
    // silently.
    let _ = fs::remove_dir(&old_dir);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moves_flat_logs_into_unknown_bucket() {
        let root = std::env::temp_dir().join(format!("aetherius-migrate-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let old_dir = root.join("logs");
        fs::create_dir_all(&old_dir).unwrap();
        fs::write(old_dir.join("00000021.bin"), b"flight data").unwrap();

        migrate_legacy_logs_in(&root);

        let moved = root.join(UNKNOWN_VEHICLE_DIR).join("logs").join("00000021.bin");
        assert!(moved.exists(), "log should have moved into unknown/logs/");
        assert_eq!(fs::read(&moved).unwrap(), b"flight data");
        assert!(!old_dir.exists(), "old flat logs/ dir should be removed once empty");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn is_a_no_op_when_there_is_nothing_to_migrate() {
        let root = std::env::temp_dir().join(format!("aetherius-migrate-test-empty-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();

        migrate_legacy_logs_in(&root); // shouldn't panic or create anything

        assert!(!root.join(UNKNOWN_VEHICLE_DIR).exists());

        fs::remove_dir_all(&root).ok();
    }
}
