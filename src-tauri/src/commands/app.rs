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
