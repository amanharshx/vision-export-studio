use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::Emitter;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct ExportState {
    pub sessions: Arc<Mutex<HashMap<u64, Child>>>,
    pub counter: Arc<Mutex<u64>>,
}

// ---------------------------------------------------------------------------
// Event payload types
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, Clone)]
struct ExportStartedPayload {
    session_id: u64,
}

#[derive(serde::Serialize, Clone)]
struct ExportLinePayload {
    session_id: u64,
    line: String,
}

#[derive(serde::Serialize, Clone)]
struct ExportFinishedPayload {
    session_id: u64,
    exit_code: i32,
}

#[derive(serde::Serialize, Clone)]
struct ExportFailedPayload {
    session_id: u64,
    error: String,
}

#[derive(serde::Serialize, Clone)]
struct ExportCancelledPayload {
    session_id: u64,
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
) -> Result<u64, String> {
    // ------------------------------------------------------------------
    // Validation
    // ------------------------------------------------------------------
    if !Path::new(&source_path).exists() {
        return Err(format!("source path does not exist: {}", source_path));
    }

    if route_id != "ultralytics.pt.onnx" {
        return Err(format!("route not supported in this build: {}", route_id));
    }

    if yolo_path.is_empty() || !Path::new(&yolo_path).exists() {
        return Err(format!("yolo not found at: {}", yolo_path));
    }

    // ------------------------------------------------------------------
    // Assign session id
    // ------------------------------------------------------------------
    let session_id = {
        let mut counter = state
            .counter
            .lock()
            .map_err(|e| format!("counter lock poisoned: {}", e))?;
        *counter += 1;
        *counter
    };

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
        sessions.insert(session_id, child);
    }

    // Emit started event.
    app_handle
        .emit("export:started", ExportStartedPayload { session_id })
        .map_err(|e| format!("emit error: {}", e))?;

    // ------------------------------------------------------------------
    // Streaming threads
    // ------------------------------------------------------------------
    let sessions_arc = Arc::clone(&state.sessions);

    // stdout reader thread
    let ah_stdout = app_handle.clone();
    let stdout_handle = std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(l) => {
                    let _ = ah_stdout.emit(
                        "export:stdout",
                        ExportLinePayload {
                            session_id,
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
    let stderr_handle = std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            match line {
                Ok(l) => {
                    let _ = ah_stderr.emit(
                        "export:stderr",
                        ExportLinePayload {
                            session_id,
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
                            session_id,
                            error: "sessions lock poisoned during wait".to_string(),
                        },
                    );
                    return;
                }
            };
            sessions.remove(&session_id)
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
                                session_id,
                                exit_code: 0,
                            },
                        );
                    } else {
                        let code = status.code().unwrap_or(-1);
                        let _ = ah_wait.emit(
                            "export:failed",
                            ExportFailedPayload {
                                session_id,
                                error: format!("exit code: {}", code),
                            },
                        );
                    }
                }
                Err(e) => {
                    let _ = ah_wait.emit(
                        "export:failed",
                        ExportFailedPayload {
                            session_id,
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
    session_id: u64,
) -> Result<bool, String> {
    // Emit cancelled before killing so the frontend can transition state
    // immediately rather than waiting for the process to die.
    app_handle
        .emit("export:cancelled", ExportCancelledPayload { session_id })
        .map_err(|e| format!("emit error: {}", e))?;

    let mut sessions = state
        .sessions
        .lock()
        .map_err(|e| format!("sessions lock poisoned: {}", e))?;

    match sessions.get_mut(&session_id) {
        Some(child) => {
            child.kill().map_err(|e| format!("kill failed: {}", e))?;
            sessions.remove(&session_id);
            Ok(true)
        }
        None => Ok(false),
    }
}
