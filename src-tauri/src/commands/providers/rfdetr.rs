use std::path::Path;
use std::process::Command;
use std::time::SystemTime;

use sha2::{Digest, Sha256};
use tauri::Manager;

use crate::commands::provider_registry::{
    rfdetr_artifact_rule, validate_rfdetr_manual_class, RfDetrArtifactRule,
};

use super::{ArtifactStatus, ExportRequest};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactFingerprint {
    pub name: String,
    pub len: u64,
    pub modified: Option<SystemTime>,
    pub digest: [u8; 32],
}

fn sha256_file(path: &Path) -> Result<[u8; 32], String> {
    let data =
        std::fs::read(path).map_err(|e| format!("failed to read file for hashing: {}", e))?;
    let mut hasher = Sha256::new();
    hasher.update(&data);
    Ok(hasher.finalize().into())
}

pub fn build_command(
    request: &ExportRequest,
    app_handle: &tauri::AppHandle,
) -> Result<Command, String> {
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
        .resolve(
            "python/rfdetr_export_helper.py",
            tauri::path::BaseDirectory::Resource,
        )
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
    let rule =
        rfdetr_artifact_rule(route_id).ok_or_else(|| format!("unknown route: {}", route_id))?;
    let output = Path::new(output_dir);
    match rule {
        RfDetrArtifactRule::Named {
            extension,
            prefix,
            exact,
        } => {
            let exists = std::fs::read_dir(output)
                .map_err(|e| format!("failed to read output dir: {}", e))?
                .filter_map(|entry| entry.ok())
                .filter_map(|entry| {
                    let name = entry.file_name();
                    let name = name.to_str()?;
                    let stem = name.strip_suffix(extension)?;
                    Some(stem.to_owned())
                })
                .any(|ref stem| stem == exact || stem.starts_with(prefix));
            if exists {
                Ok(true)
            } else {
                Err(format!(
                    "no matching {} artifact found in output directory",
                    extension
                ))
            }
        }
        RfDetrArtifactRule::ExactList(names) => {
            let missing: Vec<&str> = names
                .iter()
                .copied()
                .filter(|name| !output.join(name).exists())
                .collect();
            if missing.is_empty() {
                Ok(true)
            } else {
                Err(format!(
                    "RF-DETR export missing expected artifact(s): {}",
                    missing.join(", ")
                ))
            }
        }
    }
}

