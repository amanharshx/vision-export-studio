mod commands;

use crate::commands::export::ExportState;
use crate::commands::runtime_operations::RuntimeOperationCoordinator;
use crate::commands::setup::{
    default_runtime_dir, sweep_runtime_rebuild_artifacts, SettingsState, SetupState,
};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ExportState::default())
        .manage(SetupState::default())
        .manage(SettingsState::default())
        .manage(RuntimeOperationCoordinator::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            if let Ok(runtime_dir) = default_runtime_dir(app.handle()) {
                sweep_runtime_rebuild_artifacts(std::path::Path::new(&runtime_dir));
            }
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

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
            commands::app::get_app_telemetry_context,
            commands::deps::check_dependencies,
            commands::deps::install_dependencies,
            commands::environment::detect_environment,
            commands::export::start_export,
            commands::export::cancel_export,
            commands::export::open_export_folder,
            commands::gpu::list_gpus,
            commands::rfdetr::inspect_rfdetr_checkpoint,
            commands::setup::load_settings,
            commands::setup::create_runtime_venv,
            commands::setup::rebuild_managed_runtime,
            commands::setup::mark_setup_complete,
            commands::setup::save_python_override,
            commands::setup::save_output_dir_override,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
