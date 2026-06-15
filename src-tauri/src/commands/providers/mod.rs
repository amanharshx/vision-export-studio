use std::process::Command;

use crate::commands::provider_registry::ProviderId;

pub mod rfdetr;
pub mod ultralytics;

#[derive(Clone)]
pub struct ExportRequest {
    pub provider: ProviderId,
    pub source_path: String,
    pub route_id: String,
    pub output_dir: String,
    pub yolo_path: String,
    pub python_path: String,
    pub imgsz: u32,
    pub batch: u32,
    pub half: bool,
    pub int8: bool,
    pub dynamic: bool,
    pub simplify: bool,
    pub optimize: bool,
    pub nms: bool,
    pub end_to_end: bool,
    pub keras: bool,
    pub opset: Option<u32>,
    pub workspace: Option<u32>,
    pub chip: String,
    pub rfdetr_trust_confirmed: bool,
    pub rfdetr_variant_mode: Option<String>,
    pub rfdetr_manual_class_symbol: Option<String>,
}

pub struct ArtifactStatus {
    pub artifact_moved: bool,
    pub artifact_warning: Option<String>,
}

pub fn build_command(
    request: &ExportRequest,
    app_handle: &tauri::AppHandle,
) -> Result<Command, String> {
    match request.provider {
        ProviderId::Ultralytics => ultralytics::build_command(request),
        ProviderId::RfDetr => rfdetr::build_command(request, app_handle),
    }
}

pub fn confirm_artifacts(request: &ExportRequest) -> ArtifactStatus {
    match request.provider {
        ProviderId::Ultralytics => ultralytics::confirm_artifacts(request),
        ProviderId::RfDetr => rfdetr::confirm_artifacts(request),
    }
}
