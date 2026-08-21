use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};
use tauri::Emitter;
use uuid::Uuid;

use crate::commands::artifacts::publish_artifacts;
use crate::commands::provider_registry::{
    current_host_context, validate_provider_route, validate_route_platform,
    validate_source_extension, ProviderId,
};
use crate::commands::providers::{self, ExportRequest};
use crate::commands::runtime_operations::{
    emit_after_operation_released, RuntimeOperation, RuntimeOperationCoordinator,
};
use crate::commands::setup::load_settings;
use crate::commands::stack_environments::stack_python;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct ExportState {
    pub sessions: Arc<Mutex<HashMap<String, Child>>>,
    pub staging_dirs: Arc<Mutex<HashMap<String, String>>>,
}

// ---------------------------------------------------------------------------
// Event payload types
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, Clone)]
struct ExportLinePayload {
    session_id: String,
    line: String,
}

#[derive(serde::Serialize, Clone)]
struct ExportFinishedPayload {
    session_id: String,
    exit_code: i32,
    artifact_moved: bool,
    artifact_warning: Option<String>,
    output_dir: Option<String>,
    published_paths: Vec<String>,
    run: u32,
    artifact_count: usize,
}

#[derive(serde::Serialize, Clone)]
struct ExportFailedPayload {
    session_id: String,
    error: String,
}

#[derive(serde::Serialize, Clone)]
struct ExportCancelledPayload {
    session_id: String,
}

