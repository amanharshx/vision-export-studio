use crate::commands::environment::resolve_python;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::Emitter;
// Manager trait provides app_handle.path().
use tauri::Manager;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct SetupState {
    pub sessions: Arc<Mutex<HashMap<String, Child>>>,
}

#[derive(Default)]
pub struct SettingsState {
    lock: Mutex<()>,
}

fn update_settings<F>(
    app_handle: &tauri::AppHandle,
    state: &SettingsState,
    f: F,
) -> Result<(), String>
where
    F: FnOnce(&mut AppSettings),
{
    let _guard = state
        .lock
        .lock()
        .map_err(|_| "settings lock poisoned".to_string())?;
    let mut settings = load_settings(app_handle.clone())?;
    f(&mut settings);
    let path = settings_path(app_handle)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create settings dir: {}", e))?;
    }
    let json = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("failed to serialize settings: {}", e))?;
    std::fs::write(&path, json).map_err(|e| format!("failed to write settings: {}", e))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Settings struct
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct AppSettings {
    pub runtime_dir: String,
    pub setup_complete: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub python_path_override: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub output_dir_override: Option<String>,
}

// ---------------------------------------------------------------------------
// Event payload types
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, Clone)]
struct SetupLinePayload {
    session_id: String,
    line: String,
}

#[derive(serde::Serialize, Clone)]
struct SetupFinishedPayload {
    session_id: String,
}

