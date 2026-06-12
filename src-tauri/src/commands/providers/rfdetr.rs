use std::path::Path;
use std::process::Command;

use tauri::Manager;

use crate::commands::provider_registry::{rfdetr_expected_artifacts, validate_rfdetr_manual_class};

use super::{ArtifactStatus, ExportRequest};

pub fn build_command(request: &ExportRequest, app_handle: &tauri::AppHandle) -> Result<Command, String> {
    if !request.rfdetr_trust_confirmed {
        return Err("RF-DETR export requires trusted checkpoint confirmation.".to_string());
    }
    if request.python_path.is_empty() || !Path::new(&request.python_path).exists() {
        return Err(format!("python not found at: {}", request.python_path));
    }
    if request.output_dir.is_empty() {
        return Err("RF-DETR export requires a non-empty output directory.".to_string());
    }
    let variant_mode = request.rfdetr_variant_mode.as_deref().unwrap_or("auto");
    if variant_mode == "manual" {
        validate_rfdetr_manual_class(request.rfdetr_manual_class_symbol.as_deref().unwrap_or(""))?;
    }
    let helper = app_handle
        .path()
        .resolve("python/rfdetr_export_helper.py", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("failed to resolve RF-DETR helper resource: {}", e))?;
    let mut cmd = Command::new(&request.python_path);
    cmd.arg(helper);
    cmd.arg("export");
    cmd.arg("--checkpoint").arg(&request.source_path);
    cmd.arg("--route-id").arg(&request.route_id);
    cmd.arg("--output-dir").arg(&request.output_dir);
    cmd.arg("--variant-mode").arg(variant_mode);
    if let Some(symbol) = request.rfdetr_manual_class_symbol.as_deref() {
        if !symbol.is_empty() {
            cmd.arg("--manual-class-symbol").arg(symbol);
        }
    }
    cmd.arg("--imgsz").arg(request.imgsz.to_string());
    cmd.arg("--batch").arg(request.batch.to_string());
    if let Some(value) = request.opset {
        cmd.arg("--opset").arg(value.to_string());
    }
    Ok(cmd)
}

fn confirm_rfdetr_artifacts(route_id: &str, output_dir: &str) -> Result<bool, String> {
    let expected = rfdetr_expected_artifacts(route_id);
    if expected.is_empty() {
        return Ok(false);
    }
    let missing: Vec<&str> = expected
        .iter()
        .copied()
        .filter(|name| !Path::new(output_dir).join(name).exists())
        .collect();
    if missing.is_empty() {
        Ok(true)
    } else {
        Err(format!("RF-DETR export missing expected artifact(s): {}", missing.join(", ")))
    }
}

pub fn confirm_artifacts(request: &ExportRequest) -> ArtifactStatus {
    if request.output_dir.is_empty() {
        return ArtifactStatus {
            artifact_moved: false,
            artifact_warning: Some("RF-DETR export finished, but output directory was empty.".to_string()),
        };
    }
    match confirm_rfdetr_artifacts(&request.route_id, &request.output_dir) {
        Ok(true) => ArtifactStatus { artifact_moved: true, artifact_warning: None },
        Ok(false) => ArtifactStatus {
            artifact_moved: false,
            artifact_warning: Some(format!(
                "RF-DETR export finished, but expected artifact(s) not found in {}. Check the output directory manually.",
                request.output_dir
            )),
        },
        Err(error) => ArtifactStatus {
            artifact_moved: false,
            artifact_warning: Some(format!(
                "RF-DETR export finished, but artifact validation failed: {}",
                error
            )),
        },
    }
}

#[cfg(test)]
mod tests {
    use crate::commands::provider_registry::rfdetr_expected_artifacts;

    use super::confirm_rfdetr_artifacts;

    #[test]
    fn confirm_artifacts_requires_tflite_fp32_and_fp16() {
        let root = std::env::temp_dir().join(format!("rfdetr-artifacts-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp dir");
        std::fs::write(root.join("inference_model_float32.tflite"), b"fp32").expect("write fp32");
        let result = confirm_rfdetr_artifacts("rfdetr.pth.tflite", root.to_str().expect("path"));
        assert!(result.is_err());
        std::fs::write(root.join("inference_model_float16.tflite"), b"fp16").expect("write fp16");
        let result = confirm_rfdetr_artifacts("rfdetr.pth.tflite", root.to_str().expect("path"));
        assert_eq!(result, Ok(true));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn expected_tflite_artifacts_match_test() {
        assert_eq!(
            rfdetr_expected_artifacts("rfdetr.pth.tflite"),
            vec!["inference_model_float32.tflite", "inference_model_float16.tflite"]
        );
    }
}
