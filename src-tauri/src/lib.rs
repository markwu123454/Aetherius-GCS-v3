// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

mod link;
mod telemetry;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(link::LinkState::default())
        .invoke_handler(tauri::generate_handler![
            link::connect_link,
            link::disconnect_link,
            link::scan_links
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
