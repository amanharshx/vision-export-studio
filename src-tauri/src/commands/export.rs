use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};
use tauri::Emitter;
use uuid::Uuid;

use crate::commands::provider_registry::{
    validate_provider_route, validate_source_extension, ProviderId,
};
use crate::commands::providers::{self, ExportRequest};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct ExportState {
    pub sessions: Arc<Mutex<HashMap<String, Child>>>,
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
    provider_id: String,
    source_path: String,
    route_id: String,
    output_dir: String,
    yolo_path: String,
    python_path: String,
    imgsz: u32,
    batch: u32,
    half: bool,
    int8: bool,
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

    if !output_dir.is_empty() {
        if output_dir.contains('=') {
            return Err("output dir must not contain '='".to_string());
        }
        std::fs::create_dir_all(&output_dir)
            .map_err(|e| format!("failed to create output dir: {}", e))?;
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
    let request = ExportRequest {
        provider,
        source_path: source_path.clone(),
        route_id: route_id.clone(),
        output_dir: output_dir.clone(),
        yolo_path,
        python_path,
        imgsz,
        batch,
        half,
        int8,
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
    };
    let pre_snapshot: Option<Vec<crate::commands::providers::rfdetr::ArtifactFingerprint>> =
        if matches!(request.provider, ProviderId::RfDetr) {
            Some(
                providers::rfdetr::snapshot_rfdetr_artifacts(
                    &request.route_id,
                    &request.output_dir,
                )
                .map_err(|e| format!("failed to scan existing RF-DETR artifacts: {}", e))?,
            )
        } else {
            None
        };

    let mut cmd = providers::build_command(&request, &app_handle)?;
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn export process: {}", e))?;

    // Take handles BEFORE storing the child (moving child into sessions map
    // would make the handles inaccessible).
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "no stdout handle".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "no stderr handle".to_string())?;

    // Store the child in the session map.
    {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|e| format!("sessions lock poisoned: {}", e))?;
        sessions.insert(session_id.clone(), child);
    }

    // ------------------------------------------------------------------
    // Streaming threads
    // ------------------------------------------------------------------
    let sessions_arc = Arc::clone(&state.sessions);

    // stdout reader thread
    let ah_stdout = app_handle.clone();
    let sid_stdout = session_id.clone();
    let stdout_handle = std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(l) => {
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
    let stderr_handle = std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            match line {
                Ok(l) => {
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
    std::thread::spawn(move || {
        // Wait for both stream readers to finish.
        let _ = stdout_handle.join();
        let _ = stderr_handle.join();

        // Retrieve and wait on the child process.
        let child_opt = {
            let mut sessions = match sessions_arc.lock() {
                Ok(s) => s,
                Err(_) => {
                    let _ = ah_wait.emit(
                        "export:failed",
                        ExportFailedPayload {
                            session_id: sid_wait.clone(),
                            error: "sessions lock poisoned during wait".to_string(),
                        },
                    );
                    return;
                }
            };
            sessions.remove(&sid_wait)
        };

        match child_opt {
            None => {}
            Some(mut child) => match child.wait() {
                Ok(status) => {
                    if status.success() {
                        let artifact_status = match &pre_snapshot_wait {
                            Some(ref before) => providers::rfdetr::confirm_artifacts_with_snapshot(
                                &request_wait,
                                before,
                            ),
                            None => providers::confirm_artifacts(&request_wait),
                        };
                        let _ = ah_wait.emit(
                            "export:finished",
                            ExportFinishedPayload {
                                session_id: sid_wait,
                                exit_code: 0,
                                artifact_moved: artifact_status.artifact_moved,
                                artifact_warning: artifact_status.artifact_warning,
                                output_dir: if request_wait.output_dir.is_empty() {
                                    None
                                } else {
                                    Some(request_wait.output_dir.clone())
                                },
                            },
                        );
                    } else {
                        let code = status.code().unwrap_or(-1);
                        let _ = ah_wait.emit(
                            "export:failed",
                            ExportFailedPayload {
                                session_id: sid_wait,
                                error: format!("exit code: {}", code),
                            },
                        );
                    }
                }
                Err(e) => {
                    let _ = ah_wait.emit(
                        "export:failed",
                        ExportFailedPayload {
                            session_id: sid_wait,
                            error: format!("wait error: {}", e),
                        },
                    );
                }
            },
        }
    });

    Ok(session_id)
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
    // Acquire lock, remove the child atomically.
    let child_opt = {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|e| format!("sessions lock poisoned: {}", e))?;
        sessions.remove(&session_id)
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
            let _ = child.wait();
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
