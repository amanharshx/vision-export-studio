use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use tauri::Manager;

use crate::commands::provider_registry::{validate_source_extension, ProviderId};

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, PartialEq)]
pub struct RfDetrInspectResult {
    pub success: bool,
    pub class_symbol: Option<String>,
    pub family: Option<String>,
    pub size: Option<String>,
    pub requires_plus: bool,
    pub is_legacy: bool,
    pub recommended_imgsz: Option<u32>,
    pub patch_size: Option<u32>,
    pub token_grid: Option<u32>,
    pub error: Option<String>,
}

#[allow(dead_code)]
fn helper_path() -> Result<PathBuf, String> {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    Ok(Path::new(manifest_dir)
        .join("python")
        .join("rfdetr_export_helper.py"))
}

fn parse_inspect_stdout(stdout: &[u8]) -> Result<RfDetrInspectResult, String> {
    let text = String::from_utf8_lossy(stdout);
    let json_line = text
        .lines()
        .rev()
        .find(|line| line.trim_start().starts_with('{'))
        .ok_or_else(|| "RF-DETR inspect helper did not return JSON".to_string())?;
    serde_json::from_str(json_line).map_err(|e| format!("invalid RF-DETR inspect JSON: {}", e))
}

#[tauri::command]
pub async fn inspect_rfdetr_checkpoint(
    app_handle: tauri::AppHandle,
    checkpoint_path: String,
    python_path: String,
    trust_confirmed: bool,
) -> Result<RfDetrInspectResult, String> {
    if !trust_confirmed {
        return Err(
            "RF-DETR checkpoint inspection requires trusted checkpoint confirmation.".to_string(),
        );
    }
    if !Path::new(&checkpoint_path).exists() {
        return Err(format!(
            "checkpoint path does not exist: {}",
            checkpoint_path
        ));
    }
    validate_source_extension(ProviderId::RfDetr, &checkpoint_path)?;
    if python_path.is_empty() {
        return Err("python_path must not be empty".to_string());
    }

    let helper = app_handle
        .path()
        .resolve(
            "python/rfdetr_export_helper.py",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| format!("failed to resolve RF-DETR helper resource: {}", e))?;
    let output = Command::new(&python_path)
        .arg(helper)
        .arg("inspect")
        .arg("--checkpoint")
        .arg(&checkpoint_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("failed to run RF-DETR inspect helper: {}", e))?;

    let parsed = parse_inspect_stdout(&output.stdout)?;
    if output.status.success() || parsed.requires_plus || parsed.error.is_some() {
        Ok(parsed)
    } else {
        Err(format!(
            "RF-DETR inspect failed with exit code {:?}",
            output.status.code()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_inspect_json_from_last_json_line() {
        let result = parse_inspect_stdout(br#"noise
{"success":true,"class_symbol":"RFDETRSmall","family":"detection","size":"small","requires_plus":false,"is_legacy":false,"recommended_imgsz":512,"patch_size":16,"token_grid":32,"error":null}
"#).expect("parse inspect json");
        assert_eq!(result.class_symbol.as_deref(), Some("RFDETRSmall"));
        assert_eq!(result.recommended_imgsz, Some(512));
        assert_eq!(result.patch_size, Some(16));
        assert_eq!(result.token_grid, Some(32));
        assert!(result.success);
    }

    #[test]
    fn helper_path_points_to_bundled_script() {
        let path = helper_path().expect("helper path");
        assert!(path.ends_with("python/rfdetr_export_helper.py"));
    }
}
