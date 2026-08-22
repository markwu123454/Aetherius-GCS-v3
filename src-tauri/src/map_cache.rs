//! On-disk cache for map tiles (base layer + regional overlays), keyed by
//! the tile's full request URL. Mirrors `scripting::vehicle_cache`'s shape —
//! an `app_cache_dir()` subfolder, resolved fresh on every call rather than
//! held open — but keyed by a hash of the URL instead of a relative path,
//! since tile URLs contain characters no filesystem accepts directly.
//!
//! The frontend (`lib/map/tileCache.ts`) is what actually decides *when* a
//! tile is worth fetching through here — this module only ever does what
//! it's told: read a key, write a key, or reclaim space.

use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    time::SystemTime,
};

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Manager};

fn map_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("map_tiles");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Tile URLs carry slashes, colons, and query strings — hashed down to a
/// fixed-width hex name rather than sanitized, since sanitizing a URL into
/// something filesystem-safe is more code than just not needing to.
fn tile_path(dir: &Path, url: &str) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    url.hash(&mut hasher);
    dir.join(format!("{:016x}.tile", hasher.finish()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedTile {
    bytes_b64: String,
    /// Milliseconds since epoch the tile was last (re)written — the
    /// frontend computes age against this itself rather than trusting a
    /// pre-computed age from a clock that might not agree with the caller's.
    modified_ms: u64,
}

/// `None` on a cache miss — including "cache disabled", which the frontend
/// never even calls this for, and "not present yet", which is the normal case
/// for a tile requested for the first time.
#[tauri::command]
pub fn get_cached_tile(app: AppHandle, url: String) -> Result<Option<CachedTile>, String> {
    let dir = map_cache_dir(&app)?;
    let path = tile_path(&dir, &url);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let modified = fs::metadata(&path)
        .and_then(|m| m.modified())
        .map_err(|e| e.to_string())?
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as u64;
    Ok(Some(CachedTile {bytes_b64: base64::engine::general_purpose::STANDARD.encode(bytes), modified_ms: modified}))
}

/// Writes the tile, then reclaims space if the cache is over
/// `max_size_mb`. `bytes_b64` is base64 rather than a raw byte array — a
/// couple hundred tiles a minute as JSON number arrays is needless IPC
/// overhead a base64 string avoids.
#[tauri::command]
pub fn put_cached_tile(app: AppHandle, url: String, bytes_b64: String, max_size_mb: u64) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(bytes_b64).map_err(|e| e.to_string())?;
    let dir = map_cache_dir(&app)?;
    fs::write(tile_path(&dir, &url), &bytes).map_err(|e| e.to_string())?;
    evict_to_cap(&dir, max_size_mb.saturating_mul(1024 * 1024))
}

/// Oldest-write-first eviction down to `max_bytes`. Not true LRU — a tile
/// that's still on screen but hasn't been re-fetched looks just as "old" as
/// one nobody has viewed in months — but re-panning back over it re-writes
/// it and refreshes its mtime, and a tile cache's whole point is tiles you
/// come back to are cheap to re-fetch anyway, so the gap is cosmetic.
fn evict_to_cap(dir: &Path, max_bytes: u64) -> Result<(), String> {
    let mut entries: Vec<(PathBuf, u64, SystemTime)> = Vec::new();
    let mut total: u64 = 0;

    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        if !meta.is_file() {
            continue;
        }
        total += meta.len();
        entries.push((entry.path(), meta.len(), meta.modified().unwrap_or(SystemTime::UNIX_EPOCH)));
    }

    if total <= max_bytes {
        return Ok(());
    }

    entries.sort_by_key(|(_, _, modified)| *modified);
    for (path, size, _) in entries {
        if total <= max_bytes {
            break;
        }
        if fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn clear_map_cache(app: AppHandle) -> Result<(), String> {
    let dir = map_cache_dir(&app)?;
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())
}

/// Total bytes currently on disk — the Settings page's "312 MB cached"
/// readout next to the Clear button.
#[tauri::command]
pub fn map_cache_size_bytes(app: AppHandle) -> Result<u64, String> {
    let dir = map_cache_dir(&app)?;
    let mut total = 0u64;
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if let Ok(meta) = entry.metadata() {
            if meta.is_file() {
                total += meta.len();
            }
        }
    }
    Ok(total)
}
