//! ArduPilot's parameter documentation, from the same JSON files the
//! Parameters page uses (`public/params/*.json`), read through the app's
//! own bundled assets — or straight from `public/` in a dev build, where
//! the frontend is served by Vite and nothing is bundled.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};

use serde::Deserialize;
use tauri::AppHandle;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Choice {
    pub value: f64,
    pub label: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamDoc {
    pub name: String,
    #[serde(default)]
    pub human_name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub units: Option<String>,
    #[serde(default)]
    pub range: Option<Vec<f64>>,
    #[serde(default)]
    pub increment: Option<f64>,
    #[serde(default)]
    pub values: Option<Vec<Choice>>,
    /// Bit numbers, in `value`.
    #[serde(default)]
    pub bitmask: Option<Vec<Choice>>,
    #[serde(default)]
    pub reboot_required: bool,
}

#[derive(Deserialize)]
struct Group {
    #[serde(default)]
    params: Vec<ParamDoc>,
}

#[derive(Deserialize)]
struct File {
    groups: Vec<Group>,
}

pub type Docs = Arc<HashMap<String, ParamDoc>>;

fn load(app: &AppHandle, file: &str) -> Option<Docs> {
    let bytes = app
        .asset_resolver()
        .get(format!("params/{file}"))
        .map(|asset| asset.bytes().to_vec())
        .or_else(|| std::fs::read(format!("{}/../public/params/{file}", env!("CARGO_MANIFEST_DIR"))).ok())?;
    let parsed: File = serde_json::from_slice(&bytes).ok()?;
    let mut docs = HashMap::new();
    for group in parsed.groups {
        for param in group.params {
            docs.entry(param.name.clone()).or_insert(param);
        }
    }
    Some(Arc::new(docs))
}

/// The documentation for a plane (`ArduPlane.json`) or anything else
/// (`ArduCopter.json`). Parsed once per file, on first use.
pub fn docs(app: &AppHandle, plane: bool) -> Option<Docs> {
    static CACHE: OnceLock<Mutex<HashMap<&'static str, Docs>>> = OnceLock::new();
    let file = if plane { "ArduPlane.json" } else { "ArduCopter.json" };
    let cache = CACHE.get_or_init(Default::default);
    if let Some(found) = cache.lock().unwrap_or_else(|e| e.into_inner()).get(file) {
        return Some(found.clone());
    }
    let loaded = load(app, file)?;
    cache.lock().unwrap_or_else(|e| e.into_inner()).insert(file, loaded.clone());
    Some(loaded)
}
