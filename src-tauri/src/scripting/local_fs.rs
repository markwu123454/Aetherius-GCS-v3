use std::{
    fs,
    path::{Component, Path, PathBuf},
};

use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEntry {
    pub name: String,
    pub is_dir: bool,
}

fn scripts_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("scripts");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Every path this module accepts from the frontend is relative and
/// forward-slash separated (`"utils/helper.lua"`, `""` for a root). This is
/// the one check every one of them goes through before touching a real
/// filesystem or being embedded in an FTP request: only "normal" components
/// allowed — no `..`, no drive prefixes, no root anchors — so nothing can
/// walk outside the tree it was handed for.
pub(super) fn validate_relative_path(relative: &str) -> Result<(), String> {
    for component in Path::new(relative).components() {
        if !matches!(component, Component::Normal(_)) {
            return Err("invalid path".to_string());
        }
    }
    Ok(())
}

pub(super) fn resolve_local_path(app: &AppHandle, relative: &str) -> Result<PathBuf, String> {
    validate_relative_path(relative)?;
    let mut resolved = scripts_dir(app)?;
    for component in Path::new(relative).components() {
        resolved.push(component);
    }
    Ok(resolved)
}

#[tauri::command]
pub fn list_local_dir(app: AppHandle, path: String) -> Result<Vec<LocalEntry>, String> {
    let dir = resolve_local_path(&app, &path)?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let is_dir = entry.metadata().map_err(|e| e.to_string())?.is_dir();
        entries.push(LocalEntry {name: entry.file_name().to_string_lossy().to_string(), is_dir});
    }
    Ok(entries)
}

#[tauri::command]
pub fn read_local_file(app: AppHandle, path: String) -> Result<String, String> {
    fs::read_to_string(resolve_local_path(&app, &path)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_local_file(app: AppHandle, path: String, content: String) -> Result<(), String> {
    fs::write(resolve_local_path(&app, &path)?, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_local_file(app: AppHandle, path: String) -> Result<(), String> {
    let resolved = resolve_local_path(&app, &path)?;
    if resolved.exists() {
        return Err("already exists".to_string());
    }
    fs::write(resolved, "").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_local_dir(app: AppHandle, path: String) -> Result<(), String> {
    let resolved = resolve_local_path(&app, &path)?;
    if resolved.exists() {
        return Err("already exists".to_string());
    }
    fs::create_dir(resolved).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_local(app: AppHandle, path: String) -> Result<(), String> {
    let resolved = resolve_local_path(&app, &path)?;
    if resolved.is_dir() {
        fs::remove_dir_all(resolved).map_err(|e| e.to_string())
    } else {
        fs::remove_file(resolved).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn rename_local(app: AppHandle, old_path: String, new_path: String, overwrite: bool) -> Result<(), String> {
    let old_resolved = resolve_local_path(&app, &old_path)?;
    let new_resolved = resolve_local_path(&app, &new_path)?;
    if new_resolved.exists() {
        if !overwrite || new_resolved.is_dir() {
            return Err("already exists".to_string());
        }
        fs::remove_file(&new_resolved).map_err(|e| e.to_string())?;
    }
    fs::rename(old_resolved, new_resolved).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn absolute_local_path(app: AppHandle, path: String) -> Result<String, String> {
    Ok(resolve_local_path(&app, &path)?.to_string_lossy().to_string())
}