use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::Manager;

use crate::commands::artifacts::{ArtifactDescriptor, ArtifactKind};
use crate::commands::deps::{flatc_resolver_code, probe};
use crate::commands::provider_registry::validate_rfdetr_manual_class;

use super::ExportRequest;

pub const RFDETR_STAGING_PARENT: &str = ".rfdetr-staging";

pub fn create_rfdetr_staging_dir(runtime_dir: &Path, session_id: &str) -> Result<PathBuf, String> {
    let staging = runtime_dir.join(RFDETR_STAGING_PARENT).join(session_id);
    std::fs::create_dir_all(&staging)
        .map_err(|error| format!("failed to create RF-DETR staging directory: {}", error))?;
    Ok(staging)
}

pub fn discover_staged_artifacts(
    request: &ExportRequest,
) -> Result<Vec<ArtifactDescriptor>, String> {
    let staging = request
        .staging_dir
        .as_deref()
        .map(Path::new)
        .ok_or_else(|| "RF-DETR export requires a staging directory".to_string())?;
    let mut entries = std::fs::read_dir(staging)
        .map_err(|error| format!("failed to read RF-DETR staging directory: {}", error))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    entries.sort();
    let descriptor = |path: PathBuf,
                      format: &str,
                      extension: Option<&str>,
                      precision: &str,
                      variant: Option<&str>,
                      kind: ArtifactKind| ArtifactDescriptor {
        source_path: path,
        kind,
        format: format.to_string(),
        qualifier: None,
        precision_or_profile: precision.to_string(),
        variant: variant.map(str::to_string),
        extension: extension.map(str::to_string),
    };

    match request.route_id.as_str() {
        "rfdetr.pth.onnx" => exactly_one_file(&entries, "onnx").map(|path| {
            vec![descriptor(
                path,
                "onnx",
                Some("onnx"),
                "fp32",
                None,
                ArtifactKind::File,
            )]
        }),
        "rfdetr.pth.engine" => exactly_one_file(&entries, "trt").and_then(|path| {
            validate_named_precision(&path, &request.precision)?;
            Ok(vec![descriptor(
                path,
                "engine",
                Some("engine"),
                &request.precision,
                None,
                ArtifactKind::File,
            )])
        }),
        "rfdetr.pth.coreml" => exactly_one_directory(&entries, "mlpackage").map(|path| {
            vec![descriptor(
                path,
                "coreml",
                Some("mlpackage"),
                &request.precision,
                None,
                ArtifactKind::Directory,
            )]
        }),
        "rfdetr.pth.executorch" => exactly_one_file(&entries, "pte").map(|path| {
            vec![descriptor(
                path,
                "executorch",
                Some("pte"),
                "fp32",
                None,
                ArtifactKind::File,
            )]
        }),
        "rfdetr.pth.tflite" => discover_tflite_set(entries, request, descriptor),
        route => Err(format!("unsupported RF-DETR route: {}", route)),
    }
    .map_err(|error| format!("RF-DETR artifact validation failed: {}", error))
}

fn validate_named_precision(path: &Path, requested: &str) -> Result<(), String> {
    let name = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();
    let produced = if name.contains("fp16") || name.contains("float16") {
        Some("fp16")
    } else if name.contains("fp32") || name.contains("float32") {
        Some("fp32")
    } else {
        None
    };
    match produced {
        Some(produced) if produced != requested => Err(format!(
            "effective precision mismatch: requested {}, produced {}",
            requested, produced
        )),
        None if requested != "fp32" => Err(format!(
            "effective precision mismatch: requested {}, produced unknown",
            requested
        )),
        _ => Ok(()),
    }
}

fn exactly_one_file(entries: &[PathBuf], extension: &str) -> Result<PathBuf, String> {
    let matches = entries
        .iter()
        .filter(|path| {
            path.is_file() && path.extension().and_then(|value| value.to_str()) == Some(extension)
        })
        .cloned()
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [path] => Ok(path.clone()),
        [] => Err(format!(
            "expected exactly one .{} file, found none",
            extension
        )),
        _ => Err(format!(
            "expected exactly one .{} file, found {}",
            extension,
            matches.len()
        )),
    }
}

fn exactly_one_directory(entries: &[PathBuf], extension: &str) -> Result<PathBuf, String> {
    let matches = entries
        .iter()
        .filter(|path| {
            path.is_dir() && path.extension().and_then(|value| value.to_str()) == Some(extension)
        })
        .cloned()
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [path] => Ok(path.clone()),
        [] => Err(format!(
            "expected exactly one .{} bundle, found none",
            extension
        )),
        _ => Err(format!(
            "expected exactly one .{} bundle, found {}",
            extension,
            matches.len()
        )),
    }
}

