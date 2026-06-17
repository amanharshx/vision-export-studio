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
    write_settings(app_handle, &settings)?;
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
    Ok(data_dir.join("vision-export-studio-settings.json"))
}

fn write_settings(app_handle: &tauri::AppHandle, settings: &AppSettings) -> Result<(), String> {
    let path = settings_path(app_handle)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create settings dir: {}", e))?;
    }
    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("failed to serialize settings: {}", e))?;
    std::fs::write(&path, json).map_err(|e| format!("failed to write settings: {}", e))?;
    Ok(())
}

fn default_runtime_dir_from_home(home_dir: &str) -> Result<String, String> {
    if home_dir.trim().is_empty() {
        return Err("could not resolve home dir".to_string());
    }
    Ok(format!(
        "{}/.vision-export-studio",
        home_dir.trim_end_matches(['/', '\\'])
    ))
}

fn default_runtime_dir(app_handle: &tauri::AppHandle) -> Result<String, String> {
    let home_dir = app_handle
        .path()
        .home_dir()
        .map_err(|e| format!("could not resolve home dir: {}", e))?;
    default_runtime_dir_from_home(&home_dir.to_string_lossy())
}

pub(crate) fn venv_python(runtime_dir: &str) -> String {
    #[cfg(windows)]
    {
        format!("{}/.venv/Scripts/python.exe", runtime_dir)
    }
    #[cfg(not(windows))]
    {
        format!("{}/.venv/bin/python", runtime_dir)
    }
}

pub(crate) fn venv_yolo(runtime_dir: &str) -> String {
    #[cfg(windows)]
    {
        format!("{}/.venv/Scripts/yolo.exe", runtime_dir)
    }
    #[cfg(not(windows))]
    {
        format!("{}/.venv/bin/yolo", runtime_dir)
    }
}

fn has_python_override(python_path_override: Option<&str>) -> bool {
    python_path_override
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .is_some()
}