// ---------------------------------------------------------------------------
// start_export
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn start_export(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, ExportState>,
    runtime_operations: tauri::State<'_, RuntimeOperationCoordinator>,
    provider_id: String,
    source_path: String,
    route_id: String,
    output_dir: String,
    yolo_path: String,
    python_path: String,
    imgsz: u32,
    batch: u32,
    precision: String,
    calibration_data: Option<String>,
    dynamic: bool,
    simplify: bool,
    optimize: bool,
    nms: bool,
    end_to_end: bool,
    keras: bool,
    opset: Option<u32>,
    workspace: Option<u32>,
    chip: String,
    rfdetr_trust_confirmed: bool,
    rfdetr_variant_mode: Option<String>,
    rfdetr_manual_class_symbol: Option<String>,
) -> Result<String, String> {
    // ------------------------------------------------------------------
    // Validation
    // ------------------------------------------------------------------
    if !Path::new(&source_path).exists() {
        return Err(format!("source path does not exist: {}", source_path));
    }

    if source_path.contains('=') {
        return Err("source path must not contain '='".to_string());
    }

    let provider = validate_provider_route(&provider_id, &route_id)?;
    validate_source_extension(provider, &source_path)?;
    validate_route_platform(&route_id, current_host_context())?;
    let export_python = if provider == ProviderId::RfDetr {
        let settings = load_settings(app_handle.clone())?;
        resolve_export_python(&route_id, &python_path, &settings.runtime_dir)?
    } else {
        python_path
    };

    if !output_dir.is_empty() {
        if output_dir.contains('=') {
            return Err("output dir must not contain '='".to_string());
        }
        if route_id != "rfdetr.pth.tflite" {
            std::fs::create_dir_all(&output_dir)
                .map_err(|e| format!("failed to create output dir: {}", e))?;
        }
    }

    // IMX500 only supports YOLOv8n and YOLO11n (nano) models.
    if route_id == "ultralytics.pt.imx" {
        let basename = Path::new(&source_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();
        if !basename.starts_with("yolov8n") && !basename.starts_with("yolo11n") {
            return Err(
                "IMX500 export only supports YOLOv8n and YOLO11n (nano) models. \
                 Other architectures or sizes will fail during export."
                    .to_string(),
            );
        }
    }

    // ------------------------------------------------------------------
    // Assign session id
    // ------------------------------------------------------------------
    let session_id = Uuid::new_v4().to_string();

    // ------------------------------------------------------------------
    // Build and spawn child process
    // ------------------------------------------------------------------
    let mut request = ExportRequest {
        provider,
        source_path: source_path.clone(),
        route_id: route_id.clone(),
        output_dir: output_dir.clone(),
        yolo_path,
        python_path: export_python,
        imgsz,
        batch,
        precision: precision.trim().to_string(),
        calibration_data: calibration_data
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        dynamic,
        simplify,
        optimize,
        nms,
        end_to_end,
        keras,
        opset,
        workspace,
        chip,
        rfdetr_trust_confirmed,
        rfdetr_variant_mode,
        rfdetr_manual_class_symbol,
        staging_dir: None,
    };
    let pre_snapshot = if request.provider == ProviderId::Ultralytics {
        if !request.output_dir.is_empty() {
            providers::ultralytics::validate_output_destination(
                Path::new(&request.source_path),
                Path::new(&request.output_dir),
            )?;
        }
        Some(providers::ultralytics::snapshot_outputs(&request)?)
    } else {
        None
    };
    if request.provider == ProviderId::RfDetr {
        let settings = load_settings(app_handle.clone())?;
        let staging = providers::rfdetr::create_rfdetr_staging_dir(
            Path::new(&settings.runtime_dir),
            &session_id,
        )?;
        request.staging_dir = Some(staging.to_string_lossy().into_owned());
    }
    let operation_guard = match runtime_operations.acquire(RuntimeOperation::Export) {
        Ok(guard) => guard,
        Err(error) => {
            cleanup_staging(request.staging_dir.as_deref());
            return Err(error);
        }
    };

    let mut cmd = match providers::build_command(&request, &app_handle) {
        Ok(command) => command,
        Err(error) => {
            cleanup_staging(request.staging_dir.as_deref());
            return Err(error);
        }
    };
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(error) => {
            cleanup_staging(request.staging_dir.as_deref());
            return Err(format!("failed to spawn export process: {}", error));
        }
    };

    // Take handles BEFORE storing the child (moving child into sessions map
    // would make the handles inaccessible).
    let stdout = child.stdout.take().ok_or_else(|| {
        cleanup_staging(request.staging_dir.as_deref());
        "no stdout handle".to_string()
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        cleanup_staging(request.staging_dir.as_deref());
        "no stderr handle".to_string()
    })?;

    // Store the child in the session map.
    {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|e| format!("sessions lock poisoned: {}", e))?;
        sessions.insert(session_id.clone(), child);
    }
    if let Some(staging_dir) = request.staging_dir.as_deref() {
        let mut staging_dirs = state
            .staging_dirs
            .lock()
            .map_err(|e| format!("staging dirs lock poisoned: {}", e))?;
        staging_dirs.insert(session_id.clone(), staging_dir.to_string());
    }

    // ------------------------------------------------------------------
    // Streaming threads
    // ------------------------------------------------------------------
    let sessions_arc = Arc::clone(&state.sessions);
    let staging_dirs_arc = Arc::clone(&state.staging_dirs);
    let export_output = Arc::new(Mutex::new(String::new()));

    // stdout reader thread
    let ah_stdout = app_handle.clone();
    let sid_stdout = session_id.clone();
    let output_stdout = Arc::clone(&export_output);
    let stdout_handle = std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(l) => {
                    if let Ok(mut output) = output_stdout.lock() {
                        output.push_str(&l);
                        output.push('\n');
                    }
                    let _ = ah_stdout.emit(
                        "export:stdout",
                        ExportLinePayload {
                            session_id: sid_stdout.clone(),
                            line: l,
                        },
                    );
                }
                Err(_) => break,
            }
        }
    });

    // stderr reader thread
    let ah_stderr = app_handle.clone();
    let sid_stderr = session_id.clone();
    let output_stderr = Arc::clone(&export_output);
    let stderr_handle = std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            match line {
                Ok(l) => {
                    if let Ok(mut output) = output_stderr.lock() {
                        output.push_str(&l);
                        output.push('\n');
                    }
                    let _ = ah_stderr.emit(
                        "export:stderr",
                        ExportLinePayload {
                            session_id: sid_stderr.clone(),
                            line: l,
                        },
                    );
                }
                Err(_) => break,
            }
        }
    });

    // waiter thread — joins both readers, then waits for the child process
    let ah_wait = app_handle.clone();
    let sid_wait = session_id.clone();
    let request_wait = request.clone();
    let pre_snapshot_wait = pre_snapshot.clone();
    let export_output_wait = Arc::clone(&export_output);
    std::thread::spawn(move || {
        let mut operation_guard = Some(operation_guard);
        // Wait for both stream readers to finish.
        let _ = stdout_handle.join();
        let _ = stderr_handle.join();

        // Retrieve and wait on the child process.
        let child_opt = {
            let mut sessions = match sessions_arc.lock() {
                Ok(s) => s,
                Err(_) => {
                    cleanup_staging(request_wait.staging_dir.as_deref());
                    emit_after_operation_released(operation_guard.take().unwrap(), || {
                        let _ = ah_wait.emit(
                            "export:failed",
                            ExportFailedPayload {
                                session_id: sid_wait.clone(),
                                error: "sessions lock poisoned during wait".to_string(),
                            },
                        );
                    });
                    return;
                }
            };
            sessions.remove(&sid_wait)
        };

        match child_opt {
            None => cleanup_session_staging(
                &staging_dirs_arc,
                &sid_wait,
                request_wait.staging_dir.as_deref(),
            ),
            Some(mut child) => match wait_for_export_child(
                &mut child,
                &staging_dirs_arc,
                &sid_wait,
                request_wait.staging_dir.as_deref(),
                false,
            ) {
                Ok(status) => {
                    if status.success() {
                        let published = if request_wait.provider == ProviderId::RfDetr {
                            let descriptors =
                                match providers::rfdetr::discover_staged_artifacts(&request_wait) {
                                    Ok(descriptors) => descriptors,
                                    Err(error) => {
                                        cleanup_session_staging(
                                            &staging_dirs_arc,
                                            &sid_wait,
                                            request_wait.staging_dir.as_deref(),
                                        );
                                        emit_after_operation_released(
                                            operation_guard.take().unwrap(),
                                            || {
                                                let _ = ah_wait.emit(
                                                    "export:failed",
                                                    ExportFailedPayload {
                                                        session_id: sid_wait.clone(),
                                                        error,
                                                    },
                                                );
                                            },
                                        );
                                        return;
                                    }
                                };
                            match publish_artifacts(
                                Path::new(&request_wait.source_path),
                                Path::new(&request_wait.output_dir),
                                &descriptors,
                            ) {
                                Ok(publication) => Some(publication),
                                Err(error) => {
                                    cleanup_session_staging(
                                        &staging_dirs_arc,
                                        &sid_wait,
                                        request_wait.staging_dir.as_deref(),
                                    );
                                    emit_after_operation_released(
                                        operation_guard.take().unwrap(),
                                        || {
                                            let _ = ah_wait.emit(
                                                "export:failed",
                                                ExportFailedPayload {
                                                    session_id: sid_wait.clone(),
                                                    error,
                                                },
                                            );
                                        },
                                    );
                                    return;
                                }
                            }
                        } else {
                            let before = pre_snapshot_wait.as_deref().unwrap_or(&[]);
                            let evidence = export_output_wait
                                .lock()
                                .map(|output| output.clone())
                                .unwrap_or_default();
                            let descriptors =
                                match providers::ultralytics::discover_artifacts_with_evidence(
                                    &request_wait,
                                    before,
                                    Some(&evidence),
                                ) {
                                    Ok(descriptors) => descriptors,
                                    Err(error) => {
                                        emit_after_operation_released(
                                            operation_guard.take().unwrap(),
                                            || {
                                                let _ = ah_wait.emit(
                                                    "export:failed",
                                                    ExportFailedPayload {
                                                        session_id: sid_wait.clone(),
                                                        error,
                                                    },
                                                );
                                            },
                                        );
                                        return;
                                    }
                                };
                            match publish_artifacts(
                                Path::new(&request_wait.source_path),
                                Path::new(&request_wait.output_dir),
                                &descriptors,
                            ) {
                                Ok(publication) => Some(publication),
                                Err(error) => {
                                    emit_after_operation_released(
                                        operation_guard.take().unwrap(),
                                        || {
                                            let _ = ah_wait.emit(
                                                "export:failed",
                                                ExportFailedPayload {
                                                    session_id: sid_wait.clone(),
                                                    error,
                                                },
                                            );
                                        },
                                    );
                                    return;
                                }
                            }
                        };
                        if request_wait.provider == ProviderId::RfDetr {
                            cleanup_session_staging(
                                &staging_dirs_arc,
                                &sid_wait,
                                request_wait.staging_dir.as_deref(),
                            );
                        }
                        emit_after_operation_released(operation_guard.take().unwrap(), || {
                            let _ = ah_wait.emit(
                                "export:finished",
                                ExportFinishedPayload {
                                    session_id: sid_wait,
                                    exit_code: 0,
                                    artifact_moved: published.is_some(),
                                    artifact_warning: None,
                                    output_dir: if request_wait.output_dir.is_empty() {
                                        None
                                    } else {
                                        Some(request_wait.output_dir.clone())
                                    },
                                    published_paths: published
                                        .as_ref()
                                        .map(|publication| {
                                            publication
                                                .paths
                                                .iter()
                                                .map(|path| path.to_string_lossy().into_owned())
                                                .collect()
                                        })
                                        .unwrap_or_default(),
                                    run: published
                                        .as_ref()
                                        .map(|publication| publication.run)
                                        .unwrap_or(0),
                                    artifact_count: published
                                        .as_ref()
                                        .map(|publication| publication.paths.len())
                                        .unwrap_or(0),
                                },
                            );
                        });
                    } else {
                        let code = status.code().unwrap_or(-1);
                        emit_after_operation_released(operation_guard.take().unwrap(), || {
                            let _ = ah_wait.emit(
                                "export:failed",
                                ExportFailedPayload {
                                    session_id: sid_wait,
                                    error: format!("exit code: {}", code),
                                },
                            );
                        });
                    }
                }
                Err(e) => {
                    emit_after_operation_released(operation_guard.take().unwrap(), || {
                        let _ = ah_wait.emit(
                            "export:failed",
                            ExportFailedPayload {
                                session_id: sid_wait,
                                error: format!("wait error: {}", e),
                            },
                        );
                    });
                }
            },
        }
    });

    Ok(session_id)
}