pub fn confirm_artifacts(request: &ExportRequest) -> ArtifactStatus {
    if request.output_dir.is_empty() {
        return ArtifactStatus {
            artifact_moved: false,
            artifact_warning: Some(
                "RF-DETR export finished, but output directory was empty.".to_string(),
            ),
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

pub fn snapshot_rfdetr_artifacts(
    route_id: &str,
    output_dir: &str,
) -> Result<Vec<ArtifactFingerprint>, String> {
    let rule =
        rfdetr_artifact_rule(route_id).ok_or_else(|| format!("unknown route: {}", route_id))?;
    let output = Path::new(output_dir);
    let mut fingerprints = Vec::new();

    if !output.exists() {
        return Ok(fingerprints);
    }

    let dir = std::fs::read_dir(output).map_err(|e| format!("failed to read output dir: {}", e))?;
    for entry in dir {
        let entry = entry.map_err(|e| format!("failed to read dir entry: {}", e))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

        let matches = match &rule {
            RfDetrArtifactRule::Named {
                extension,
                prefix,
                exact,
            } => {
                if let Some(stem) = name.strip_suffix(extension) {
                    stem == *exact || stem.starts_with(prefix)
                } else {
                    false
                }
            }
            RfDetrArtifactRule::ExactList(names) => names.contains(&name),
        };

        if matches {
            let meta = entry
                .metadata()
                .map_err(|e| format!("failed to read metadata: {}", e))?;
            fingerprints.push(ArtifactFingerprint {
                name: name.to_string(),
                len: meta.len(),
                modified: meta.modified().ok(),
                digest: sha256_file(&path)?,
            });
        }
    }

    Ok(fingerprints)
}

pub fn confirm_artifacts_with_snapshot(
    request: &ExportRequest,
    before: &[ArtifactFingerprint],
) -> ArtifactStatus {
    if request.output_dir.is_empty() {
        return ArtifactStatus {
            artifact_moved: false,
            artifact_warning: Some(
                "RF-DETR export finished, but output directory was empty.".to_string(),
            ),
        };
    }

    match confirm_rfdetr_artifacts(&request.route_id, &request.output_dir) {
        Ok(true) => {}
        Ok(false) => {
            return ArtifactStatus {
                artifact_moved: false,
                artifact_warning: Some(format!(
                    "RF-DETR export finished, but expected artifact(s) not found in {}. Check the output directory manually.",
                    request.output_dir
                )),
            };
        }
        Err(error) => {
            return ArtifactStatus {
                artifact_moved: false,
                artifact_warning: Some(format!(
                    "RF-DETR export finished, but artifact validation failed: {}",
                    error
                )),
            };
        }
    }

    let after = match snapshot_rfdetr_artifacts(&request.route_id, &request.output_dir) {
        Ok(s) => s,
        Err(e) => {
            return ArtifactStatus {
                artifact_moved: false,
                artifact_warning: Some(format!("RF-DETR artifact scan failed: {}", e)),
            }
        }
    };

    let changed = after.iter().any(
        |post| match before.iter().find(|pre| pre.name == post.name) {
            None => true,
            Some(pre) => {
                post.len != pre.len || post.modified != pre.modified || post.digest != pre.digest
            }
        },
    );

    if changed {
        ArtifactStatus {
            artifact_moved: true,
            artifact_warning: None,
        }
    } else {
        ArtifactStatus {
            artifact_moved: false,
            artifact_warning: Some(format!(
                "RF-DETR export process exited successfully, but no new or updated artifact found in {}. Existing files may be stale.",
                request.output_dir
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::super::provider_registry::ProviderId;
    use super::super::ExportRequest;
    use super::confirm_artifacts_with_snapshot;
    use super::confirm_rfdetr_artifacts;
    use super::snapshot_rfdetr_artifacts;
    use super::ArtifactFingerprint;

    fn make_request(route_id: &str, output_dir: &str) -> ExportRequest {
        ExportRequest {
            provider: ProviderId::RfDetr,
            source_path: "/tmp/dummy.pth".into(),
            route_id: route_id.into(),
            output_dir: output_dir.into(),
            yolo_path: String::new(),
            python_path: "/usr/bin/python3".into(),
            imgsz: 640,
            batch: 1,
            half: false,
            int8: false,
            dynamic: false,
            simplify: false,
            optimize: false,
            nms: false,
            end_to_end: false,
            keras: false,
            opset: None,
            workspace: None,
            chip: String::new(),
            rfdetr_trust_confirmed: true,
            rfdetr_variant_mode: None,
            rfdetr_manual_class_symbol: None,
        }
    }

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
    fn confirm_artifacts_accepts_variant_named_onnx_file() {
        let root = std::env::temp_dir().join(format!("rfdetr-onnx-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp dir");
        std::fs::write(root.join("rfdetr-small.onnx"), b"onnx").expect("write onnx");
        let result = confirm_rfdetr_artifacts("rfdetr.pth.onnx", root.to_str().expect("path"));
        assert_eq!(result, Ok(true));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn confirm_artifacts_rejects_unrelated_onnx_file() {
        let root = std::env::temp_dir().join(format!("rfdetr-foo-onnx-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp dir");
        std::fs::write(root.join("foo.onnx"), b"onnx").expect("write onnx");
        let result = confirm_rfdetr_artifacts("rfdetr.pth.onnx", root.to_str().expect("path"));
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn confirm_artifacts_accepts_inference_model_onnx() {
        let root = std::env::temp_dir().join(format!("rfdetr-inf-onnx-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp dir");
        std::fs::write(root.join("inference_model.onnx"), b"onnx").expect("write onnx");
        let result = confirm_rfdetr_artifacts("rfdetr.pth.onnx", root.to_str().expect("path"));
        assert_eq!(result, Ok(true));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn confirm_artifacts_accepts_variant_named_engine_file() {
        let root = std::env::temp_dir().join(format!("rfdetr-engine-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp dir");
        std::fs::write(root.join("rfdetr-small.engine"), b"engine").expect("write engine");
        let result = confirm_rfdetr_artifacts("rfdetr.pth.engine", root.to_str().expect("path"));
        assert_eq!(result, Ok(true));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn confirm_artifacts_accepts_inference_model_engine() {
        let root = std::env::temp_dir().join(format!("rfdetr-inf-engine-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp dir");
        std::fs::write(root.join("inference_model.engine"), b"engine").expect("write engine");
        let result = confirm_rfdetr_artifacts("rfdetr.pth.engine", root.to_str().expect("path"));
        assert_eq!(result, Ok(true));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn confirm_artifacts_rejects_engine_route_with_only_onnx_files() {
        let root = std::env::temp_dir().join(format!("rfdetr-wrong-ext-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp dir");
        std::fs::write(root.join("rfdetr-small.onnx"), b"onnx").expect("write onnx");
        let result = confirm_rfdetr_artifacts("rfdetr.pth.engine", root.to_str().expect("path"));
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn confirm_artifacts_rejects_unrelated_engine_file() {
        let root = std::env::temp_dir().join(format!("rfdetr-foo-engine-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp dir");
        std::fs::write(root.join("foo.engine"), b"engine").expect("write engine");
        let result = confirm_rfdetr_artifacts("rfdetr.pth.engine", root.to_str().expect("path"));
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    // -----------------------------------------------------------------------
    // snapshot + stale-file tests
    // -----------------------------------------------------------------------

    #[test]
    fn snapshot_captures_rfdetr_onnx_ignores_unrelated() {
        let root = std::env::temp_dir().join(format!("rfdetr-snap-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp dir");
        std::fs::write(root.join("rfdetr-small.onnx"), b"onnx").expect("write onnx");
        std::fs::write(root.join("foo.onnx"), b"bad").expect("write foo");
        std::fs::write(root.join("notes.txt"), b"txt").expect("write txt");
        let snap = snapshot_rfdetr_artifacts("rfdetr.pth.onnx", root.to_str().expect("path"))
            .expect("snapshot");
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].name, "rfdetr-small.onnx");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn snapshot_returns_empty_for_missing_dir() {
        let root = std::env::temp_dir().join(format!("rfdetr-nodir-{}", uuid::Uuid::new_v4()));
        let snap = snapshot_rfdetr_artifacts("rfdetr.pth.onnx", root.to_str().expect("path"))
            .expect("snapshot");
        assert!(snap.is_empty());
    }

    #[test]
    fn snapshot_captures_engine_files() {
        let root = std::env::temp_dir().join(format!("rfdetr-eng-snap-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp dir");
        std::fs::write(root.join("rfdetr-large.engine"), b"engine").expect("write engine");
        let snap = snapshot_rfdetr_artifacts("rfdetr.pth.engine", root.to_str().expect("path"))
            .expect("snapshot");
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].name, "rfdetr-large.engine");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn snapshot_captures_tflite_files() {
        let root = std::env::temp_dir().join(format!("rfdetr-tf-snap-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp dir");
        std::fs::write(root.join("inference_model_float32.tflite"), b"fp32").expect("write fp32");
        std::fs::write(root.join("inference_model_float16.tflite"), b"fp16").expect("write fp16");
        let snap = snapshot_rfdetr_artifacts("rfdetr.pth.tflite", root.to_str().expect("path"))
            .expect("snapshot");
        assert_eq!(snap.len(), 2);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn with_snapshot_accepts_new_onnx_file() {
        let root = std::env::temp_dir().join(format!("rfdetr-new-onnx-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp dir");
        let before: Vec<ArtifactFingerprint> = vec![];
        std::fs::write(root.join("rfdetr-small.onnx"), b"onnx").expect("write onnx");
        let req = make_request("rfdetr.pth.onnx", root.to_str().expect("path"));
        let status = confirm_artifacts_with_snapshot(&req, &before);
        assert!(status.artifact_moved, "new onnx file should be accepted");
        assert!(status.artifact_warning.is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn with_snapshot_rejects_stale_onnx_file() {
        let root = std::env::temp_dir().join(format!("rfdetr-stale-onnx-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp dir");
        std::fs::write(root.join("rfdetr-small.onnx"), b"onnx").expect("write onnx");

        let before = snapshot_rfdetr_artifacts("rfdetr.pth.onnx", root.to_str().expect("path"))
            .expect("snapshot");
        assert_eq!(before.len(), 1);

        let req = make_request("rfdetr.pth.onnx", root.to_str().expect("path"));
        let status = confirm_artifacts_with_snapshot(&req, &before);
        assert!(!status.artifact_moved, "stale file should be rejected");
        assert!(status.artifact_warning.is_some());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn with_snapshot_accepts_updated_onnx_file() {
        let root = std::env::temp_dir().join(format!("rfdetr-upd-onnx-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp dir");
        std::fs::write(root.join("rfdetr-small.onnx"), b"v1-onnx").expect("write v1");

        let before = snapshot_rfdetr_artifacts("rfdetr.pth.onnx", root.to_str().expect("path"))
            .expect("snapshot");
        assert_eq!(before.len(), 1);
        assert_eq!(before[0].len, 7); // "v1-onnx"

        // Overwrite with different content (changes both mtime and size)
        std::fs::write(root.join("rfdetr-small.onnx"), b"v2-onnx-exported").expect("write v2");

        let req = make_request("rfdetr.pth.onnx", root.to_str().expect("path"));
        let status = confirm_artifacts_with_snapshot(&req, &before);
        assert!(
            status.artifact_moved,
            "updated onnx file should be accepted"
        );
        assert!(status.artifact_warning.is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn with_snapshot_accepts_new_engine_file() {
        let root = std::env::temp_dir().join(format!("rfdetr-new-eng-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp dir");
        let before: Vec<ArtifactFingerprint> = vec![];
        std::fs::write(root.join("rfdetr-small.engine"), b"engine").expect("write engine");
        let req = make_request("rfdetr.pth.engine", root.to_str().expect("path"));
        let status = confirm_artifacts_with_snapshot(&req, &before);
        assert!(status.artifact_moved, "new engine file should be accepted");
        assert!(status.artifact_warning.is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn with_snapshot_rejects_stale_engine_file() {
        let root = std::env::temp_dir().join(format!("rfdetr-stale-eng-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp dir");
        std::fs::write(root.join("rfdetr-small.engine"), b"engine").expect("write engine");

        let before = snapshot_rfdetr_artifacts("rfdetr.pth.engine", root.to_str().expect("path"))
            .expect("snapshot");
        let req = make_request("rfdetr.pth.engine", root.to_str().expect("path"));
        let status = confirm_artifacts_with_snapshot(&req, &before);
        assert!(
            !status.artifact_moved,
            "stale engine file should be rejected"
        );
        assert!(status.artifact_warning.is_some());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn with_snapshot_accepts_updated_engine_file() {
        let root = std::env::temp_dir().join(format!("rfdetr-upd-eng-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp dir");
        std::fs::write(root.join("rfdetr-small.engine"), b"v1-engine").expect("write v1");

        let before = snapshot_rfdetr_artifacts("rfdetr.pth.engine", root.to_str().expect("path"))
            .expect("snapshot");
        std::fs::write(root.join("rfdetr-small.engine"), b"v2-engine-exported").expect("write v2");

        let req = make_request("rfdetr.pth.engine", root.to_str().expect("path"));
        let status = confirm_artifacts_with_snapshot(&req, &before);
        assert!(
            status.artifact_moved,
            "updated engine file should be accepted"
        );
        assert!(status.artifact_warning.is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn with_snapshot_tflite_requires_both_files() {
        let root =
            std::env::temp_dir().join(format!("rfdetr-tflite-miss-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp dir");
        let before: Vec<ArtifactFingerprint> = vec![];
        std::fs::write(root.join("inference_model_float32.tflite"), b"fp32").expect("write fp32");
        let req = make_request("rfdetr.pth.tflite", root.to_str().expect("path"));
        let status = confirm_artifacts_with_snapshot(&req, &before);
        assert!(!status.artifact_moved, "tflite should require both files");
        assert!(status.artifact_warning.is_some());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn with_snapshot_tflite_accepts_both_files_new() {
        let root = std::env::temp_dir().join(format!("rfdetr-tflite-new-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp dir");
        let before: Vec<ArtifactFingerprint> = vec![];
        std::fs::write(root.join("inference_model_float32.tflite"), b"fp32").expect("write fp32");
        std::fs::write(root.join("inference_model_float16.tflite"), b"fp16").expect("write fp16");
        let req = make_request("rfdetr.pth.tflite", root.to_str().expect("path"));
        let status = confirm_artifacts_with_snapshot(&req, &before);
        assert!(
            status.artifact_moved,
            "both tflite files should be accepted"
        );
        assert!(status.artifact_warning.is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn with_snapshot_tflite_rejects_stale_both_files() {
        let root =
            std::env::temp_dir().join(format!("rfdetr-tflite-stale-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp dir");
        std::fs::write(root.join("inference_model_float32.tflite"), b"fp32").expect("write fp32");
        std::fs::write(root.join("inference_model_float16.tflite"), b"fp16").expect("write fp16");

        let before = snapshot_rfdetr_artifacts("rfdetr.pth.tflite", root.to_str().expect("path"))
            .expect("snapshot");
        let req = make_request("rfdetr.pth.tflite", root.to_str().expect("path"));
        let status = confirm_artifacts_with_snapshot(&req, &before);
        assert!(
            !status.artifact_moved,
            "stale tflite files should be rejected"
        );
        assert!(status.artifact_warning.is_some());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn with_snapshot_tflite_accepts_one_updated_file() {
        let root = std::env::temp_dir().join(format!("rfdetr-tflite-upd-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp dir");
        std::fs::write(root.join("inference_model_float32.tflite"), b"fp32-v1")
            .expect("write fp32");
        std::fs::write(root.join("inference_model_float16.tflite"), b"fp16").expect("write fp16");

        let before = snapshot_rfdetr_artifacts("rfdetr.pth.tflite", root.to_str().expect("path"))
            .expect("snapshot");
        std::fs::write(root.join("inference_model_float32.tflite"), b"fp32-v2")
            .expect("write fp32 v2");

        let req = make_request("rfdetr.pth.tflite", root.to_str().expect("path"));
        let status = confirm_artifacts_with_snapshot(&req, &before);
        assert!(status.artifact_moved, "updated tflite should be accepted");
        assert!(status.artifact_warning.is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn with_snapshot_accepts_same_size_onnx_rewrite() {
        let root =
            std::env::temp_dir().join(format!("rfdetr-samesz-onnx-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp dir");
        std::fs::write(root.join("rfdetr-small.onnx"), b"AAAA").expect("write v1");

        let before = snapshot_rfdetr_artifacts("rfdetr.pth.onnx", root.to_str().expect("path"))
            .expect("snapshot");
        assert_eq!(before[0].len, 4);
        // Same size, different content — mtime may not change on coarse filesystems
        std::fs::write(root.join("rfdetr-small.onnx"), b"BBBB").expect("write v2");

        let req = make_request("rfdetr.pth.onnx", root.to_str().expect("path"));
        let status = confirm_artifacts_with_snapshot(&req, &before);
        assert!(
            status.artifact_moved,
            "same-size onnx rewrite should be detected via digest"
        );
        assert!(status.artifact_warning.is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn with_snapshot_accepts_same_size_engine_rewrite() {
        let root = std::env::temp_dir().join(format!("rfdetr-samesz-eng-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp dir");
        std::fs::write(root.join("rfdetr-small.engine"), b"AAAA").expect("write v1");

        let before = snapshot_rfdetr_artifacts("rfdetr.pth.engine", root.to_str().expect("path"))
            .expect("snapshot");
        std::fs::write(root.join("rfdetr-small.engine"), b"BBBB").expect("write v2");

        let req = make_request("rfdetr.pth.engine", root.to_str().expect("path"));
        let status = confirm_artifacts_with_snapshot(&req, &before);
        assert!(
            status.artifact_moved,
            "same-size engine rewrite should be detected via digest"
        );
        assert!(status.artifact_warning.is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn with_snapshot_accepts_same_size_tflite_rewrite() {
        let root = std::env::temp_dir().join(format!("rfdetr-samesz-tf-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp dir");
        std::fs::write(root.join("inference_model_float32.tflite"), b"AAAA")
            .expect("write fp32 v1");
        std::fs::write(root.join("inference_model_float16.tflite"), b"AAAA")
            .expect("write fp16 v1");

        let before = snapshot_rfdetr_artifacts("rfdetr.pth.tflite", root.to_str().expect("path"))
            .expect("snapshot");
        // Rewrite fp32 to same size but different content
        std::fs::write(root.join("inference_model_float32.tflite"), b"BBBB")
            .expect("write fp32 v2");

        let req = make_request("rfdetr.pth.tflite", root.to_str().expect("path"));
        let status = confirm_artifacts_with_snapshot(&req, &before);
        assert!(
            status.artifact_moved,
            "same-size tflite rewrite should be detected via digest"
        );
        assert!(status.artifact_warning.is_none());
        let _ = std::fs::remove_dir_all(root);
    }
}