#[derive(serde::Serialize, Clone)]
struct SetupFailedPayload {
    session_id: String,
    error: String,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn settings_path(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {}", e))?;
    Ok(data_dir.join("yolo-export-studio-settings.json"))
}

fn default_runtime_dir(app_handle: &tauri::AppHandle) -> Result<String, String> {
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {}", e))?;
    Ok(data_dir.join("runtime").to_string_lossy().into_owned())
}

fn venv_python(runtime_dir: &str) -> String {
    #[cfg(windows)]
    {
        format!("{}/.venv/Scripts/python.exe", runtime_dir)
    }
    #[cfg(not(windows))]
    {
        format!("{}/.venv/bin/python", runtime_dir)
    }
}

fn validate_runtime_dir(runtime_dir: &str) -> Result<(), String> {
    if runtime_dir.is_empty() {
        return Err("runtime_dir must not be empty".to_string());
    }
    if runtime_dir.contains('=') {
        return Err("runtime_dir must not contain '='".to_string());
    }
    Ok(())
}

/// Spawn a child process, stream its stdout/stderr as Tauri events, and emit
/// `setup:finished` or `setup:failed` when it exits.  Returns the session id.
fn spawn_and_stream(
    app_handle: tauri::AppHandle,
    sessions: Arc<Mutex<HashMap<String, Child>>>,
    mut cmd: Command,
) -> Result<String, String> {
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn process: {}", e))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "no stdout handle".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "no stderr handle".to_string())?;

    let session_id = Uuid::new_v4().to_string();

    {
        let mut map = sessions
            .lock()
            .map_err(|e| format!("sessions lock poisoned: {}", e))?;
        map.insert(session_id.clone(), child);
    }

    // stdout reader thread
    let ah_out = app_handle.clone();
    let sid_out = session_id.clone();
    let stdout_handle = std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(l) => {
                    let _ = ah_out.emit(
                        "setup:stdout",
                        SetupLinePayload {
                            session_id: sid_out.clone(),
                            line: l,
                        },
                    );
                }
                Err(_) => break,
            }
        }
    });

    // stderr reader thread
    let ah_err = app_handle.clone();
    let sid_err = session_id.clone();
    let stderr_handle = std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            match line {
                Ok(l) => {
                    let _ = ah_err.emit(
                        "setup:stderr",
                        SetupLinePayload {
                            session_id: sid_err.clone(),
                            line: l,
                        },
                    );
                }
                Err(_) => break,
            }
        }
    });

    // waiter thread
    let ah_wait = app_handle.clone();
    let sid_wait = session_id.clone();
    let sessions_arc = Arc::clone(&sessions);
    std::thread::spawn(move || {
        let _ = stdout_handle.join();
        let _ = stderr_handle.join();

        let child_opt = {
            let mut map = match sessions_arc.lock() {
                Ok(m) => m,
                Err(_) => {
                    let _ = ah_wait.emit(
                        "setup:failed",
                        SetupFailedPayload {
                            session_id: sid_wait.clone(),
                            error: "sessions lock poisoned during wait".to_string(),
                        },
                    );
                    return;
                }
            };
            map.remove(&sid_wait)
        };

        match child_opt {
            None => {
                // Cancelled: cancel path has already emitted the event.
            }
            Some(mut child) => match child.wait() {
                Ok(status) => {
                    if status.success() {
                        let _ = ah_wait.emit(
                            "setup:finished",
                            SetupFinishedPayload {
                                session_id: sid_wait,
                            },
                        );
                    } else {
                        let code = status.code().unwrap_or(-1);
                        let _ = ah_wait.emit(
                            "setup:failed",
                            SetupFailedPayload {
                                session_id: sid_wait,
                                error: format!("process exited with code {}", code),
                            },
                        );
                    }
                }
                Err(e) => {
                    let _ = ah_wait.emit(
                        "setup:failed",
                        SetupFailedPayload {
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
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn load_settings(app_handle: tauri::AppHandle) -> Result<AppSettings, String> {
    let path = settings_path(&app_handle)?;

    if !path.exists() {
        let runtime_dir = default_runtime_dir(&app_handle)?;
        return Ok(AppSettings {
            runtime_dir,
            setup_complete: false,
            python_path_override: None,
            output_dir_override: None,
        });
    }

    let raw =
        std::fs::read_to_string(&path).map_err(|e| format!("failed to read settings: {}", e))?;
    let settings: AppSettings =
        serde_json::from_str(&raw).map_err(|e| format!("failed to parse settings: {}", e))?;
    Ok(settings)
}

#[tauri::command]
pub async fn create_runtime_venv(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, SetupState>,
    runtime_dir: String,
) -> Result<String, String> {
    validate_runtime_dir(&runtime_dir)?;

    // Create the runtime_dir if it does not exist.
    std::fs::create_dir_all(&runtime_dir)
        .map_err(|e| format!("failed to create runtime dir: {}", e))?;

    let venv_path = Path::new(&runtime_dir).join(".venv");

    // Build argv: {python} -m venv {runtime_dir}/.venv
    let python = resolve_python(None)?;
    let mut cmd = Command::new(&python);
    cmd.arg("-m");
    cmd.arg("venv");
    cmd.arg(&venv_path);

    let sessions = Arc::clone(&state.sessions);
    spawn_and_stream(app_handle, sessions, cmd)
}

#[tauri::command]
pub async fn install_ultralytics(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, SetupState>,
    runtime_dir: String,
) -> Result<String, String> {
    validate_runtime_dir(&runtime_dir)?;

    let python = venv_python(&runtime_dir);

    if !Path::new(&python).exists() {
        return Err(format!(
            "venv python not found at {}; run create_runtime_venv first",
            python
        ));
    }

    // Build argv: {venv_python} -m pip install ultralytics
    let mut cmd = Command::new(&python);
    cmd.arg("-m");
    cmd.arg("pip");
    cmd.arg("install");
    cmd.arg("ultralytics");

    let sessions = Arc::clone(&state.sessions);
    spawn_and_stream(app_handle, sessions, cmd)
}

#[tauri::command]
pub fn mark_setup_complete(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, SettingsState>,
    runtime_dir: String,
) -> Result<(), String> {
    validate_runtime_dir(&runtime_dir)?;
    update_settings(&app_handle, &state, |settings| {
        settings.runtime_dir = runtime_dir;
        settings.setup_complete = true;
    })
}

#[tauri::command]
pub fn save_python_override(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, SettingsState>,
    python_path_override: Option<String>,
) -> Result<(), String> {
    update_settings(&app_handle, &state, |settings| {
        settings.python_path_override = python_path_override;
    })
}

#[tauri::command]
pub fn save_output_dir_override(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, SettingsState>,
    output_dir_override: Option<String>,
) -> Result<(), String> {
    update_settings(&app_handle, &state, |settings| {
        settings.output_dir_override = output_dir_override;
    })
}
