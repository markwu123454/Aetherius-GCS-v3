// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod sitl;
mod link;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(sitl::SitlState::default())
        .manage(link::LinkState::default())
        .invoke_handler(tauri::generate_handler![
            sitl::start_sitl,
            sitl::stop_sitl,
            sitl::list_serial_ports,
            link::connect_link,
            link::disconnect_link
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                window.state::<sitl::SitlState>().shutdown();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
