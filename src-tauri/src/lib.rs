mod commands;

use crate::commands::export::ExportState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ExportState::default())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::environment::detect_environment,
            commands::export::start_export,
            commands::export::cancel_export,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