fn cleanup_staging(staging_dir: Option<&str>) {
    if let Some(path) = staging_dir {
        let _ = std::fs::remove_dir_all(path);
    }
}

fn take_session_staging(
    staging_dirs: &Mutex<HashMap<String, String>>,
    session_id: &str,
) -> Option<String> {
    staging_dirs.lock().ok()?.remove(session_id)
}

fn cleanup_session_staging(
    staging_dirs: &Mutex<HashMap<String, String>>,
    session_id: &str,
    fallback: Option<&str>,
) {
    let tracked = take_session_staging(staging_dirs, session_id);
    cleanup_staging(tracked.as_deref().or(fallback));
}

fn wait_for_export_child(
    child: &mut Child,
    staging_dirs: &Mutex<HashMap<String, String>>,
    session_id: &str,
    fallback: Option<&str>,
    cleanup_on_success: bool,
) -> std::io::Result<std::process::ExitStatus> {
    let result = child.wait();
    if cleanup_on_success || !matches!(&result, Ok(status) if status.success()) {
        cleanup_session_staging(staging_dirs, session_id, fallback);
    }
    result
}

fn resolve_export_python(
    route_id: &str,
    base_python: &str,
    runtime_dir: &str,
) -> Result<String, String> {
    let Some(stack_python) = stack_python(runtime_dir, route_id) else {
        return Ok(base_python.to_string());
    };
    if !Path::new(&stack_python).exists() {
        return Err(
            "RF-DETR environment is missing. Install route dependencies before exporting."
                .to_string(),
        );
    }
    Ok(stack_python)
}

