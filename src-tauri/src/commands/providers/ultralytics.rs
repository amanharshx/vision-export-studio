use std::path::{Path, PathBuf};
use std::process::Command;

use super::{ArtifactStatus, ExportRequest};

fn artifact_info(format: &str) -> (&'static str, bool) {
    match format {
        "torchscript" => (".torchscript", false),
        "onnx" => (".onnx", false),
        "openvino" => ("_openvino_model", true),
        "coreml" => (".mlpackage", true),
        "ncnn" => ("_ncnn_model", true),
        "mnn" => (".mnn", false),
        "tflite" => (".tflite", false),
        "engine" => (".engine", false),
        "rknn" => (".rknn", false),
        "executorch" => (".ptl", false),
        "edgetpu" => ("_edgetpu.tflite", false),
        "tfjs" => ("_web_model", true),
        "paddle" => ("_paddle_model", true),
        "saved_model" => ("_saved_model", true),
        "pb" => (".pb", false),
        _ => ("", false),
    }
}

fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &dst.join(entry.file_name()))?;
        } else {
            std::fs::copy(entry.path(), dst.join(entry.file_name()))?;
        }
    }
    Ok(())
}

pub fn move_artifact(source_path: &str, format: &str, output_dir: &str) -> Result<bool, String> {
    let (suffix, is_dir) = artifact_info(format);
    if suffix.is_empty() {
        return Ok(false);
    }
    let src_path = Path::new(source_path);
    let stem = match src_path.file_stem().and_then(|s| s.to_str()) {
        Some(s) => s,
        None => return Ok(false),
    };
    let src_dir = match src_path.parent() {
        Some(d) => d,
        None => return Ok(false),
    };
    let artifact_name = format!("{}{}", stem, suffix);
    let artifact_src: PathBuf = src_dir.join(&artifact_name);
    let artifact_dst: PathBuf = Path::new(output_dir).join(&artifact_name);
    if !artifact_src.exists() {
        return Ok(false);
    }
    if is_dir {
        copy_dir_all(&artifact_src, &artifact_dst)
            .map_err(|e| format!("failed to copy artifact directory: {}", e))?;
        std::fs::remove_dir_all(&artifact_src)
            .map_err(|e| format!("failed to remove source artifact directory: {}", e))?;
    } else if let Err(rename_error) = std::fs::rename(&artifact_src, &artifact_dst) {
        std::fs::copy(&artifact_src, &artifact_dst).map_err(|copy_error| {
            format!(
                "failed to move artifact: rename error: {}; copy fallback error: {}",
                rename_error, copy_error
            )
        })?;
        std::fs::remove_file(&artifact_src)
            .map_err(|e| format!("failed to remove source artifact file: {}", e))?;
    }
    Ok(true)
}

pub fn build_command(request: &ExportRequest) -> Result<Command, String> {
    if request.yolo_path.is_empty() || !Path::new(&request.yolo_path).exists() {
        return Err(format!("yolo not found at: {}", request.yolo_path));
    }
    let yolo_format = request
        .route_id
        .strip_prefix("ultralytics.pt.")
        .ok_or_else(|| format!("route not supported in this build: {}", request.route_id))?;
    let mut cmd = Command::new(&request.yolo_path);
    cmd.arg("export");
    cmd.arg(format!("model={}", request.source_path));
    cmd.arg(format!("format={}", yolo_format));
    cmd.arg(format!("imgsz={}", request.imgsz));
    cmd.arg(format!("batch={}", request.batch));
    if request.half {
        cmd.arg("half=True");
    }
    if request.int8 {
        cmd.arg("int8=True");
    }
    if request.dynamic {
        cmd.arg("dynamic=True");
    }
    if request.simplify {
        cmd.arg("simplify=True");
    }
    if request.optimize {
        cmd.arg("optimize=True");
    }
    if request.nms {
        cmd.arg("nms=True");
    }
    if request.end_to_end {
        cmd.arg("end2end=True");
    }
    if request.keras {
        cmd.arg("keras=True");
    }
    if let Some(v) = request.opset {
        cmd.arg(format!("opset={}", v));
    }
    if let Some(v) = request.workspace {
        cmd.arg(format!("workspace={}", v));
    }
    if request.route_id == "ultralytics.pt.rknn" && !request.chip.trim().is_empty() {
        cmd.arg(format!("name={}", request.chip.trim()));
    }
    Ok(cmd)
}

