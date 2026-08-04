// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

mod commands;
mod dispatch;
mod firmware;
mod link;
mod logs;
mod mission;
mod params;
mod scripting;
mod telemetry;
mod vehicle_command;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(link::LinkState::default())
        .manage(commands::CommandState::default())
        .manage(params::ParamState::default())
        .manage(mission::MissionState::default())
        .manage(dispatch::DispatchState::default())
        .manage(scripting::FtpState::default())
        .manage(logs::LogsState::default())
        .manage(firmware::flash::FlashState::default())
        .invoke_handler(tauri::generate_handler![
            link::connect_link,
            link::disconnect_link,
            link::scan_links,
            link::link_status,
            vehicle_command::send_vehicle_command,
            params::refresh_params,
            params::set_param,
            mission::upload_mission,
            scripting::list_local_dir,
            scripting::read_local_file,
            scripting::write_local_file,
            scripting::create_local_file,
            scripting::create_local_dir,
            scripting::delete_local,
            scripting::rename_local,
            scripting::list_vehicle_dir,
            scripting::upload_to_vehicle,
            scripting::download_vehicle_file,
            scripting::create_vehicle_file,
            scripting::create_vehicle_dir,
            scripting::delete_vehicle,
            scripting::rename_vehicle,
            scripting::read_vehicle_file,
            scripting::write_vehicle_file,
            scripting::sync_vehicle_scripts,
            scripting::clear_vehicle_cache,
            scripting::absolute_vehicle_path,
            scripting::absolute_local_path,
            logs::list_logs,
            logs::download_log,
            firmware::flash::flash_fetch_manifest,
            firmware::flash::flash_prepare,
            firmware::flash::flash_start,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
