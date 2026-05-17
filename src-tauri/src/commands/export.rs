use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::Emitter;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Artifact helpers
// ---------------------------------------------------------------------------

/// Returns (suffix, is_directory) for each yolo format's output artifact.
/// Suffix is appended to the model stem (e.g. "best" + ".onnx").
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

/// After a successful export, move the artifact from next to the source model
/// into output_dir. Returns:
/// - Ok(true): artifact moved
/// - Ok(false): no known artifact found to move
/// - Err(...): artifact move attempted but failed
fn move_artifact(source_path: &str, format: &str, output_dir: &str) -> Result<bool, String> {
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
    } else {
        // Try atomic rename first (same filesystem); fall back to copy+delete.
        if let Err(rename_error) = std::fs::rename(&artifact_src, &artifact_dst) {
            std::fs::copy(&artifact_src, &artifact_dst).map_err(|copy_error| {
                format!(
                    "failed to move artifact: rename error: {}; copy fallback error: {}",
                    rename_error, copy_error
                )
            })?;
            std::fs::remove_file(&artifact_src)
                .map_err(|e| format!("failed to remove source artifact file: {}", e))?;
        }
    }

    Ok(true)
}

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
    source_path: String,
    route_id: String,
    output_dir: String,
    yolo_path: String,
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

    const VALID_ROUTE_IDS: &[&str] = &[
        "ultralytics.pt.torchscript",
        "ultralytics.pt.onnx",
        "ultralytics.pt.openvino",
        "ultralytics.pt.coreml",
        "ultralytics.pt.ncnn",
        "ultralytics.pt.mnn",
        "ultralytics.pt.tflite",
        "ultralytics.pt.engine",
        "ultralytics.pt.rknn",
        "ultralytics.pt.executorch",
        "ultralytics.pt.edgetpu",
        "ultralytics.pt.tfjs",
        "ultralytics.pt.paddle",
        "ultralytics.pt.imx",
        "ultralytics.pt.axelera",
        "ultralytics.pt.saved_model",
        "ultralytics.pt.pb",
    ];

    if !VALID_ROUTE_IDS.contains(&route_id.as_str()) {
        return Err(format!("route not supported in this build: {}", route_id));
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

    let yolo_format = route_id
        .strip_prefix("ultralytics.pt.")
        .expect("route_id prefix validated above")
        .to_string();

    if yolo_path.is_empty() || !Path::new(&yolo_path).exists() {
        return Err(format!("yolo not found at: {}", yolo_path));
    }

    if !output_dir.is_empty() {
        if output_dir.contains('=') {
            return Err("output dir must not contain '='".to_string());
        }
        std::fs::create_dir_all(&output_dir)
            .map_err(|e| format!("failed to create output dir: {}", e))?;
    }

    let output_dir_for_move = output_dir.clone();
    let source_path_for_move = source_path.clone();
    let yolo_format_for_move = yolo_format.clone();

    // ------------------------------------------------------------------
    // Assign session id
    // ------------------------------------------------------------------
    let session_id = Uuid::new_v4().to_string();

    // ------------------------------------------------------------------
    // Build and spawn child process
    // ------------------------------------------------------------------
    let mut cmd = Command::new(&yolo_path);
    cmd.arg("export");
    cmd.arg(format!("model={}", source_path));
    cmd.arg(format!("format={}", yolo_format));
    cmd.arg(format!("imgsz={}", imgsz));
    cmd.arg(format!("batch={}", batch));
    if half {
        cmd.arg("half=True");
    }
    if int8 {
        cmd.arg("int8=True");
    }
    if dynamic {
        cmd.arg("dynamic=True");
    }
    if simplify {
        cmd.arg("simplify=True");
    }
    if optimize {
        cmd.arg("optimize=True");
    }
    if nms {
        cmd.arg("nms=True");
    }
    if end_to_end {
        cmd.arg("end2end=True");
    }
    if keras {
        cmd.arg("keras=True");
    }
    if let Some(v) = opset {
        cmd.arg(format!("opset={}", v));
    }
    if let Some(v) = workspace {
        cmd.arg(format!("workspace={}", v));
    }
    if route_id == "ultralytics.pt.rknn" && !chip.trim().is_empty() {
        cmd.arg(format!("name={}", chip.trim()));
    }
    // output_dir is handled post-export via move_artifact (project= is not
    // honoured by `yolo export` for artifact placement)
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn yolo: {}", e))?;

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
    let output_dir_wait = output_dir_for_move;
    let source_path_wait = source_path_for_move;
    let yolo_format_wait = yolo_format_for_move;
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
            None => {
                // Child was already removed (cancelled). Nothing to emit — cancel
                // path already emitted export:cancelled.
            }
            Some(mut child) => match child.wait() {
                Ok(status) => {
                    if status.success() {
                        let (artifact_moved, artifact_warning) = if output_dir_wait.is_empty() {
                            (false, None)
                        } else {
                            match move_artifact(
                                &source_path_wait,
                                &yolo_format_wait,
                                &output_dir_wait,
                            ) {
                                Ok(true) => (true, None),
                                Ok(false) => (
                                    false,
                                    Some(format!(
                                        "Export finished, but artifact was not moved to {}. \
                                         Output may still be next to source model.",
                                        output_dir_wait
                                    )),
                                ),
                                Err(error) => (
                                    false,
                                    Some(format!(
                                        "Export finished, but artifact move to {} failed: {}",
                                        output_dir_wait, error
                                    )),
                                ),
                            }
                        };

                        let _ = ah_wait.emit(
                            "export:finished",
                            ExportFinishedPayload {
                                session_id: sid_wait,
                                exit_code: 0,
                                artifact_moved,
                                artifact_warning,
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
