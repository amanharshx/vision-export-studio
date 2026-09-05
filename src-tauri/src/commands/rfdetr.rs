use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::UNIX_EPOCH;

use tauri::Manager;

use crate::commands::deps::probe;
use crate::commands::provider_registry::{validate_source_extension, ProviderId};
use crate::commands::setup::{load_settings, venv_python_at};
use crate::commands::stack_environments::{known_stacks, stack_venv_dir_if_usable};

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
    pub num_windows: Option<u32>,
    pub required_multiple: Option<u32>,
    pub token_grid: Option<u32>,
    pub resolution_source: Option<String>,
    pub error: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, PartialEq)]
pub struct RfDetrCheckpointIdentity {
    pub canonical_path: String,
    pub len: u64,
    pub modified_ms: u64,
}

pub(crate) fn checkpoint_identity_for_path(
    checkpoint_path: &str,
) -> Result<RfDetrCheckpointIdentity, String> {
    if !Path::new(checkpoint_path).exists() {
        return Err(format!(
            "checkpoint path does not exist: {}",
            checkpoint_path
        ));
    }
    validate_source_extension(ProviderId::RfDetr, checkpoint_path)?;
    let file = std::fs::File::open(checkpoint_path)
        .map_err(|e| format!("failed to open checkpoint: {}", e))?;
    checkpoint_identity_for_file(checkpoint_path, &file)
}

/// Identity derived from an already-open handle (fstat), so verification
/// observes the same bytes a later copy will read instead of re-statting —
/// and potentially re-resolving — the live path.
pub(crate) fn checkpoint_identity_for_file(
    checkpoint_path: &str,
    file: &std::fs::File,
) -> Result<RfDetrCheckpointIdentity, String> {
    let metadata = file
        .metadata()
        .map_err(|e| format!("failed to stat checkpoint: {}", e))?;
    let canonical = std::fs::canonicalize(checkpoint_path)
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|_| checkpoint_path.to_string());
    identity_from_metadata(canonical, &metadata)
}

fn identity_from_metadata(
    canonical_path: String,
    metadata: &std::fs::Metadata,
) -> Result<RfDetrCheckpointIdentity, String> {
    let modified_ms = metadata
        .modified()
        .map_err(|e| format!("failed to read checkpoint modification time: {}", e))?
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("checkpoint modification time is before epoch: {}", e))?
        .as_millis()
        .try_into()
        .map_err(|_| "checkpoint modification time out of range".to_string())?;
    Ok(RfDetrCheckpointIdentity {
        canonical_path,
        len: metadata.len(),
        modified_ms,
    })
}

#[tauri::command]
pub async fn rfdetr_checkpoint_identity(
    checkpoint_path: String,
) -> Result<RfDetrCheckpointIdentity, String> {
    checkpoint_identity_for_path(&checkpoint_path)
}

pub(crate) fn verify_trusted_identity(
    current: &RfDetrCheckpointIdentity,
    trusted: Option<&RfDetrCheckpointIdentity>,
) -> Result<(), String> {
    let Some(trusted) = trusted else {
        return Err(
            "checkpoint trust is not bound to the selected file; confirm trust again before inspection."
                .to_string(),
        );
    };
    if trusted != current {
        return Err(
            "checkpoint changed since trust was confirmed; confirm trust again before inspection."
                .to_string(),
        );
    }
    Ok(())
}

/// Actual inspection capability probe: folder existence or distribution
/// metadata alone is insufficient, so the candidate interpreter must import
/// `rfdetr` successfully.
fn stack_can_inspect(python: &str) -> bool {
    probe(python, "import rfdetr").is_ok()
}

fn unknown_stack_error(key: &str) -> String {
    format!("unknown RF-DETR stack: {}", key)
}