pub fn confirm_artifacts(request: &ExportRequest) -> ArtifactStatus {
    if request.output_dir.is_empty() {
        return ArtifactStatus {
            artifact_moved: false,
            artifact_warning: None,
        };
    }
    let yolo_format = match request.route_id.strip_prefix("ultralytics.pt.") {
        Some(value) => value,
        None => {
            return ArtifactStatus {
                artifact_moved: false,
                artifact_warning: None,
            }
        }
    };
    match move_artifact(&request.source_path, yolo_format, &request.output_dir) {
        Ok(true) => ArtifactStatus { artifact_moved: true, artifact_warning: None },
        Ok(false) => ArtifactStatus {
            artifact_moved: false,
            artifact_warning: Some(format!(
                "Export finished, but artifact was not moved to {}. Output may still be next to source model.",
                request.output_dir
            )),
        },
        Err(error) => ArtifactStatus {
            artifact_moved: false,
            artifact_warning: Some(format!(
                "Export finished, but artifact move to {} failed: {}",
                request.output_dir, error
            )),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::move_artifact;
    use std::fs;
    use std::path::PathBuf;
    use uuid::Uuid;

    fn temp_dir(prefix: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("yolo-export-studio-{}-{}", prefix, Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn build_command_keeps_existing_onnx_args() {
        let root = temp_dir("build-cmd");
        let yolo_path = root.join("yolo");
        std::fs::write(&yolo_path, "#!/bin/sh").expect("write yolo stub");
        let source_path = root.join("best.pt");
        std::fs::write(&source_path, "model").expect("write source model");
        let request = super::ExportRequest {
            provider: crate::commands::provider_registry::ProviderId::Ultralytics,
            source_path: source_path.to_string_lossy().to_string(),
            route_id: "ultralytics.pt.onnx".to_string(),
            output_dir: root.join("out").to_string_lossy().to_string(),
            yolo_path: yolo_path.to_string_lossy().to_string(),
            python_path: String::new(),
            imgsz: 640,
            batch: 1,
            half: true,
            int8: false,
            dynamic: false,
            simplify: true,
            optimize: false,
            nms: false,
            end_to_end: false,
            keras: false,
            opset: Some(13),
            workspace: None,
            chip: String::new(),
            rfdetr_trust_confirmed: false,
            rfdetr_variant_mode: None,
            rfdetr_manual_class_symbol: None,
        };
        let cmd = super::build_command(&request).expect("build command");
        let args: Vec<String> = cmd
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();
        assert_eq!(
            args,
            vec![
                "export",
                &format!("model={}", source_path.to_string_lossy()),
                "format=onnx",
                "imgsz=640",
                "batch=1",
                "half=True",
                "simplify=True",
                "opset=13",
            ]
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn move_artifact_moves_file_into_output_dir() {
        let root = temp_dir("export-file");
        let source_dir = root.join("source");
        let output_dir = root.join("output");
        fs::create_dir_all(&source_dir).expect("create source dir");
        fs::create_dir_all(&output_dir).expect("create output dir");

        let source_model = source_dir.join("best.pt");
        let source_artifact = source_dir.join("best.onnx");
        fs::write(&source_model, "model").expect("write source model");
        fs::write(&source_artifact, "artifact").expect("write source artifact");

        let moved = move_artifact(
            &source_model.to_string_lossy(),
            "onnx",
            &output_dir.to_string_lossy(),
        )
        .expect("move artifact");

        assert!(moved);
        assert!(!source_artifact.exists());
        assert!(output_dir.join("best.onnx").exists());

        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn move_artifact_reports_missing_artifact() {
        let root = temp_dir("export-missing");
        let source_dir = root.join("source");
        let output_dir = root.join("output");
        fs::create_dir_all(&source_dir).expect("create source dir");
        fs::create_dir_all(&output_dir).expect("create output dir");

        let source_model = source_dir.join("best.pt");
        fs::write(&source_model, "model").expect("write source model");

        let moved = move_artifact(
            &source_model.to_string_lossy(),
            "onnx",
            &output_dir.to_string_lossy(),
        )
        .expect("missing artifact should not error");

        assert!(!moved);

        fs::remove_dir_all(root).expect("cleanup");
    }
}
