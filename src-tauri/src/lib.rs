// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

mod commands;
mod dispatch;
mod fence;
mod firmware;
mod inspector;
mod link;
mod logs;
mod map_cache;
mod mission;
mod params;
mod rally;
mod scripting;
mod sdcard;
mod telemetry;
mod vehicle_command;
mod vehicle_profile;

#[tauri::command]
fn close_splash(app: tauri::AppHandle) {
    if let Some(splash) = app.get_webview_window("splash") {
        let _ = splash.close();
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
        // TODO: fullscreen on show
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.hide();
            }
            WebviewWindowBuilder::new(app, "splash", WebviewUrl::App("splash.html".into()))
                .inner_size(400.0, 260.0)
                .resizable(false)
                .decorations(false)
                .center()
                .build()?;
            // One-time move of any log downloaded before per-vehicle
            // folders existed (see `vehicle_profile.rs`) — a no-op on
            // every run after the first.
            vehicle_profile::migrate_legacy_logs(app.handle());
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(link::LinkState::default())
        .manage(commands::CommandState::default())
        .manage(params::ParamState::default())
        .manage(mission::MissionState::default())
        .manage(fence::FenceState::default())
        .manage(rally::RallyState::default())
        .manage(dispatch::DispatchState::default())
        .manage(inspector::InspectorState::default())
        .manage(scripting::FtpState::default())
        .manage(logs::LogsState::default())
        .manage(logs::analysis::AnalysisState::default())
        .manage(firmware::flash::FlashState::default())
        .invoke_handler(tauri::generate_handler![
            close_splash,
            link::connect_link,
            link::disconnect_link,
            link::scan_links,
            link::link_status,
            link::reboot_link,
            vehicle_command::send_vehicle_command,
            vehicle_command::send_rc_override,
            vehicle_command::stop_all_motor_tests,
            params::refresh_params,
            params::set_param,
            mission::upload_mission,
            mission::download_mission,
            fence::upload_fence,
            fence::download_fence,
            rally::upload_rally,
            rally::download_rally,
            inspector::reset_inspector_stats,
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
            logs::cancel_download,
            logs::list_downloaded_logs,
            logs::analysis::open_log,
            logs::analysis::get_log_series,
            logs::analysis::get_log_text_events,
            logs::analysis::load_analysis_state,
            logs::analysis::save_analysis_state,
            sdcard::list_sdcard_dir,
            sdcard::read_sdcard_file,
            sdcard::write_sdcard_file,
            sdcard::create_sdcard_file,
            sdcard::create_sdcard_dir,
            sdcard::delete_sdcard,
            sdcard::rename_sdcard,
            sdcard::list_sdcard_logs,
            sdcard::resolve_sdcard_scripts_dir,
            sdcard::create_sdcard_scripts_dir,
            vehicle_profile::get_board_profile,
            vehicle_profile::set_board_profile,
            vehicle_profile::list_known_boards,
            firmware::flash::flash_fetch_manifest,
            firmware::flash::flash_prepare,
            firmware::flash::flash_start,
            map_cache::get_cached_tile,
            map_cache::put_cached_tile,
            map_cache::clear_map_cache,
            map_cache::map_cache_size_bytes,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