pub(crate) fn resolve_inspection_stack(
    runtime_dir: &Path,
    requested: Option<&str>,
    can_inspect: &dyn Fn(&str) -> bool,
) -> Result<(String, String), String> {
    if let Some(key) = requested {
        let stack = known_stacks()
            .iter()
            .find(|stack| stack.key == key)
            .ok_or_else(|| unknown_stack_error(key))?;
        // Same eligibility as inventory: symlinked or missing roots are not
        // app-owned stacks, even when the derived interpreter path exists.
        let venv = stack_venv_dir_if_usable(runtime_dir, stack.key).ok_or_else(|| {
            format!(
                "RF-DETR stack '{}' is not ready for inspection. Set up the route environment before inspection.",
                stack.key,
            )
        })?;
        let python = venv_python_at(&venv);
        if !Path::new(&python).exists() || !can_inspect(&python) {
            return Err(format!(
                "RF-DETR stack '{}' is not ready for inspection. Set up the route environment before inspection.",
                stack.key,
            ));
        }
        return Ok((stack.key.to_string(), python));
    }
    // Deterministic reuse: first healthy stack in known-stack order wins.
    for stack in known_stacks() {
        let Some(venv) = stack_venv_dir_if_usable(runtime_dir, stack.key) else {
            continue;
        };
        let python = venv_python_at(&venv);
        if !Path::new(&python).exists() {
            continue;
        }
        if can_inspect(&python) {
            return Ok((stack.key.to_string(), python));
        }
    }
    Err(
        "No healthy RF-DETR environment found. Set up a route environment before inspection."
            .to_string(),
    )
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
    stack_key: Option<String>,
    trust_confirmed: bool,
    trusted_identity: Option<RfDetrCheckpointIdentity>,
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

    // Resolve the slow capability probes first, then open the checkpoint
    // once: identity, verification, and the snapshot copy all observe the
    // same open handle, and the helper deserializes the snapshot — never the
    // live path — so a replacement in between cannot swap what gets trusted.
    let settings = load_settings(app_handle.clone())?;
    let runtime_dir = Path::new(&settings.runtime_dir);
    let (_key, python_path) =
        resolve_inspection_stack(runtime_dir, stack_key.as_deref(), &stack_can_inspect)?;

    let helper = app_handle
        .path()
        .resolve(
            "python/rfdetr_export_helper.py",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| format!("failed to resolve RF-DETR helper resource: {}", e))?;
    let mut source = std::fs::File::open(&checkpoint_path)
        .map_err(|e| format!("failed to open checkpoint: {}", e))?;
    let current = checkpoint_identity_for_file(&checkpoint_path, &source)?;
    verify_trusted_identity(&current, trusted_identity.as_ref())?;

    let snapshot_dir =
        std::env::temp_dir().join(format!("rfdetr-inspect-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&snapshot_dir)
        .map_err(|e| format!("failed to create inspection snapshot dir: {}", e))?;
    let snapshot_path = snapshot_dir.join("checkpoint.pth");
    let snapshot_result = (|| -> Result<(), String> {
        use std::io::{Seek, SeekFrom, Write};
        source
            .seek(SeekFrom::Start(0))
            .map_err(|e| format!("failed to snapshot checkpoint for inspection: {}", e))?;
        let mut out = std::fs::File::create(&snapshot_path)
            .map_err(|e| format!("failed to snapshot checkpoint for inspection: {}", e))?;
        std::io::copy(&mut source, &mut out)
            .map_err(|e| format!("failed to snapshot checkpoint for inspection: {}", e))?;
        out.flush()
            .map_err(|e| format!("failed to snapshot checkpoint for inspection: {}", e))?;
        // Re-read the handle's metadata after copying: byte count alone
        // cannot catch a same-length in-place rewrite.
        let after = source
            .metadata()
            .map_err(|e| format!("failed to stat checkpoint: {}", e))?;
        let after = identity_from_metadata(current.canonical_path.clone(), &after)?;
        if after != current {
            return Err(
                "checkpoint changed during snapshot; confirm trust again before inspection."
                    .to_string(),
            );
        }
        Ok(())
    })();
    if let Err(e) = snapshot_result {
        let _ = std::fs::remove_dir_all(&snapshot_dir);
        return Err(e);
    }

    let output = Command::new(&python_path)
        .arg(helper)
        .arg("inspect")
        .arg("--checkpoint")
        .arg(&snapshot_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output();
    let _ = std::fs::remove_dir_all(&snapshot_dir);
    let output = output.map_err(|e| format!("failed to run RF-DETR inspect helper: {}", e))?;
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
    use crate::commands::stack_environments::stack_venv_dir_for_key;

    #[test]
    fn parses_inspect_json_from_last_json_line() {
        let result = parse_inspect_stdout(br#"noise
{"success":true,"class_symbol":"RFDETRSmall","family":"detection","size":"small","requires_plus":false,"is_legacy":false,"recommended_imgsz":512,"patch_size":16,"num_windows":2,"required_multiple":32,"token_grid":32,"resolution_source":"saved_model_config","error":null}
"#).expect("parse inspect json");
        assert_eq!(result.class_symbol.as_deref(), Some("RFDETRSmall"));
        assert_eq!(result.recommended_imgsz, Some(512));
        assert_eq!(result.patch_size, Some(16));
        assert_eq!(result.num_windows, Some(2));
        assert_eq!(result.required_multiple, Some(32));
        assert_eq!(result.token_grid, Some(32));
        assert_eq!(
            result.resolution_source.as_deref(),
            Some("saved_model_config")
        );
        assert!(result.success);
    }

    #[test]
    fn parses_incomplete_geometry_inspect_json() {
        let result = parse_inspect_stdout(br#"{"success":true,"class_symbol":"RFDETRSmall","family":"detection","size":"small","requires_plus":false,"is_legacy":false,"recommended_imgsz":null,"patch_size":null,"num_windows":null,"required_multiple":null,"token_grid":null,"resolution_source":null,"error":null}
"#).expect("parse incomplete geometry json");
        assert!(result.success);
        assert_eq!(result.recommended_imgsz, None);
        assert_eq!(result.resolution_source, None);
    }

    #[test]
    fn helper_path_points_to_bundled_script() {
        let path = helper_path().expect("helper path");
        assert!(path.ends_with("python/rfdetr_export_helper.py"));
    }

    fn temp_checkpoint(name: &str, contents: &[u8]) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "rfdetr-trust-{}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4(),
            name
        ));
        std::fs::write(&path, contents).unwrap();
        path
    }

    fn temp_runtime() -> PathBuf {
        std::env::temp_dir().join(format!("rfdetr-inspect-{}", uuid::Uuid::new_v4()))
    }

    fn make_stack_python(runtime: &Path, stack_key: &str) -> String {
        let venv = stack_venv_dir_for_key(runtime, stack_key).expect("known stack");
        let python = venv_python_at(&venv);
        std::fs::create_dir_all(Path::new(&python).parent().unwrap()).unwrap();
        std::fs::write(&python, b"python").unwrap();
        python
    }

    #[test]
    fn checkpoint_identity_binds_canonical_size_and_mtime() {
        let path = temp_checkpoint("a.pth", b"weights-v1");
        let identity = checkpoint_identity_for_path(path.to_str().unwrap()).unwrap();
        assert_eq!(identity.len, 10);
        assert!(!identity.canonical_path.is_empty());
        assert!(identity.modified_ms > 0);

        // Same content, same file: identical fingerprint.
        let again = checkpoint_identity_for_path(path.to_str().unwrap()).unwrap();
        assert_eq!(identity, again);

        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn checkpoint_identity_changes_when_file_changes() {
        let path = temp_checkpoint("b.pth", b"weights-v1");
        let before = checkpoint_identity_for_path(path.to_str().unwrap()).unwrap();
        // Ensure mtime advances on filesystems with coarse granularity.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(&path, b"weights-v2-longer").unwrap();
        let after = checkpoint_identity_for_path(path.to_str().unwrap()).unwrap();
        assert_ne!(before, after);
        assert_ne!(before.len, after.len);
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn checkpoint_identity_rejects_missing_and_wrong_extension() {
        let missing =
            std::env::temp_dir().join(format!("rfdetr-missing-{}.pth", uuid::Uuid::new_v4()));
        assert!(checkpoint_identity_for_path(missing.to_str().unwrap()).is_err());

        let wrong = temp_checkpoint("c.pt", b"yolo");
        let error = checkpoint_identity_for_path(wrong.to_str().unwrap()).unwrap_err();
        assert!(error.contains(".pth"), "unexpected error: {}", error);
        std::fs::remove_file(&wrong).unwrap();
    }

    #[test]
    fn trusted_identity_mismatch_is_rejected() {
        let path = temp_checkpoint("d.pth", b"v1");
        let current = checkpoint_identity_for_path(path.to_str().unwrap()).unwrap();
        // Trust must be bound to the file identity: confirming without the
        // fingerprint cannot satisfy the binding.
        assert!(verify_trusted_identity(&current, None).is_err());
        assert!(verify_trusted_identity(&current, Some(&current)).is_ok());

        let stale = RfDetrCheckpointIdentity {
            canonical_path: current.canonical_path.clone(),
            len: current.len + 1,
            modified_ms: current.modified_ms,
        };
        let error = verify_trusted_identity(&current, Some(&stale)).unwrap_err();
        assert!(error.contains("changed since trust"));
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn inspection_reuses_first_healthy_stack_deterministically() {
        let runtime = temp_runtime();
        // Create two healthy stacks; deterministic order must prefer the
        // first known stack (rfdetr-default) regardless of creation order.
        make_stack_python(&runtime, "rfdetr-coreml");
        make_stack_python(&runtime, "rfdetr-default");
        let can_inspect = |_: &str| true;

        let (key, python) = resolve_inspection_stack(&runtime, None, &can_inspect).unwrap();
        assert_eq!(key, "rfdetr-default");
        assert!(python.contains("rfdetr-default"));
        assert!(!Path::new(
            &runtime
                .join("envs")
                .join("rfdetr-default")
                .join("created-by-inspect")
        )
        .exists());
        std::fs::remove_dir_all(&runtime).unwrap();
    }

    #[test]
    fn inspection_skips_broken_stacks_with_only_folder_or_metadata() {
        let runtime = temp_runtime();
        // Folder + interpreter exist but capability probe fails: must be
        // rejected even though the directory is present.
        make_stack_python(&runtime, "rfdetr-default");
        let healthy = make_stack_python(&runtime, "rfdetr-coreml");
        let can_inspect = |python: &str| python == healthy;

        let (key, python) = resolve_inspection_stack(&runtime, None, &can_inspect).unwrap();
        assert_eq!(key, "rfdetr-coreml");
        assert_eq!(python, healthy);
        std::fs::remove_dir_all(&runtime).unwrap();
    }

    #[test]
    fn requested_broken_stack_is_rejected_without_fallback() {
        let runtime = temp_runtime();
        make_stack_python(&runtime, "rfdetr-default");
        let can_inspect = |_: &str| false;

        let error =
            resolve_inspection_stack(&runtime, Some("rfdetr-default"), &can_inspect).unwrap_err();
        assert!(error.contains("rfdetr-default"));
        assert!(error.contains("before inspection"));
        std::fs::remove_dir_all(&runtime).unwrap();
    }

    #[test]
    fn no_healthy_stack_preserves_trust_guidance_without_creating_default() {
        let runtime = temp_runtime();
        let can_inspect = |_: &str| true;

        let error = resolve_inspection_stack(&runtime, None, &can_inspect).unwrap_err();
        assert!(error.contains("No healthy"));
        assert!(error.contains("Set up a route environment before inspection."));

        // Inspection must never create rfdetr-default merely because a
        // checkpoint was uploaded.
        assert!(!runtime.join("envs").join("rfdetr-default").exists());
        let _ = std::fs::remove_dir_all(&runtime);
    }

    #[test]
    fn arbitrary_python_path_is_rejected_as_unknown_stack() {
        let runtime = temp_runtime();
        let can_inspect = |_: &str| true;

        for arbitrary in [
            "/usr/bin/python3",
            "/tmp/runtime/.venv/bin/python",
            "python3",
        ] {
            let error =
                resolve_inspection_stack(&runtime, Some(arbitrary), &can_inspect).unwrap_err();
            assert!(
                error.contains("unknown RF-DETR stack"),
                "unexpected error for {}: {}",
                arbitrary,
                error
            );
        }
        let _ = std::fs::remove_dir_all(&runtime);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_stack_venv_is_not_eligible_for_inspection() {
        use std::os::unix::fs::symlink;
        let runtime = temp_runtime();
        // A real interpreter outside the app-owned tree, linked in as the
        // stack venv: inventory lists only non-symlink directories, and
        // inspection must apply the same rule instead of executing it.
        let outside = std::env::temp_dir().join(format!("rfdetr-outside-{}", uuid::Uuid::new_v4()));
        let outside_python = outside.join("bin").join("python");
        std::fs::create_dir_all(outside_python.parent().unwrap()).unwrap();
        std::fs::write(&outside_python, b"python").unwrap();
        let venv = stack_venv_dir_for_key(&runtime, "rfdetr-default").expect("known stack");
        std::fs::create_dir_all(venv.parent().unwrap()).unwrap();
        symlink(&outside, &venv).unwrap();
        let can_inspect = |_: &str| true;

        assert!(resolve_inspection_stack(&runtime, None, &can_inspect).is_err());
        let error =
            resolve_inspection_stack(&runtime, Some("rfdetr-default"), &can_inspect).unwrap_err();
        assert!(error.contains("not ready for inspection"));
        std::fs::remove_dir_all(&runtime).unwrap();
        std::fs::remove_dir_all(&outside).unwrap();
    }
}
