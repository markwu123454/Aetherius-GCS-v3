use std::{
    fs,
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

use serde::Serialize;

use crate::scripting::LocalEntry;

/// Every relative path this module accepts from the frontend is
/// forward-slash separated (`"utils/thing.lua"`, `""` for the root) — the
/// same contract as the local/vehicle scripting trees (see
/// `scripting::local_fs::validate_relative_path`), re-checked here rather
/// than shared, since an SD card root is an arbitrary user-chosen folder
/// rather than a path this app controls: only "normal" components are
/// allowed, so nothing can walk out of the folder the user picked via `..`,
/// a drive prefix, or a root anchor.
fn validate_relative_path(relative: &str) -> Result<(), String> {
    for component in Path::new(relative).components() {
        if !matches!(component, Component::Normal(_)) {
            return Err("invalid path".to_string());
        }
    }
    Ok(())
}

fn resolve(root: &str, relative: &str) -> Result<PathBuf, String> {
    validate_relative_path(relative)?;
    let mut resolved = PathBuf::from(root);
    for component in Path::new(relative).components() {
        resolved.push(component);
    }
    Ok(resolved)
}

#[tauri::command]
pub fn list_sdcard_dir(root: String, path: String) -> Result<Vec<LocalEntry>, String> {
    let dir = resolve(&root, &path)?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let is_dir = entry.metadata().map_err(|e| e.to_string())?.is_dir();
        entries.push(LocalEntry {name: entry.file_name().to_string_lossy().to_string(), is_dir});
    }
    Ok(entries)
}

