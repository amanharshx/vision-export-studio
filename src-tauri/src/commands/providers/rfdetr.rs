use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(test)]
use std::time::SystemTime;

#[cfg(test)]
use sha2::{Digest, Sha256};
use tauri::Manager;

use crate::commands::artifacts::{ArtifactDescriptor, ArtifactKind};
use crate::commands::provider_registry::validate_rfdetr_manual_class;
#[cfg(test)]
use crate::commands::provider_registry::{rfdetr_artifact_rule, RfDetrArtifactRule};

#[cfg(test)]
use super::ArtifactStatus;
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
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to read RF-DETR staging entry: {}", error))?;
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
    if let Some(produced) = produced {
        if produced != requested {
            return Err(format!(
                "effective precision mismatch: requested {}, produced {}",
                requested, produced
            ));
        }
    }
    Ok(())
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

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg(test)]
pub struct ArtifactFingerprint {
    pub name: String,
    pub len: u64,
    pub modified: Option<SystemTime>,
    pub digest: [u8; 32],
}

#[cfg(test)]
fn sha256_file(path: &Path) -> Result<[u8; 32], String> {
    let data =
        std::fs::read(path).map_err(|e| format!("failed to read file for hashing: {}", e))?;
    let mut hasher = Sha256::new();
    hasher.update(&data);
    Ok(hasher.finalize().into())
}

#[cfg(test)]
fn sha256_directory(path: &Path) -> Result<[u8; 32], String> {
    fn hash_entries(path: &Path, hasher: &mut Sha256) -> Result<(), String> {
        let mut entries: Vec<_> = std::fs::read_dir(path)
            .map_err(|e| format!("failed to read package directory for hashing: {}", e))?
            .collect::<Result<_, _>>()
            .map_err(|e| format!("failed to read package entry for hashing: {}", e))?;
        entries.sort_by_key(|entry| entry.file_name());

        for entry in entries {
            let path = entry.path();
            hasher.update(entry.file_name().as_encoded_bytes());
            if path.is_dir() {
                hasher.update(b"directory");
                hash_entries(&path, hasher)?;
            } else if path.is_file() {
                hasher.update(b"file");
                hasher.update(
                    std::fs::read(&path)
                        .map_err(|e| format!("failed to read package file for hashing: {}", e))?,
                );
            }
        }
        Ok(())
    }

    let mut hasher = Sha256::new();
    hash_entries(path, &mut hasher)?;
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
    append_helper_args(&mut cmd, request, &helper)?;
    Ok(cmd)
}

fn append_helper_args(
    cmd: &mut Command,
    request: &ExportRequest,
    helper: &Path,
) -> Result<(), String> {
    let variant_mode = request.rfdetr_variant_mode.as_deref().unwrap_or("auto");
    cmd.arg(helper);
    cmd.arg("export");
    cmd.arg("--checkpoint").arg(&request.source_path);
    cmd.arg("--route-id").arg(&request.route_id);
    let output_dir = request
        .staging_dir
        .as_deref()
        .ok_or_else(|| "RF-DETR export requires a staging directory".to_string())?;
    cmd.arg("--output-dir").arg(output_dir);
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
    if matches!(
        request.route_id.as_str(),
        "rfdetr.pth.engine" | "rfdetr.pth.coreml" | "rfdetr.pth.tflite"
    ) {
        cmd.arg("--precision").arg(&request.precision);
    }
    Ok(())
}

#[cfg(test)]
fn tflite_artifacts(staging_dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut artifacts = std::fs::read_dir(staging_dir)
        .map_err(|error| format!("failed to read TFLite staging directory: {}", error))?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to read TFLite staging entry: {}", error))?;
    artifacts.retain(|path| path.is_file() && path.extension().is_some_and(|ext| ext == "tflite"));
    artifacts.sort();
    Ok(artifacts)
}

