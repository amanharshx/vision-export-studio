use std::process::{Command, Stdio};

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

#[tauri::command]
pub fn get_route_platform_support(
    route_ids: Vec<String>,
) -> Vec<crate::commands::provider_registry::RoutePlatformResult> {
    crate::commands::provider_registry::validate_route_platform_batch(
        &route_ids,
        crate::commands::provider_registry::current_host_context(),
    )
}

#[tauri::command]
pub fn build_date() -> Option<&'static str> {
    option_env!("VISION_EXPORT_STUDIO_DATE")
}

#[tauri::command]
pub fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("Only web links can be opened".to_string());
    }

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(&url);
        command
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("cmd");
        command.args(["/c", "start", ""]);
        command.arg(&url);
        command
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(&url);
        command
    };

    command
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|_| ())
        .map_err(|error| format!("Could not open the link: {error}"))
}
