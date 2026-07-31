// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

mod commands;
mod dispatch;
mod link;
mod params;
mod telemetry;
mod vehicle_command;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(link::LinkState::default())
        .manage(commands::CommandState::default())
        .manage(dispatch::SeenState::default())
        .manage(params::ParamState::default())
        .invoke_handler(tauri::generate_handler![
            link::connect_link,
            link::disconnect_link,
            link::scan_links,
            link::link_status,
            vehicle_command::send_vehicle_command,
            params::refresh_params,
            params::set_param
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