fn normalize_python_override(python_path_override: Option<String>) -> Option<String> {
    python_path_override.and_then(|path| {
        let trimmed = path.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

fn managed_runtime_is_ready(runtime_dir: &str) -> bool {
    Path::new(&venv_python(runtime_dir)).exists()
}

fn normalize_loaded_settings(
    settings: AppSettings,
    managed_runtime_dir: &str,
    managed_runtime_ready: bool,
) -> (AppSettings, bool) {
    let mut normalized = settings;
    let mut changed = false;

    if normalized.runtime_dir != managed_runtime_dir {
        normalized.runtime_dir = managed_runtime_dir.to_string();
        changed = true;
    }

    let normalized_override = normalize_python_override(normalized.python_path_override.clone());
    if normalized.python_path_override != normalized_override {
        normalized.python_path_override = normalized_override;
        changed = true;
    }

    let expected_setup_complete =
        managed_runtime_ready || has_python_override(normalized.python_path_override.as_deref());
    if normalized.setup_complete != expected_setup_complete {
        normalized.setup_complete = expected_setup_complete;
        changed = true;
    }

    (normalized, changed)
}

fn ensure_managed_runtime_dir(
    app_handle: &tauri::AppHandle,
    runtime_dir: &str,
) -> Result<String, String> {
    validate_runtime_dir(runtime_dir)?;
    let managed_runtime_dir = default_runtime_dir(app_handle)?;
    if runtime_dir != managed_runtime_dir {
        return Err(format!(
            "runtime_dir must match managed runtime root: {}",
            managed_runtime_dir
        ));
    }
    Ok(managed_runtime_dir)
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
    let managed_runtime_dir = default_runtime_dir(&app_handle)?;
    let managed_runtime_ready = managed_runtime_is_ready(&managed_runtime_dir);

    if !path.exists() {
        let (settings, _) = normalize_loaded_settings(
            AppSettings {
                runtime_dir: managed_runtime_dir,
                setup_complete: false,
                python_path_override: None,
                output_dir_override: None,
            },
            default_runtime_dir(&app_handle)?.as_str(),
            managed_runtime_ready,
        );
        return Ok(settings);
    }

    let raw =
        std::fs::read_to_string(&path).map_err(|e| format!("failed to read settings: {}", e))?;
    let settings: AppSettings =
        serde_json::from_str(&raw).map_err(|e| format!("failed to parse settings: {}", e))?;
    let (normalized, changed) =
        normalize_loaded_settings(settings, &managed_runtime_dir, managed_runtime_ready);
    if changed {
        write_settings(&app_handle, &normalized)?;
    }
    Ok(normalized)
}

#[tauri::command]
pub async fn create_runtime_venv(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, SetupState>,
    runtime_dir: String,
) -> Result<String, String> {
    let managed_runtime_dir = ensure_managed_runtime_dir(&app_handle, &runtime_dir)?;

    // Create the runtime_dir if it does not exist.
    std::fs::create_dir_all(&managed_runtime_dir)
        .map_err(|e| format!("failed to create runtime dir: {}", e))?;

    let venv_path = Path::new(&managed_runtime_dir).join(".venv");

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
pub fn mark_setup_complete(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, SettingsState>,
    runtime_dir: String,
) -> Result<(), String> {
    let managed_runtime_dir = ensure_managed_runtime_dir(&app_handle, &runtime_dir)?;
    update_settings(&app_handle, &state, |settings| {
        settings.runtime_dir = managed_runtime_dir;
        settings.setup_complete = true;
    })
}

#[tauri::command]
pub fn save_python_override(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, SettingsState>,
    python_path_override: Option<String>,
) -> Result<(), String> {
    let normalized_override = normalize_python_override(python_path_override);
    update_settings(&app_handle, &state, |settings| {
        settings.python_path_override = normalized_override;
        if settings.python_path_override.is_some() {
            settings.setup_complete = true;
        } else {
            settings.setup_complete = managed_runtime_is_ready(&settings.runtime_dir);
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_runtime_dir_uses_vision_export_studio_dir_in_home() {
        let runtime_dir = default_runtime_dir_from_home("/Users/tester").unwrap();
        assert_eq!(runtime_dir, "/Users/tester/.vision-export-studio");
    }

    #[test]
    fn venv_python_uses_platform_specific_location() {
        let python = venv_python("/tmp/vision-export-studio");

        #[cfg(windows)]
        assert_eq!(python, "/tmp/vision-export-studio/.venv/Scripts/python.exe");

        #[cfg(not(windows))]
        assert_eq!(python, "/tmp/vision-export-studio/.venv/bin/python");
    }

    #[test]
    fn venv_yolo_uses_platform_specific_location() {
        let yolo = venv_yolo("/tmp/vision-export-studio");

        #[cfg(windows)]
        assert_eq!(yolo, "/tmp/vision-export-studio/.venv/Scripts/yolo.exe");

        #[cfg(not(windows))]
        assert_eq!(yolo, "/tmp/vision-export-studio/.venv/bin/yolo");
    }

    #[test]
    fn normalize_loaded_settings_migrates_runtime_dir_to_managed_root() {
        let settings = AppSettings {
            runtime_dir: "/Users/tester/Developer/oss/vision-export-studio".to_string(),
            setup_complete: true,
            python_path_override: None,
            output_dir_override: None,
        };

        let (normalized, changed) =
            normalize_loaded_settings(settings, "/Users/tester/.vision-export-studio", false);

        assert!(changed);
        assert_eq!(
            normalized.runtime_dir,
            "/Users/tester/.vision-export-studio"
        );
        assert!(!normalized.setup_complete);
    }

    #[test]
    fn normalize_loaded_settings_keeps_setup_complete_when_override_exists() {
        let settings = AppSettings {
            runtime_dir: "/Users/tester/Developer/oss/vision-export-studio".to_string(),
            setup_complete: false,
            python_path_override: Some("/custom/python".to_string()),
            output_dir_override: None,
        };

        let (normalized, changed) =
            normalize_loaded_settings(settings, "/Users/tester/.vision-export-studio", false);

        assert!(changed);
        assert_eq!(
            normalized.runtime_dir,
            "/Users/tester/.vision-export-studio"
        );
        assert!(normalized.setup_complete);
    }

    #[test]
    fn normalize_loaded_settings_marks_complete_when_managed_runtime_ready() {
        let settings = AppSettings {
            runtime_dir: "/Users/tester/.vision-export-studio".to_string(),
            setup_complete: false,
            python_path_override: None,
            output_dir_override: None,
        };

        let (normalized, changed) =
            normalize_loaded_settings(settings, "/Users/tester/.vision-export-studio", true);

        assert!(changed);
        assert!(normalized.setup_complete);
    }

    #[test]
    fn normalize_loaded_settings_marks_complete_when_managed_venv_python_exists() {
        let settings = AppSettings {
            runtime_dir: "/Users/tester/.vision-export-studio".to_string(),
            setup_complete: false,
            python_path_override: None,
            output_dir_override: None,
        };

        let (normalized, changed) =
            normalize_loaded_settings(settings, "/Users/tester/.vision-export-studio", true);

        assert!(changed);
        assert!(normalized.setup_complete);
    }

    #[test]
    fn normalize_loaded_settings_marks_incomplete_when_managed_venv_python_missing() {
        let settings = AppSettings {
            runtime_dir: "/Users/tester/.vision-export-studio".to_string(),
            setup_complete: true,
            python_path_override: None,
            output_dir_override: None,
        };

        let (normalized, changed) =
            normalize_loaded_settings(settings, "/Users/tester/.vision-export-studio", false);

        assert!(changed);
        assert!(!normalized.setup_complete);
    }
}