#[tauri::command]
pub fn read_sdcard_file(root: String, path: String) -> Result<String, String> {
    fs::read_to_string(resolve(&root, &path)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_sdcard_file(root: String, path: String, content: String) -> Result<(), String> {
    fs::write(resolve(&root, &path)?, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_sdcard_file(root: String, path: String) -> Result<(), String> {
    let resolved = resolve(&root, &path)?;
    if resolved.exists() {
        return Err("already exists".to_string());
    }
    fs::write(resolved, "").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_sdcard_dir(root: String, path: String) -> Result<(), String> {
    let resolved = resolve(&root, &path)?;
    if resolved.exists() {
        return Err("already exists".to_string());
    }
    fs::create_dir(resolved).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_sdcard(root: String, path: String) -> Result<(), String> {
    let resolved = resolve(&root, &path)?;
    if resolved.is_dir() {
        fs::remove_dir_all(resolved).map_err(|e| e.to_string())
    } else {
        fs::remove_file(resolved).map_err(|e| e.to_string())
    }
}

/// Same `overwrite` contract as `scripting::rename_local`.
#[tauri::command]
pub fn rename_sdcard(root: String, old_path: String, new_path: String, overwrite: bool) -> Result<(), String> {
    let old_resolved = resolve(&root, &old_path)?;
    let new_resolved = resolve(&root, &new_path)?;
    if new_resolved.exists() {
        if !overwrite || new_resolved.is_dir() {
            return Err("already exists".to_string());
        }
        fs::remove_file(&new_resolved).map_err(|e| e.to_string())?;
    }
    fs::rename(old_resolved, new_resolved).map_err(|e| e.to_string())
}

// --- Discovery: logs and param files can be anywhere under the chosen
// root (a real SD card nests dataflash logs a couple of folders down, e.g.
// `APM/LOGS/*.BIN`), so both are found by a bounded recursive scan rather
// than requiring the user to point the folder picker at the exact
// subfolder. ---

const MAX_SCAN_ENTRIES: usize = 20_000;
const MAX_SCAN_DEPTH: usize = 8;

/// Collects every file under `dir` whose extension matches `ext`
/// (case-insensitive) into `out`, as absolute paths. An unreadable
/// subfolder (permissions, a broken removable-media mount) just
/// contributes nothing rather than failing the whole scan — one bad
/// folder on the card shouldn't hide every log that isn't in it.
fn find_by_extension(dir: &Path, depth: usize, ext: &str, out: &mut Vec<PathBuf>) {
    if depth > MAX_SCAN_DEPTH || out.len() >= MAX_SCAN_ENTRIES {
        return;
    }
    let Ok(read) = fs::read_dir(dir) else { return };
    for entry in read.flatten() {
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else { continue };
        if metadata.is_dir() {
            find_by_extension(&path, depth + 1, ext, out);
        } else if path.extension().is_some_and(|e| e.eq_ignore_ascii_case(ext)) {
            out.push(path);
        }
        if out.len() >= MAX_SCAN_ENTRIES {
            return;
        }
    }
}

fn to_relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/")
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SdCardLogEntry {
    pub relative_path: String,
    pub absolute_path: String,
    pub size: u64,
    /// Seconds since the Unix epoch — `None` if the filesystem can't report
    /// a modified time (some removable-media filesystems don't).
    pub modified_unix: Option<u64>,
}

/// By file name (root-relative path, ascending) — ArduPilot names these
/// sequentially and zero-padded (`00000001.BIN`, `00000002.BIN`, ...), so
/// this also reads chronologically in the common case, and stays stable
/// regardless of what a card reader or copy operation did to file mtimes.
#[tauri::command]
pub fn list_sdcard_logs(root: String) -> Result<Vec<SdCardLogEntry>, String> {
    let root_path = PathBuf::from(&root);
    let mut paths = Vec::new();
    find_by_extension(&root_path, 0, "bin", &mut paths);
    let mut entries: Vec<SdCardLogEntry> = paths
        .into_iter()
        .filter_map(|path| {
            let metadata = fs::metadata(&path).ok()?;
            let modified_unix = metadata.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs());
            Some(SdCardLogEntry {
                relative_path: to_relative(&root_path, &path),
                absolute_path: path.to_string_lossy().to_string(),
                size: metadata.len(),
                modified_unix,
            })
        })
        .collect();
    entries.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(entries)
}

// --- Scripts: ArduPilot has one documented place it looks for Lua scripts
// (`APM/scripts`, the same virtual path the live vehicle mirror exposes
// over MAVLink FTP — see `scripting::scriptFiles`'s `/APM/scripts`
// comment), so the Scripts page roots itself there directly instead of
// making the operator browse down to it through whatever else is on the
// card. ---

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptsDirResolution {
    /// Absolute path — either where scripts were actually found, or (when
    /// `exists` is `false`) the canonical `APM/scripts` location a
    /// "create it" action should create.
    pub path: String,
    pub exists: bool,
}

fn has_lua_file(dir: &Path) -> bool {
    let Ok(read) = fs::read_dir(dir) else { return false };
    read.flatten().any(|entry| entry.path().extension().is_some_and(|ext| ext.eq_ignore_ascii_case("lua")))
}

/// Tries, in order: the real SD card layout (`<root>/APM/scripts`), a
/// folder picker pointed at the `APM` folder itself (`<root>/scripts`),
/// and a folder picker pointed at the scripts folder itself (a `.lua` file
/// sitting directly in `root`). Falls back to the canonical
/// `<root>/APM/scripts` — not yet on disk — so the caller can offer to
/// create the one place ArduPilot will actually look.
#[tauri::command]
pub fn resolve_sdcard_scripts_dir(root: String) -> Result<ScriptsDirResolution, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err("not a folder".to_string());
    }
    let canonical = root_path.join("APM").join("scripts");
    for candidate in [&canonical, &root_path.join("scripts")] {
        if candidate.is_dir() {
            return Ok(ScriptsDirResolution {path: candidate.to_string_lossy().to_string(), exists: true});
        }
    }
    if has_lua_file(&root_path) {
        return Ok(ScriptsDirResolution {path: root, exists: true});
    }
    Ok(ScriptsDirResolution {path: canonical.to_string_lossy().to_string(), exists: false})
}

/// Creates `path` (and any missing parent — `APM` may not exist yet
/// either) — the "create it" counterpart to a `resolve_sdcard_scripts_dir`
/// result with `exists: false`. Takes the already-resolved absolute path
/// directly rather than a `root`/relative pair like every other command
/// here, since that resolution is exactly what produced it.
#[tauri::command]
pub fn create_sdcard_scripts_dir(path: String) -> Result<(), String> {
    fs::create_dir_all(PathBuf::from(&path)).map_err(|e| e.to_string())
}