#[cfg(test)]
pub fn finalize_tflite_export(
    staging_dir: &Path,
    output_dir: &Path,
    precision: &str,
) -> Result<usize, String> {
    let required = if precision == "int8" { 3 } else { 2 };
    let artifacts = tflite_artifacts(staging_dir)?;
    if artifacts.len() != required {
        return Err(format!(
            "TFLite export produced {} final artifacts; expected {}",
            artifacts.len(),
            required
        ));
    }

    if output_dir.exists() {
        for artifact in &artifacts {
            let destination = output_dir.join(
                artifact
                    .file_name()
                    .ok_or_else(|| "TFLite artifact has no file name".to_string())?,
            );
            if destination.exists() {
                return Err(format!(
                    "TFLite artifact already exists in output directory: {}",
                    destination.display()
                ));
            }
        }
    }

    std::fs::create_dir_all(output_dir)
        .map_err(|error| format!("failed to create output directory: {}", error))?;
    for artifact in &artifacts {
        let destination = output_dir.join(
            artifact
                .file_name()
                .ok_or_else(|| "TFLite artifact has no file name".to_string())?,
        );
        std::fs::rename(artifact, &destination)
            .or_else(|rename_error| {
                std::fs::copy(artifact, &destination)
                    .map(|_| ())
                    .and_then(|()| std::fs::remove_file(artifact))
                    .map_err(|copy_error| {
                        format!(
                            "failed to move TFLite artifact (rename: {}; copy: {})",
                            rename_error, copy_error
                        )
                    })
            })
            .map_err(|error| error.to_string())?;
    }
    std::fs::remove_dir_all(staging_dir)
        .map_err(|error| format!("failed to remove TFLite staging directory: {}", error))?;
    Ok(artifacts.len())
}

#[cfg(test)]
fn confirm_rfdetr_artifacts(route_id: &str, output_dir: &str) -> Result<bool, String> {
    let rule =
        rfdetr_artifact_rule(route_id).ok_or_else(|| format!("unknown route: {}", route_id))?;
    let output = Path::new(output_dir);
    let count = std::fs::read_dir(output)
        .map_err(|e| format!("failed to read output dir: {}", e))?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| match &rule {
            RfDetrArtifactRule::Named {
                extension,
                prefix,
                exact,
            } => name
                .strip_suffix(extension)
                .is_some_and(|stem| stem == *exact || stem.starts_with(*prefix)),
            RfDetrArtifactRule::Extension { extension } => name.ends_with(extension),
        })
        .count();
    if count >= 1 {
        Ok(true)
    } else {
        Err(format!(
            "no matching {} artifact found in output directory",
            match &rule {
                RfDetrArtifactRule::Named { extension, .. }
                | RfDetrArtifactRule::Extension { extension } => *extension,
            }
        ))
    }
}

#[cfg(test)]
#[allow(dead_code)]
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

#[cfg(test)]
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
        let allows_directory = matches!(
            rule,
            RfDetrArtifactRule::Extension {
                extension: ".mlpackage"
            }
        );
        if !(path.is_file() || allows_directory && path.is_dir()) {
            continue;
        }
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

        let matches = match &rule {
            RfDetrArtifactRule::Named {
                extension,
                prefix,
                exact,
            } => name
                .strip_suffix(extension)
                .is_some_and(|stem| stem == *exact || stem.starts_with(*prefix)),
            RfDetrArtifactRule::Extension { extension } => name.ends_with(extension),
        };

        if matches {
            let meta = entry
                .metadata()
                .map_err(|e| format!("failed to read metadata: {}", e))?;
            fingerprints.push(ArtifactFingerprint {
                name: name.to_string(),
                len: meta.len(),
                modified: meta.modified().ok(),
                digest: if path.is_file() {
                    sha256_file(&path)?
                } else {
                    sha256_directory(&path)?
                },
            });
        }
    }

    Ok(fingerprints)
}