// ---------------------------------------------------------------------------
// cancel_export
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn cancel_export(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, ExportState>,
    session_id: String,
) -> Result<bool, String> {
    if !cancel_export_session(&state, &session_id)? {
        return Ok(false);
    }
    app_handle
        .emit(
            "export:cancelled",
            ExportCancelledPayload {
                session_id: session_id.clone(),
            },
        )
        .map_err(|e| format!("emit error: {}", e))?;
    Ok(true)
}

fn cancel_export_session(state: &ExportState, session_id: &str) -> Result<bool, String> {
    // Acquire lock, remove the child atomically.
    let child_opt = {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|e| format!("sessions lock poisoned: {}", e))?;
        sessions.remove(session_id)
    };
    match child_opt {
        None => {
            // Session not found — either already finished or unknown id.
            // Do not emit; the waiter thread owns the terminal event in this case.
            Ok(false)
        }
        Some(mut child) => {
            // process is gone from registry regardless of kill result
            // (succeeds: terminated; fails: already exited — goal satisfied either way)
            let _ = child.kill();
            // reap zombie; ignore wait errors (process may already be dead)
            let _ = wait_for_export_child(&mut child, &state.staging_dirs, session_id, None, true);
            Ok(true)
        }
    }
}

#[tauri::command]
pub async fn open_export_folder(path: String) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("export folder path is empty".to_string());
    }

    let folder = Path::new(trimmed);
    if !folder.exists() {
        return Err(format!("export folder does not exist: {}", trimmed));
    }
    if !folder.is_dir() {
        return Err(format!("export folder is not a directory: {}", trimmed));
    }

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut cmd = std::process::Command::new("open");
        cmd.arg(folder);
        cmd
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut cmd = std::process::Command::new("explorer");
        cmd.arg(folder);
        cmd
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut cmd = std::process::Command::new("xdg-open");
        cmd.arg(folder);
        cmd
    };

    command
        .spawn()
        .map_err(|e| format!("failed to open export folder: {}", e))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::stack_environments::stack_python;

    const TEST_CHILD_MODE: &str = "VISION_EXPORT_STUDIO_TEST_CHILD_MODE";

    fn spawn_test_child(mode: &str) -> Child {
        let mut command = std::process::Command::new(
            std::env::current_exe().expect("resolve current Rust test executable"),
        );
        command
            .arg("--exact")
            .arg("commands::export::tests::export_lifecycle_test_child")
            .arg("--nocapture")
            .env(TEST_CHILD_MODE, mode)
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command.spawn().expect("spawn lifecycle test child")
    }

    #[test]
    fn export_lifecycle_test_child() {
        match std::env::var(TEST_CHILD_MODE).as_deref() {
            Ok("fail") => std::process::exit(23),
            Ok("sleep") => std::thread::sleep(std::time::Duration::from_secs(30)),
            _ => {}
        }
    }

    #[test]
    fn rfdetr_export_uses_existing_stack_python() {
        let runtime = std::env::temp_dir().join(format!("rfdetr-export-{}", Uuid::new_v4()));
        let runtime = runtime.to_string_lossy().into_owned();
        let stack = stack_python(&runtime, "rfdetr.pth.onnx").unwrap();
        std::fs::create_dir_all(Path::new(&stack).parent().unwrap()).unwrap();
        std::fs::write(&stack, b"python").unwrap();

        assert_eq!(
            resolve_export_python("rfdetr.pth.onnx", "/base/python", &runtime).unwrap(),
            stack
        );

        std::fs::remove_dir_all(runtime).unwrap();
    }

    #[test]
    fn missing_rfdetr_stack_blocks_export() {
        let runtime = std::env::temp_dir().join(format!("rfdetr-export-{}", Uuid::new_v4()));
        let error =
            resolve_export_python("rfdetr.pth.onnx", "/base/python", runtime.to_str().unwrap())
                .unwrap_err();

        assert!(error.contains("RF-DETR environment is missing"));
    }

    #[test]
    fn ultralytics_export_keeps_base_python() {
        assert_eq!(
            resolve_export_python("ultralytics.pt.onnx", "/base/python", "/unused").unwrap(),
            "/base/python"
        );
    }

    #[test]
    fn tflite_staging_cleanup_removes_session_directory() {
        let path = std::env::temp_dir().join(format!("rfdetr-cleanup-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("create staging");
        let staging_dirs = Mutex::new(HashMap::from([(
            "session".to_string(),
            path.to_string_lossy().into_owned(),
        )]));
        cleanup_session_staging(&staging_dirs, "session", None);
        assert!(!path.exists());
        assert!(staging_dirs.lock().unwrap().is_empty());
    }

    #[test]
    fn failed_waiter_removes_tracked_session_staging() {
        let path = std::env::temp_dir().join(format!("rfdetr-failed-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("create staging");
        let staging_dirs = Mutex::new(HashMap::from([(
            "failed".to_string(),
            path.to_string_lossy().into_owned(),
        )]));
        let mut child = spawn_test_child("fail");

        let status = wait_for_export_child(&mut child, &staging_dirs, "failed", None, false)
            .expect("wait for failed child");

        assert!(!status.success());
        assert!(!path.exists());
        assert!(staging_dirs.lock().unwrap().is_empty());
    }

    #[test]
    fn cancel_export_removes_tracked_session_staging() {
        let path = std::env::temp_dir().join(format!("rfdetr-cancelled-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("create staging");
        let state = ExportState::default();
        state
            .sessions
            .lock()
            .unwrap()
            .insert("cancelled".to_string(), spawn_test_child("sleep"));
        state
            .staging_dirs
            .lock()
            .unwrap()
            .insert("cancelled".to_string(), path.to_string_lossy().into_owned());

        let cancelled = cancel_export_session(&state, "cancelled").expect("cancel export");

        assert!(cancelled);
        assert!(!path.exists());
        assert!(state.sessions.lock().unwrap().is_empty());
        assert!(state.staging_dirs.lock().unwrap().is_empty());
    }
}