fn discover_tflite_set<F>(
    entries: Vec<PathBuf>,
    request: &ExportRequest,
    descriptor: F,
) -> Result<Vec<ArtifactDescriptor>, String>
where
    F: Fn(PathBuf, &str, Option<&str>, &str, Option<&str>, ArtifactKind) -> ArtifactDescriptor,
{
    let files = entries
        .into_iter()
        .filter(|path| {
            path.is_file() && path.extension().and_then(|value| value.to_str()) == Some("tflite")
        })
        .collect::<Vec<_>>();
    let expected = if request.precision == "int8" { 3 } else { 2 };
    if files.len() != expected {
        return Err(format!(
            "TFLite {} profile produced {} .tflite files; expected {}",
            request.precision,
            files.len(),
            expected
        ));
    }
    let mut found = Vec::new();
    for path in files {
        let name = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_lowercase();
        let variant =
            if name.contains("dynamic") || name.contains("range") || name.contains("quant") {
                "dynamic_range_quant"
            } else if name.contains("float16") || name.contains("fp16") {
                "fp16"
            } else if name.contains("float32") || name.contains("fp32") {
                "fp32"
            } else {
                return Err(format!("unrecognized TFLite semantic variant: {}", name));
            };
        if found
            .iter()
            .any(|item: &ArtifactDescriptor| item.variant.as_deref() == Some(variant))
        {
            return Err(format!("duplicate TFLite semantic variant: {}", variant));
        }
        found.push(descriptor(
            path,
            "tflite",
            Some("tflite"),
            &request.precision,
            Some(variant),
            ArtifactKind::File,
        ));
    }
    let required = if request.precision == "int8" {
        ["fp32", "fp16", "dynamic_range_quant"].as_slice()
    } else {
        ["fp32", "fp16"].as_slice()
    };
    if required.iter().any(|variant| {
        !found
            .iter()
            .any(|item| item.variant.as_deref() == Some(*variant))
    }) {
        return Err("TFLite profile missing required semantic variant".to_string());
    }
    found.sort_by_key(|item| item.variant.clone());
    Ok(found)
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
    append_helper_args(&mut cmd, request, &helper)?;
    if request.route_id == "rfdetr.pth.executorch" {
        let resolver = format!(
            "exec({:?}, globals()); print(_flatc_path or \"\")",
            flatc_resolver_code()
        );
        let flatc_path = probe(&request.python_path, &resolver)
            .map_err(|error| format!("failed to resolve ExecuTorch flatc compiler: {}", error))?;
        let flatc_path = flatc_path.trim();
        if flatc_path.is_empty() {
            return Err("No runnable ExecuTorch flatc compiler was found.".to_string());
        }
        cmd.env("FLATC_EXECUTABLE", flatc_path);
    }
    Ok(cmd)
}

fn append_helper_args(
    cmd: &mut Command,
    request: &ExportRequest,
    helper: &Path,
) -> Result<(), String> {
    let variant_mode = request.rfdetr_variant_mode.as_deref().unwrap_or("auto");
    cmd.arg(helper)
        .arg("export")
        .arg("--checkpoint")
        .arg(&request.source_path)
        .arg("--route-id")
        .arg(&request.route_id)
        .arg("--output-dir")
        .arg(
            request
                .staging_dir
                .as_deref()
                .ok_or_else(|| "RF-DETR export requires a staging directory".to_string())?,
        )
        .arg("--variant-mode")
        .arg(variant_mode);
    if let Some(symbol) = request.rfdetr_manual_class_symbol.as_deref() {
        if !symbol.is_empty() {
            cmd.arg("--manual-class-symbol").arg(symbol);
        }
    }
    cmd.arg("--imgsz")
        .arg(request.imgsz.to_string())
        .arg("--batch")
        .arg(request.batch.to_string());
    if let Some(value) = request.opset {
        cmd.arg("--opset").arg(value.to_string());
    }
    if matches!(
        request.route_id.as_str(),
        "rfdetr.pth.engine" | "rfdetr.pth.coreml" | "rfdetr.pth.tflite"
    ) {
        cmd.arg("--precision").arg(&request.precision);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::super::provider_registry::ProviderId;
    use super::super::ExportRequest;
    use super::discover_staged_artifacts;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use uuid::Uuid;

    fn temp_dir(prefix: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("rfdetr-contract-{}-{}", prefix, Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn make_request(route_id: &str, staging: &Path, precision: &str) -> ExportRequest {
        ExportRequest {
            provider: ProviderId::RfDetr,
            source_path: "/tmp/checkpoint.pth".into(),
            route_id: route_id.into(),
            output_dir: "/tmp/output".into(),
            yolo_path: String::new(),
            python_path: "/usr/bin/python3".into(),
            imgsz: 640,
            batch: 1,
            precision: precision.into(),
            calibration_data: None,
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
            staging_dir: Some(staging.to_string_lossy().into_owned()),
        }
    }

    #[test]
    fn helper_args_always_use_session_staging() {
        let root = temp_dir("args");
        let request = make_request("rfdetr.pth.engine", &root, "fp16");
        let mut command = Command::new("python");
        super::append_helper_args(&mut command, &request, PathBuf::from("helper.py").as_path())
            .unwrap();
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--output-dir", root.to_string_lossy().as_ref()]));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn tflite_int8_aliases_produce_three_semantic_members() {
        let root = temp_dir("tflite");
        for name in [
            "model_float32.tflite",
            "model_float16.tflite",
            "model_dynamic_range_quant.tflite",
        ] {
            fs::write(root.join(name), b"artifact").unwrap();
        }
        let request = make_request("rfdetr.pth.tflite", &root, "int8");
        let artifacts = discover_staged_artifacts(&request).unwrap();
        assert_eq!(artifacts.len(), 3);
        assert!(artifacts
            .iter()
            .any(|item| item.variant.as_deref() == Some("dynamic_range_quant")));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn tflite_rejects_duplicate_or_missing_variants() {
        let root = temp_dir("invalid-tflite");
        for name in ["model_fp32.tflite", "other_float32.tflite"] {
            fs::write(root.join(name), b"artifact").unwrap();
        }
        let request = make_request("rfdetr.pth.tflite", &root, "fp32");
        assert!(discover_staged_artifacts(&request).is_err());
        let _ = fs::remove_dir_all(root);
    }
}