#[cfg(test)]
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

    let changed = after
        .iter()
        .filter(
            |post| match before.iter().find(|pre| pre.name == post.name) {
                None => true,
                Some(pre) => {
                    post.len != pre.len
                        || post.modified != pre.modified
                        || post.digest != pre.digest
                }
            },
        )
        .count();

    let required = 1;
    if changed >= required {
        ArtifactStatus {
            artifact_moved: true,
            artifact_warning: None,
        }
    } else {
        ArtifactStatus {
            artifact_moved: false,
            artifact_warning: Some(format!(
                "RF-DETR export process exited successfully, but only {} of {} required artifact(s) were new or updated in {}. Existing files may be stale.",
                changed, required, request.output_dir
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
    use super::discover_staged_artifacts;
    use super::snapshot_rfdetr_artifacts;
    use super::ArtifactFingerprint;
    use std::process::Command;

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
            precision: "fp32".to_string(),
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
            staging_dir: None,
        }
    }

    #[test]
    fn helper_args_forward_tensorrt_precision() {
        for (precision, expected) in [("fp16", "fp16"), ("fp32", "fp32")] {
            let mut request = make_request("rfdetr.pth.engine", "/tmp/output");
            request.precision = precision.to_string();
            request.staging_dir = Some("/tmp/runtime/.rfdetr-staging/session".into());
            let mut command = Command::new("python");

            super::append_helper_args(
                &mut command,
                &request,
                std::path::Path::new("/tmp/rfdetr_export_helper.py"),
            )
            .expect("every RF-DETR route uses staging");

            let args: Vec<String> = command
                .get_args()
                .map(|arg| arg.to_string_lossy().to_string())
                .collect();
            assert!(args
                .windows(2)
                .any(|pair| pair == ["--precision", expected]));
        }
    }

    #[test]
    fn tflite_helper_args_use_staging_output_dir() {
        let mut request = make_request("rfdetr.pth.tflite", "/tmp/user-output");
        request.staging_dir = Some("/tmp/runtime/.rfdetr-staging/session".into());
        let mut command = Command::new("python");

        super::append_helper_args(
            &mut command,
            &request,
            std::path::Path::new("/tmp/rfdetr_export_helper.py"),
        )
        .expect("staging path accepted");

        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();
        assert!(args
            .windows(2)
            .any(|pair| { pair == ["--output-dir", "/tmp/runtime/.rfdetr-staging/session",] }));
        assert!(!args
            .windows(2)
            .any(|pair| pair == ["--output-dir", "/tmp/user-output"]));
    }

    #[test]
    fn tflite_helper_args_reject_missing_staging_output_dir() {
        let request = make_request("rfdetr.pth.tflite", "/tmp/user-output");
        let mut command = Command::new("python");

        let error = super::append_helper_args(
            &mut command,
            &request,
            std::path::Path::new("/tmp/rfdetr_export_helper.py"),
        )
        .expect_err("TFLite must fail closed without staging");

        assert!(error.contains("staging"));
        assert!(!command
            .get_args()
            .any(|arg| arg == std::ffi::OsStr::new("/tmp/user-output")));
    }

    #[test]
    fn tflite_finalization_moves_exact_fp32_artifacts_only() {
        let root = std::env::temp_dir().join(format!("rfdetr-finalize-{}", uuid::Uuid::new_v4()));
        let staging = root.join("staging");
        let output = root.join("output");
        std::fs::create_dir_all(&staging).expect("create staging");
        for name in ["rfdetr-small.tflite", "rfdetr-small_dynamic.tflite"] {
            std::fs::write(staging.join(name), name.as_bytes()).expect("write artifact");
        }
        std::fs::write(staging.join("inference_model.onnx"), b"onnx").expect("write onnx");
        std::fs::write(staging.join("_rfdetr_calib_data.npy"), b"calib").expect("write calib");
        let saved_model = staging.join("saved_model");
        std::fs::create_dir_all(saved_model.join("variables")).expect("create variables");
        std::fs::create_dir_all(saved_model.join("assets")).expect("create assets");
        std::fs::write(saved_model.join("saved_model.pb"), b"saved model")
            .expect("write saved model");
        std::fs::write(saved_model.join("fingerprint.pb"), b"fingerprint")
            .expect("write fingerprint");

        super::finalize_tflite_export(&staging, &output, "fp32").expect("finalize");

        assert_eq!(std::fs::read_dir(&output).expect("read output").count(), 2);
        assert!(!staging.exists());
        assert!(!output.join("inference_model.onnx").exists());
        assert!(!output.join("_rfdetr_calib_data.npy").exists());
        assert!(!output.join("saved_model").exists());
        assert!(!output.join("saved_model/variables").exists());
        assert!(!output.join("saved_model/assets").exists());
        assert!(!output.join("saved_model/saved_model.pb").exists());
        assert!(!output.join("saved_model/fingerprint.pb").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn tflite_finalization_rejects_missing_artifact_without_touching_output() {
        let root = std::env::temp_dir().join(format!("rfdetr-missing-{}", uuid::Uuid::new_v4()));
        let staging = root.join("staging");
        let output = root.join("output");
        std::fs::create_dir_all(&staging).expect("create staging");
        std::fs::create_dir_all(&output).expect("create output");
        std::fs::write(output.join("keep.txt"), b"keep").expect("write existing");
        std::fs::write(staging.join("only.tflite"), b"one").expect("write artifact");

        assert!(super::finalize_tflite_export(&staging, &output, "fp32").is_err());
        assert_eq!(
            std::fs::read(output.join("keep.txt")).expect("read existing"),
            b"keep"
        );
        assert!(!output.join("only.tflite").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn tflite_finalization_checks_all_collisions_before_moving() {
        let root = std::env::temp_dir().join(format!("rfdetr-collision-{}", uuid::Uuid::new_v4()));
        let staging = root.join("staging");
        let output = root.join("output");
        std::fs::create_dir_all(&staging).expect("create staging");
        std::fs::create_dir_all(&output).expect("create output");
        for (name, contents) in [("one.tflite", b"one"), ("two.tflite", b"two")] {
            std::fs::write(staging.join(name), contents).expect("write staging artifact");
        }
        std::fs::write(output.join("two.tflite"), b"existing").expect("write collision");

        assert!(super::finalize_tflite_export(&staging, &output, "fp32").is_err());
        assert!(!output.join("one.tflite").exists());
        assert_eq!(
            std::fs::read(output.join("two.tflite")).expect("read collision"),
            b"existing"
        );
        assert!(staging.join("one.tflite").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn tflite_finalization_moves_three_int8_artifacts() {
        let root = std::env::temp_dir().join(format!("rfdetr-int8-{}", uuid::Uuid::new_v4()));
        let staging = root.join("staging");
        let output = root.join("output");
        std::fs::create_dir_all(&staging).expect("create staging");
        for name in ["one.tflite", "two.tflite", "three.tflite"] {
            std::fs::write(staging.join(name), name.as_bytes()).expect("write artifact");
        }

        super::finalize_tflite_export(&staging, &output, "int8").expect("finalize");
        assert_eq!(std::fs::read_dir(&output).expect("read output").count(), 3);
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
    fn confirm_artifacts_accepts_inference_model_fp16_trt() {
        let root = std::env::temp_dir().join(format!("rfdetr-trt-fp16-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp dir");
        std::fs::write(root.join("inference_model_fp16.trt"), b"trt").expect("write trt");
        let result = confirm_rfdetr_artifacts("rfdetr.pth.engine", root.to_str().expect("path"));
        assert_eq!(result, Ok(true));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn confirm_artifacts_accepts_inference_model_fp32_trt() {
        let root = std::env::temp_dir().join(format!("rfdetr-trt-fp32-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp dir");
        std::fs::write(root.join("inference_model_fp32.trt"), b"trt").expect("write trt");
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
    fn confirm_artifacts_accepts_custom_trt_file() {
        let root = std::env::temp_dir().join(format!("rfdetr-custom-trt-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp dir");
        std::fs::write(root.join("custom-export.trt"), b"trt").expect("write trt");
        let result = confirm_rfdetr_artifacts("rfdetr.pth.engine", root.to_str().expect("path"));
        assert_eq!(result, Ok(true));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn confirm_artifacts_rejects_engine_file() {
        let root = std::env::temp_dir().join(format!("rfdetr-engine-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp dir");
        std::fs::write(root.join("inference_model.engine"), b"engine").expect("write engine");
        let result = confirm_rfdetr_artifacts("rfdetr.pth.engine", root.to_str().expect("path"));
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn confirm_artifacts_accepts_coreml_package_directories() {
        let root = std::env::temp_dir().join(format!("rfdetr-coreml-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("rfdetr-medium_fp32.mlpackage"))
            .expect("create fp32 package");
        std::fs::create_dir_all(root.join("rfdetr-small_fp16.mlpackage"))
            .expect("create fp16 package");

        assert_eq!(
            confirm_rfdetr_artifacts("rfdetr.pth.coreml", root.to_str().expect("path")),
            Ok(true)
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn confirm_artifacts_rejects_empty_coreml_output_dir() {
        let root =
            std::env::temp_dir().join(format!("rfdetr-coreml-empty-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp dir");

        assert!(
            confirm_rfdetr_artifacts("rfdetr.pth.coreml", root.to_str().expect("path")).is_err()
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn snapshot_captures_coreml_package_directory() {
        let root =
            std::env::temp_dir().join(format!("rfdetr-coreml-snap-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("rfdetr-small_fp16.mlpackage")).expect("create package");

        let snap = snapshot_rfdetr_artifacts("rfdetr.pth.coreml", root.to_str().expect("path"))
            .expect("snapshot");
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].name, "rfdetr-small_fp16.mlpackage");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn snapshot_ignores_onnx_and_tensorrt_directories() {
        let root = std::env::temp_dir().join(format!("rfdetr-file-only-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("rfdetr-small.onnx")).expect("create onnx directory");
        std::fs::create_dir_all(root.join("model.trt")).expect("create trt directory");

        assert!(
            snapshot_rfdetr_artifacts("rfdetr.pth.onnx", root.to_str().expect("path"))
                .expect("onnx snapshot")
                .is_empty()
        );
        assert!(
            snapshot_rfdetr_artifacts("rfdetr.pth.engine", root.to_str().expect("path"))
                .expect("tensorrt snapshot")
                .is_empty()
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn with_snapshot_accepts_same_name_coreml_package_rewrite() {
        let root =
            std::env::temp_dir().join(format!("rfdetr-coreml-rewrite-{}", uuid::Uuid::new_v4()));
        let package = root.join("rfdetr-small_fp16.mlpackage");
        std::fs::create_dir_all(&package).expect("create package");
        std::fs::write(package.join("model.bin"), b"AAAA").expect("write first model");
        let before = snapshot_rfdetr_artifacts("rfdetr.pth.coreml", root.to_str().expect("path"))
            .expect("snapshot");

        std::fs::write(package.join("model.bin"), b"BBBB").expect("rewrite model");
        let request = make_request("rfdetr.pth.coreml", root.to_str().expect("path"));
        let status = confirm_artifacts_with_snapshot(&request, &before);

        assert!(
            status.artifact_moved,
            "rewritten CoreML package should be accepted"
        );
        assert!(status.artifact_warning.is_none());
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
    fn executorch_snapshot_accepts_released_and_backend_named_pte_artifacts() {
        let root = std::env::temp_dir().join(format!("rfdetr-pte-snap-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp dir");
        std::fs::write(root.join("rfdetr-small.pte"), b"released")
            .expect("write released artifact");
        std::fs::write(root.join("rfdetr-small_xnnpack.pte"), b"develop")
            .expect("write backend artifact");
        std::fs::write(root.join("rfdetr-small.onnx"), b"wrong").expect("write unrelated artifact");

        let snapshot =
            snapshot_rfdetr_artifacts("rfdetr.pth.executorch", root.to_str().expect("path"))
                .expect("snapshot");

        assert_eq!(snapshot.len(), 2);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn executorch_rewritten_pte_is_confirmed_by_fingerprint_change() {
        let root =
            std::env::temp_dir().join(format!("rfdetr-pte-rewrite-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp dir");
        let artifact = root.join("rfdetr-small.pte");
        std::fs::write(&artifact, b"AAAA").expect("write initial artifact");
        let before =
            snapshot_rfdetr_artifacts("rfdetr.pth.executorch", root.to_str().expect("path"))
                .expect("snapshot");
        std::fs::write(&artifact, b"BBBB").expect("rewrite artifact");

        let status = confirm_artifacts_with_snapshot(
            &make_request("rfdetr.pth.executorch", root.to_str().expect("path")),
            &before,
        );

        assert!(
            status.artifact_moved,
            "same-size PTE rewrite must be accepted by digest"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn snapshot_captures_trt_files() {
        let root = std::env::temp_dir().join(format!("rfdetr-trt-snap-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp dir");
        std::fs::write(root.join("inference_model_fp16.trt"), b"trt").expect("write trt");
        let snap = snapshot_rfdetr_artifacts("rfdetr.pth.engine", root.to_str().expect("path"))
            .expect("snapshot");
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].name, "inference_model_fp16.trt");
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
    fn with_snapshot_accepts_new_trt_file() {
        let root = std::env::temp_dir().join(format!("rfdetr-new-trt-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp dir");
        let before: Vec<ArtifactFingerprint> = vec![];
        std::fs::write(root.join("inference_model_fp16.trt"), b"trt").expect("write trt");
        let req = make_request("rfdetr.pth.engine", root.to_str().expect("path"));
        let status = confirm_artifacts_with_snapshot(&req, &before);
        assert!(status.artifact_moved, "new trt file should be accepted");
        assert!(status.artifact_warning.is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn with_snapshot_rejects_stale_trt_file() {
        let root = std::env::temp_dir().join(format!("rfdetr-stale-trt-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp dir");
        std::fs::write(root.join("inference_model_fp16.trt"), b"trt").expect("write trt");

        let before = snapshot_rfdetr_artifacts("rfdetr.pth.engine", root.to_str().expect("path"))
            .expect("snapshot");
        let req = make_request("rfdetr.pth.engine", root.to_str().expect("path"));
        let status = confirm_artifacts_with_snapshot(&req, &before);
        assert!(!status.artifact_moved, "stale trt file should be rejected");
        assert!(status.artifact_warning.is_some());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn with_snapshot_accepts_updated_trt_file() {
        let root = std::env::temp_dir().join(format!("rfdetr-upd-trt-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp dir");
        std::fs::write(root.join("inference_model_fp16.trt"), b"v1-trt").expect("write v1");

        let before = snapshot_rfdetr_artifacts("rfdetr.pth.engine", root.to_str().expect("path"))
            .expect("snapshot");
        std::fs::write(root.join("inference_model_fp16.trt"), b"v2-trt-exported")
            .expect("write v2");

        let req = make_request("rfdetr.pth.engine", root.to_str().expect("path"));
        let status = confirm_artifacts_with_snapshot(&req, &before);
        assert!(status.artifact_moved, "updated trt file should be accepted");
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
    fn with_snapshot_accepts_same_size_trt_rewrite() {
        let root = std::env::temp_dir().join(format!("rfdetr-samesz-trt-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp dir");
        std::fs::write(root.join("inference_model_fp16.trt"), b"AAAA").expect("write v1");

        let before = snapshot_rfdetr_artifacts("rfdetr.pth.engine", root.to_str().expect("path"))
            .expect("snapshot");
        std::fs::write(root.join("inference_model_fp16.trt"), b"BBBB").expect("write v2");

        let req = make_request("rfdetr.pth.engine", root.to_str().expect("path"));
        let status = confirm_artifacts_with_snapshot(&req, &before);
        assert!(
            status.artifact_moved,
            "same-size trt rewrite should be detected via digest"
        );
        assert!(status.artifact_warning.is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn staged_tflite_int8_aliases_map_to_required_semantic_variants() {
        let root = std::env::temp_dir().join(format!("rfdetr-discovery-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create staging");
        for name in [
            "model_float32.tflite",
            "model_float16.tflite",
            "model_dynamic_range_quant.tflite",
        ] {
            std::fs::write(root.join(name), b"artifact").expect("write artifact");
        }
        let mut request = make_request("rfdetr.pth.tflite", "/tmp/output");
        request.precision = "int8".into();
        request.staging_dir = Some(root.to_string_lossy().into_owned());
        let artifacts = discover_staged_artifacts(&request).expect("discover staged set");
        assert_eq!(artifacts.len(), 3);
        assert!(artifacts
            .iter()
            .any(|item| item.variant.as_deref() == Some("dynamic_range_quant")));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn staged_tflite_rejects_duplicate_semantic_variants() {
        let root = std::env::temp_dir().join(format!("rfdetr-duplicate-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create staging");
        for name in ["model_fp32.tflite", "other_float32.tflite"] {
            std::fs::write(root.join(name), b"artifact").expect("write artifact");
        }
        let mut request = make_request("rfdetr.pth.tflite", "/tmp/output");
        request.staging_dir = Some(root.to_string_lossy().into_owned());
        assert!(discover_staged_artifacts(&request).is_err());
        let _ = std::fs::remove_dir_all(root);
    }
}
