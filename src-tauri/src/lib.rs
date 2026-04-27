mod commands;

use crate::commands::export::ExportState;
use crate::commands::setup::SetupState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ExportState::default())
        .manage(SetupState::default())
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
            commands::deps::check_dependencies,
            commands::environment::detect_environment,
            commands::export::start_export,
            commands::export::cancel_export,
            commands::gpu::list_gpus,
            commands::setup::load_settings,
            commands::setup::create_runtime_venv,
            commands::setup::install_ultralytics,
            commands::setup::mark_setup_complete,
            commands::setup::save_python_override,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
