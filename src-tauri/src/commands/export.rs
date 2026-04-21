use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::Emitter;
use uuid::Uuid;

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
    dynamic: bool,
    simplify: bool,
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

    if route_id != "ultralytics.pt.onnx" {
        return Err(format!("route not supported in this build: {}", route_id));
    }

    if yolo_path.is_empty() || !Path::new(&yolo_path).exists() {
        return Err(format!("yolo not found at: {}", yolo_path));
    }

    if !output_dir.is_empty() {
        if output_dir.contains('=') {
            return Err("output dir must not contain '='".to_string());
        }
        if !Path::new(&output_dir).exists() {
            return Err(format!("output dir does not exist: {}", output_dir));
        }
    }

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
    cmd.arg("format=onnx");
    cmd.arg(format!("imgsz={}", imgsz));
    cmd.arg(format!("batch={}", batch));
    if half {
        cmd.arg("half=True");
    }
    if dynamic {
        cmd.arg("dynamic=True");
    }
    if simplify {
        cmd.arg("simplify=True");
    }
    if !output_dir.is_empty() {
        cmd.arg(format!("project={}", output_dir));
    }
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
                        let _ = ah_wait.emit(
                            "export:finished",
                            ExportFinishedPayload {
                                session_id: sid_wait,
                                exit_code: 0,
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
