#[derive(serde::Serialize)]
pub struct AppTelemetryContext {
    pub os: String,
    pub arch: String,
}

#[tauri::command]
pub fn get_app_telemetry_context() -> AppTelemetryContext {
    AppTelemetryContext {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    }
}
