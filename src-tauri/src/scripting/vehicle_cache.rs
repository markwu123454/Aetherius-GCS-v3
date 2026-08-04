use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use mavlink::{dialects::ardupilotmega::MavMessage, MavConnection};
use tauri::{AppHandle, Manager};

use super::ftp_protocol::{
    create_vehicle_dir_inner, create_vehicle_file_inner, delete_vehicle_inner, ensure_vehicle_root,
    list_vehicle_dir_inner, read_vehicle_file_bytes, rename_vehicle_inner, vehicle_link, with_ftp_lock,
    write_vehicle_file_bytes, write_vehicle_file_inner, VehicleEntry,
};
use super::local_fs::{resolve_local_path, validate_relative_path};

fn vehicle_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("vehicle_scripts");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn resolve_vehicle_cache_path(app: &AppHandle, relative: &str) -> Result<PathBuf, String> {
    validate_relative_path(relative)?;
    let mut resolved = vehicle_cache_dir(app)?;
    for component in Path::new(relative).components() {
        resolved.push(component);
    }
    Ok(resolved)
}

fn sync_vehicle_dir<'a>(
    app: &'a AppHandle,
    connection: &'a Arc<dyn MavConnection<MavMessage> + Send + Sync>,
    target: (u8, u8),
    relative: String,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
    Box::pin(async move {
        let entries = list_vehicle_dir_inner(app, relative.clone()).await?;
        for entry in entries {
            let child = if relative.is_empty() { entry.name.clone() } else { format!("{relative}/{}", entry.name) };
            let cache_path = resolve_vehicle_cache_path(app, &child)?;
            if entry.is_dir {
                fs::create_dir_all(&cache_path).map_err(|e| e.to_string())?;
                sync_vehicle_dir(app, connection, target, child).await?;
            } else {
                let bytes = read_vehicle_file_bytes(app, connection, target, &child).await?;
                fs::write(&cache_path, bytes).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    })
}

async fn upload_to_vehicle_inner(app: &AppHandle, local_path: &str, remote_path: &str) -> Result<(), String> {
    validate_relative_path(remote_path)?;
    let bytes = fs::read(resolve_local_path(app, local_path)?).map_err(|e| e.to_string())?;
    let (connection, target) = vehicle_link(app)?;
    ensure_vehicle_root(app, &connection, target).await?;
    write_vehicle_file_bytes(app, &connection, target, remote_path, bytes).await
}

#[tauri::command]
pub fn list_vehicle_dir(app: AppHandle, path: String) -> Result<Vec<VehicleEntry>, String> {
    let dir = resolve_vehicle_cache_path(&app, &path)?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let is_dir = entry.metadata().map_err(|e| e.to_string())?.is_dir();
        entries.push(VehicleEntry {name: entry.file_name().to_string_lossy().to_string(), is_dir});
    }
    Ok(entries)
}

#[tauri::command]
pub fn read_vehicle_file(app: AppHandle, path: String) -> Result<String, String> {
    fs::read_to_string(resolve_vehicle_cache_path(&app, &path)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn write_vehicle_file(app: AppHandle, path: String, content: String) -> Result<(), String> {
    with_ftp_lock(&app, write_vehicle_file_inner(&app, path.clone(), content.clone())).await?;
    fs::write(resolve_vehicle_cache_path(&app, &path)?, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_vehicle_file(app: AppHandle, path: String) -> Result<(), String> {
    let cache_path = resolve_vehicle_cache_path(&app, &path)?;
    if cache_path.exists() {
        return Err("already exists".to_string());
    }
    with_ftp_lock(&app, create_vehicle_file_inner(&app, path.clone())).await?;
    fs::write(cache_path, "").map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_vehicle_dir(app: AppHandle, path: String) -> Result<(), String> {
    let cache_path = resolve_vehicle_cache_path(&app, &path)?;
    if cache_path.exists() {
        return Err("already exists".to_string());
    }
    with_ftp_lock(&app, create_vehicle_dir_inner(&app, path.clone())).await?;
    fs::create_dir(cache_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_vehicle(app: AppHandle, path: String, is_dir: bool) -> Result<(), String> {
    with_ftp_lock(&app, delete_vehicle_inner(&app, path.clone(), is_dir)).await?;
    let cache_path = resolve_vehicle_cache_path(&app, &path)?;
    if is_dir { fs::remove_dir_all(cache_path) } else { fs::remove_file(cache_path) }.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rename_vehicle(app: AppHandle, old_path: String, new_path: String, overwrite: bool) -> Result<(), String> {
    let new_cache_path = resolve_vehicle_cache_path(&app, &new_path)?;
    if new_cache_path.exists() && (!overwrite || new_cache_path.is_dir()) {
        return Err("already exists".to_string());
    }
    let existed = new_cache_path.exists();
    with_ftp_lock(&app, async {
        if existed {
            delete_vehicle_inner(&app, new_path.clone(), false).await?;
        }
        rename_vehicle_inner(&app, old_path.clone(), new_path.clone()).await
    })
        .await?;
    if existed {
        fs::remove_file(&new_cache_path).map_err(|e| e.to_string())?;
    }
    fs::rename(resolve_vehicle_cache_path(&app, &old_path)?, new_cache_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn upload_to_vehicle(app: AppHandle, local_path: String, remote_path: String) -> Result<(), String> {
    with_ftp_lock(&app, upload_to_vehicle_inner(&app, &local_path, &remote_path)).await?;
    let bytes = fs::read(resolve_local_path(&app, &local_path)?).map_err(|e| e.to_string())?;
    fs::write(resolve_vehicle_cache_path(&app, &remote_path)?, bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn download_vehicle_file(app: AppHandle, remote_path: String, local_path: String, overwrite: bool) -> Result<(), String> {
    let resolved_local = resolve_local_path(&app, &local_path)?;
    if resolved_local.exists() && (!overwrite || resolved_local.is_dir()) {
        return Err("already exists locally".to_string());
    }
    let bytes = fs::read(resolve_vehicle_cache_path(&app, &remote_path)?).map_err(|e| e.to_string())?;
    fs::write(resolved_local, bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_vehicle_scripts(app: AppHandle) -> Result<(), String> {
    with_ftp_lock(&app, async {
        let cache = vehicle_cache_dir(&app)?;
        let _ = fs::remove_dir_all(&cache);
        fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
        let (connection, target) = vehicle_link(&app)?;
        ensure_vehicle_root(&app, &connection, target).await?;
        sync_vehicle_dir(&app, &connection, target, String::new()).await
    }).await
}

#[tauri::command]
pub fn clear_vehicle_cache(app: AppHandle) -> Result<(), String> {
    let _ = fs::remove_dir_all(vehicle_cache_dir(&app)?);
    Ok(())
}

#[tauri::command]
pub fn absolute_vehicle_path(app: AppHandle, path: String) -> Result<String, String> {
    Ok(resolve_vehicle_cache_path(&app, &path)?.to_string_lossy().to_string())
}