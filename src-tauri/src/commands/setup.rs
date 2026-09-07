use crate::commands::environment::{
    discover_managed_runtime_python_candidate, resolve_managed_runtime_base, resolve_python_with,
    run,
};
use crate::commands::managed_environments::{ManagedEnvironments, ULTRALYTICS_MANAGED_KEY};
use crate::commands::providers::rfdetr::RFDETR_STAGING_PARENT;
use crate::commands::runtime_operations::{
    emit_after_operation_released, RuntimeOperation, RuntimeOperationCoordinator,
    RuntimeOperationGuard,
};
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

fn write_settings_file(path: &Path, settings: &AppSettings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create settings dir: {}", e))?;
    }
    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("failed to serialize settings: {}", e))?;
    std::fs::write(path, json).map_err(|e| format!("failed to write settings: {}", e))?;
    Ok(())
}

fn read_settings_file(path: &Path) -> Result<AppSettings, String> {
    let raw =
        std::fs::read_to_string(path).map_err(|e| format!("failed to read settings: {}", e))?;
    serde_json::from_str(&raw).map_err(|e| format!("failed to parse settings: {}", e))
}

fn write_settings(app_handle: &tauri::AppHandle, settings: &AppSettings) -> Result<(), String> {
    write_settings_file(&settings_path(app_handle)?, settings)
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

pub(crate) fn default_runtime_dir(app_handle: &tauri::AppHandle) -> Result<String, String> {
    let home_dir = app_handle
        .path()
        .home_dir()
        .map_err(|e| format!("could not resolve home dir: {}", e))?;
    default_runtime_dir_from_home(&home_dir.to_string_lossy())
}

pub(crate) fn venv_python(runtime_dir: &str) -> String {
    venv_python_at(&Path::new(runtime_dir).join(".venv"))
}

fn venv_python_in(runtime_dir: &str, venv_name: &str) -> String {
    venv_python_at(&Path::new(runtime_dir).join(venv_name))
}

pub(crate) fn venv_python_at(venv_dir: &Path) -> String {
    #[cfg(windows)]
    {
        venv_dir
            .join("Scripts")
            .join("python.exe")
            .to_string_lossy()
            .into_owned()
    }
    #[cfg(not(windows))]
    {
        venv_dir
            .join("bin")
            .join("python")
            .to_string_lossy()
            .into_owned()
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

fn normalize_loaded_settings(
    settings: AppSettings,
    managed_runtime_dir: &str,
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

pub(crate) fn build_venv_command(python: &str, venv_path: &Path) -> Command {
    let mut command = Command::new(python);
    command.arg("-m");
    command.arg("venv");
    command.arg(venv_path);
    command
}

const MANAGED_RUNTIME_VERSION_VERIFY_SCRIPT: &str =
    "import sys; raise SystemExit(0 if (3, 10) <= sys.version_info[:2] <= (3, 13) else 1)";

fn build_managed_runtime_rebuild_commands(base_python: &str, runtime_dir: &str) -> Vec<Command> {
    let next_venv = Path::new(runtime_dir).join(".venv-next");
    let next_python = venv_python_in(runtime_dir, ".venv-next");

    let mut verify_version = Command::new(&next_python);
    verify_version.args(["-c", MANAGED_RUNTIME_VERSION_VERIFY_SCRIPT]);
    let mut verify_pip = Command::new(&next_python);
    verify_pip.args(["-m", "pip", "--version"]);

    vec![
        build_venv_command(base_python, &next_venv),
        verify_version,
        verify_pip,
    ]
}

pub(crate) fn should_offer_managed_runtime_rebuild(
    has_python_override: bool,
    current_version: Option<(u8, u8)>,
    has_compatible_candidate: bool,
) -> bool {
    !has_python_override
        && current_version.is_some_and(|(major, minor)| major == 3 && minor < 10)
        && has_compatible_candidate
}

#[derive(serde::Serialize)]
pub struct ManagedRuntimeRebuildEligibility {
    pub eligible: bool,
    pub current_version: String,
    pub candidate_version: Option<String>,
}

fn parse_python_version(version: &str) -> Option<(u8, u8)> {
    let mut parts = version
        .trim()
        .strip_prefix("Python ")
        .unwrap_or(version)
        .split('.');
    Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
}

fn managed_runtime_python_version(runtime_dir: &str) -> String {
    let python = venv_python(runtime_dir);
    let output = Command::new(python).arg("--version").output();
    output
        .ok()
        .and_then(|output| {
            let text = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let version = if text.trim().is_empty() { stderr } else { text };
            version.lines().next().map(str::trim).map(str::to_string)
        })
        .unwrap_or_default()
}

fn cleanup_next_runtime(runtime_dir: &Path) {
    let _ = std::fs::remove_dir_all(runtime_dir.join(".venv-next"));
}

pub(crate) fn sweep_runtime_rebuild_artifacts(runtime_dir: &Path) {
    for name in [".venv-old", ".venv-next"] {
        let _ = std::fs::remove_dir_all(runtime_dir.join(name));
    }
}

pub(crate) fn sweep_rfdetr_staging(runtime_dir: &Path) {
    for parent_name in [RFDETR_STAGING_PARENT, ".rfdetr-tflite-staging"] {
        let parent = runtime_dir.join(parent_name);
        let Ok(entries) = std::fs::read_dir(&parent) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let is_session = path.is_dir()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| uuid::Uuid::parse_str(name).is_ok());
            if is_session {
                let _ = std::fs::remove_dir_all(path);
            }
        }
    }
}

fn swap_verified_runtime(runtime_dir: &Path) -> Result<(), String> {
    let current = runtime_dir.join(".venv");
    let next = runtime_dir.join(".venv-next");
    let old = runtime_dir.join(".venv-old");

    let _ = std::fs::remove_dir_all(&old);
    std::fs::rename(&current, &old)
        .map_err(|error| format!("failed to preserve current runtime: {}", error))?;
    if let Err(error) = std::fs::rename(&next, &current) {
        let _ = std::fs::rename(&old, &current);
        return Err(format!("failed to activate rebuilt runtime: {}", error));
    }
    let _ = std::fs::remove_dir_all(old);
    Ok(())
}

fn complete_managed_runtime_rebuild(
    runtime_dir: &Path,
    rebuild_result: Result<(), String>,
) -> Result<(), String> {
    let result = rebuild_result.and_then(|()| swap_verified_runtime(runtime_dir));
    if result.is_err() {
        cleanup_next_runtime(runtime_dir);
    }
    result
}

/// Reuse setup stdout/stderr and terminal events for a sequential runtime rebuild.
fn spawn_and_stream_rebuild(
    app_handle: tauri::AppHandle,
    sessions: Arc<Mutex<HashMap<String, Child>>>,
    commands: Vec<Command>,
    runtime_dir: PathBuf,
    operation_guard: RuntimeOperationGuard,
    managed_environments: ManagedEnvironments,
) -> Result<String, String> {
    let session_id = Uuid::new_v4().to_string();
    let sid_thread = session_id.clone();
    std::thread::spawn(move || {
        let operation_guard = operation_guard;
        let result = commands
            .into_iter()
            .try_for_each(|mut cmd| -> Result<(), String> {
                cmd.stdout(Stdio::piped());
                cmd.stderr(Stdio::piped());
                let mut child = cmd
                    .spawn()
                    .map_err(|error| format!("failed to spawn process: {}", error))?;
                let stdout = child
                    .stdout
                    .take()
                    .ok_or_else(|| "no stdout handle".to_string())?;
                let stderr = child
                    .stderr
                    .take()
                    .ok_or_else(|| "no stderr handle".to_string())?;
                {
                    let mut map = sessions
                        .lock()
                        .map_err(|error| format!("sessions lock poisoned: {}", error))?;
                    map.insert(sid_thread.clone(), child);
                }

                let ah_out = app_handle.clone();
                let sid_out = sid_thread.clone();
                let stdout_handle = std::thread::spawn(move || {
                    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                        let _ = ah_out.emit(
                            "setup:stdout",
                            SetupLinePayload {
                                session_id: sid_out.clone(),
                                line,
                            },
                        );
                    }
                });
                let ah_err = app_handle.clone();
                let sid_err = sid_thread.clone();
                let stderr_handle = std::thread::spawn(move || {
                    for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                        let _ = ah_err.emit(
                            "setup:stderr",
                            SetupLinePayload {
                                session_id: sid_err.clone(),
                                line,
                            },
                        );
                    }
                });
                let _ = stdout_handle.join();
                let _ = stderr_handle.join();

                let mut child = sessions
                    .lock()
                    .map_err(|_| "sessions lock poisoned during wait".to_string())?
                    .remove(&sid_thread)
                    .ok_or_else(|| "setup session was cancelled".to_string())?;
                let status = child
                    .wait()
                    .map_err(|error| format!("wait error: {}", error))?;
                if status.success() {
                    Ok(())
                } else {
                    Err(format!(
                        "process exited with code {}",
                        status.code().unwrap_or(-1)
                    ))
                }
            });

        let result = complete_managed_runtime_rebuild(&runtime_dir, result);
        managed_environments.invalidate(&runtime_dir, [ULTRALYTICS_MANAGED_KEY]);
        match result {
            Ok(()) => {
                emit_after_operation_released(operation_guard, || {
                    let _ = app_handle.emit(
                        "setup:finished",
                        SetupFinishedPayload {
                            session_id: sid_thread,
                        },
                    );
                });
            }
            Err(error) => {
                emit_after_operation_released(operation_guard, || {
                    let _ = app_handle.emit(
                        "setup:failed",
                        SetupFailedPayload {
                            session_id: sid_thread,
                            error,
                        },
                    );
                });
            }
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

    if !path.exists() {
        let (settings, _) = normalize_loaded_settings(
            AppSettings {
                runtime_dir: managed_runtime_dir,
                python_path_override: None,
                output_dir_override: None,
            },
            default_runtime_dir(&app_handle)?.as_str(),
        );
        return Ok(settings);
    }

    let settings = read_settings_file(&path)?;
    let (normalized, changed) = normalize_loaded_settings(settings, &managed_runtime_dir);
    if changed {
        write_settings(&app_handle, &normalized)?;
    }
    Ok(normalized)
}

#[tauri::command]
pub fn get_managed_runtime_rebuild_eligibility(
    app_handle: tauri::AppHandle,
) -> Result<ManagedRuntimeRebuildEligibility, String> {
    let settings = load_settings(app_handle)?;
    let current_version = managed_runtime_python_version(&settings.runtime_dir);
    let candidate = discover_managed_runtime_python_candidate();
    let eligible = should_offer_managed_runtime_rebuild(
        has_python_override(settings.python_path_override.as_deref()),
        parse_python_version(&current_version),
        candidate.is_some(),
    );

    Ok(ManagedRuntimeRebuildEligibility {
        eligible,
        current_version,
        candidate_version: candidate.map(|candidate| {
            format!(
                "{}.{}.{}",
                candidate.major, candidate.minor, candidate.patch
            )
        }),
    })
}

/// Fallback route for resolving a bootstrap interpreter when repairing the
/// Ultralytics managed environment. Its requirement is the managed range
/// (Python 3.10 through 3.13), so it matches the discovery policy.
pub(crate) const DEFAULT_SETUP_ROUTE_ID: &str = "ultralytics.pt.onnx";

#[tauri::command]
pub async fn rebuild_managed_runtime(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, SetupState>,
    runtime_operations: tauri::State<'_, RuntimeOperationCoordinator>,
    managed_environments: tauri::State<'_, ManagedEnvironments>,
    python_path: Option<String>,
) -> Result<String, String> {
    let settings = load_settings(app_handle.clone())?;
    if has_python_override(settings.python_path_override.as_deref()) {
        return Err(
            "cannot rebuild managed runtime while a Python override is configured".to_string(),
        );
    }
    let managed_runtime_dir = ensure_managed_runtime_dir(&app_handle, &settings.runtime_dir)?;
    let sessions = Arc::clone(&state.sessions);
    let operation_guard = runtime_operations.acquire(RuntimeOperation::Rebuild)?;

    let base_python = resolve_managed_runtime_base(python_path.as_deref())?;
    let runtime_path = PathBuf::from(&managed_runtime_dir);
    cleanup_next_runtime(&runtime_path);

    spawn_and_stream_rebuild(
        app_handle,
        sessions,
        build_managed_runtime_rebuild_commands(&base_python, &managed_runtime_dir),
        runtime_path,
        operation_guard,
        managed_environments.inner().clone(),
    )
}

#[tauri::command]
pub fn save_python_override(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, SettingsState>,
    python_path_override: Option<String>,
) -> Result<(), String> {
    let normalized_override = normalize_python_override(python_path_override);
    // Validate before saving so a direct invoke cannot persist an invalid
    // executable. Reuses the shared explicit-path probe; route-specific
    // compatibility stays with the bootstrap resolver at setup time.
    if let Some(path) = normalized_override.as_deref() {
        resolve_python_with(Some(path), cfg!(windows), run).map(|_| ())?;
    }
    update_settings(&app_handle, &state, |settings| {
        settings.python_path_override = normalized_override;
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
    use std::fs;

    #[test]
    fn rebuild_eligibility_requires_old_managed_python_and_discovered_candidate() {
        assert!(!should_offer_managed_runtime_rebuild(
            true,
            Some((3, 9)),
            true
        ));
        for version in [(3, 10), (3, 11), (3, 12), (3, 13)] {
            assert!(!should_offer_managed_runtime_rebuild(
                false,
                Some(version),
                true
            ));
        }
        assert!(should_offer_managed_runtime_rebuild(
            false,
            Some((3, 9)),
            true
        ));
        assert!(!should_offer_managed_runtime_rebuild(
            false,
            Some((3, 9)),
            false
        ));
    }

    #[test]
    fn swap_verified_runtime_replaces_old_venv_and_cleans_backup() {
        let runtime_dir = test_runtime_dir("runtime-swap");
        let current = Path::new(&runtime_dir).join(".venv");
        let next = Path::new(&runtime_dir).join(".venv-next");
        fs::create_dir_all(&current).unwrap();
        fs::create_dir_all(&next).unwrap();
        fs::write(current.join("marker"), "old").unwrap();
        fs::write(next.join("marker"), "new").unwrap();

        swap_verified_runtime(Path::new(&runtime_dir)).unwrap();

        assert_eq!(fs::read_to_string(current.join("marker")).unwrap(), "new");
        assert!(!Path::new(&runtime_dir).join(".venv-old").exists());
        assert!(!next.exists());
        fs::remove_dir_all(runtime_dir).unwrap();
    }

    #[test]
    fn failed_verification_preserves_current_runtime_and_removes_next() {
        let runtime_dir = test_runtime_dir("runtime-failed-verification");
        let current = Path::new(&runtime_dir).join(".venv");
        let next = Path::new(&runtime_dir).join(".venv-next");
        fs::create_dir_all(&current).unwrap();
        fs::create_dir_all(&next).unwrap();
        let marker = current.join("marker");
        fs::write(&marker, b"old runtime bytes").unwrap();
        fs::write(next.join("marker"), b"new runtime bytes").unwrap();
        let before = fs::read(&marker).unwrap();

        cleanup_next_runtime(Path::new(&runtime_dir));

        assert_eq!(fs::read(&marker).unwrap(), before);
        assert!(!next.exists());
        fs::remove_dir_all(runtime_dir).unwrap();
    }

    #[test]
    fn rebuild_commands_create_and_verify_python_without_provider_install() {
        let commands =
            build_managed_runtime_rebuild_commands("/opt/python3.12/bin/python3", "/tmp/runtime");
        let command_args = commands
            .iter()
            .map(|command| {
                command
                    .get_args()
                    .map(|arg| arg.to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();

        assert_eq!(command_args.len(), 3);
        assert_eq!(
            command_args[0],
            vec!["-m", "venv", "/tmp/runtime/.venv-next"]
        );
        assert_eq!(command_args[1][0], "-c");
        assert!(command_args[1][1].contains("sys.version_info"));
        assert_eq!(command_args[2], vec!["-m", "pip", "--version"]);
        assert!(!command_args
            .iter()
            .flatten()
            .any(|arg| arg.contains("ultralytics")));
    }

    #[test]
    fn unusable_pip_preserves_current_runtime_and_removes_next() {
        let runtime_dir = test_runtime_dir("runtime-pip-verification-failure");
        let current = Path::new(&runtime_dir).join(".venv");
        let next = Path::new(&runtime_dir).join(".venv-next");
        fs::create_dir_all(&current).unwrap();
        fs::create_dir_all(&next).unwrap();
        fs::write(current.join("marker"), "old").unwrap();
        fs::write(next.join("marker"), "new").unwrap();

        let error = complete_managed_runtime_rebuild(
            Path::new(&runtime_dir),
            Err("pip verification failed".to_string()),
        )
        .unwrap_err();

        assert_eq!(error, "pip verification failed");
        assert_eq!(fs::read_to_string(current.join("marker")).unwrap(), "old");
        assert!(!next.exists());
        fs::remove_dir_all(runtime_dir).unwrap();
    }

    #[test]
    fn startup_sweep_removes_only_exact_rebuild_artifacts() {
        let runtime_dir = test_runtime_dir("runtime-sweep");
        for name in [".venv", ".venv-old", ".venv-next", ".venv-backup"] {
            fs::create_dir_all(Path::new(&runtime_dir).join(name)).unwrap();
        }

        sweep_runtime_rebuild_artifacts(Path::new(&runtime_dir));

        assert!(Path::new(&runtime_dir).join(".venv").exists());
        assert!(!Path::new(&runtime_dir).join(".venv-old").exists());
        assert!(!Path::new(&runtime_dir).join(".venv-next").exists());
        assert!(Path::new(&runtime_dir).join(".venv-backup").exists());
        fs::remove_dir_all(runtime_dir).unwrap();
    }

    #[test]
    fn startup_sweep_removes_only_uuid_named_rfdetr_staging_directories() {
        let runtime = std::env::temp_dir().join(format!("rfdetr-sweep-{}", uuid::Uuid::new_v4()));
        let parent = runtime.join(".rfdetr-staging");
        std::fs::create_dir_all(parent.join("550e8400-e29b-41d4-a716-446655440000"))
            .expect("create abandoned staging");
        std::fs::create_dir_all(parent.join("keep-me")).expect("create non-session staging");
        std::fs::create_dir_all(runtime.join("unrelated"))
            .expect("create unrelated runtime directory");

        super::sweep_rfdetr_staging(&runtime);

        assert!(!parent.join("550e8400-e29b-41d4-a716-446655440000").exists());
        assert!(parent.join("keep-me").exists());
        assert!(runtime.join("unrelated").exists());
        let _ = std::fs::remove_dir_all(runtime);
    }

    #[test]
    fn default_runtime_dir_uses_vision_export_studio_dir_in_home() {
        let runtime_dir = default_runtime_dir_from_home("/Users/tester").unwrap();
        assert_eq!(runtime_dir, "/Users/tester/.vision-export-studio");
    }

    #[test]
    fn venv_command_uses_resolved_python_and_expected_arguments() {
        let venv_path = Path::new("C:/Users/HP/.vision-export-studio/.venv");
        let command = build_venv_command(
            "C:/Users/HP/AppData/Local/Programs/Python/Python310/python.exe",
            venv_path,
        );

        assert_eq!(
            command.get_program(),
            "C:/Users/HP/AppData/Local/Programs/Python/Python310/python.exe"
        );
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            args,
            vec!["-m", "venv", "C:/Users/HP/.vision-export-studio/.venv"]
        );
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

    fn test_runtime_dir(name: &str) -> String {
        std::env::temp_dir()
            .join(format!("vision-export-studio-{}-{}", name, Uuid::new_v4()))
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn normalize_loaded_settings_migrates_runtime_dir_to_managed_root() {
        let settings = AppSettings {
            runtime_dir: "/Users/tester/Developer/oss/vision-export-studio".to_string(),
            python_path_override: None,
            output_dir_override: None,
        };

        let (normalized, changed) =
            normalize_loaded_settings(settings, "/Users/tester/.vision-export-studio");

        assert!(changed);
        assert_eq!(
            normalized.runtime_dir,
            "/Users/tester/.vision-export-studio"
        );
    }

    #[test]
    fn normalize_loaded_settings_preserves_override_during_runtime_migration() {
        let settings = AppSettings {
            runtime_dir: "/Users/tester/Developer/oss/vision-export-studio".to_string(),
            python_path_override: Some("/custom/python".to_string()),
            output_dir_override: Some("/tmp/exports".to_string()),
        };

        let (normalized, changed) =
            normalize_loaded_settings(settings, "/Users/tester/.vision-export-studio");

        assert!(changed);
        assert_eq!(
            normalized.runtime_dir,
            "/Users/tester/.vision-export-studio"
        );
        // Ticket 14: existing saved executable paths survive migration so a
        // bootstrap-only override keeps working as a creation candidate.
        assert_eq!(
            normalized.python_path_override.as_deref(),
            Some("/custom/python")
        );
        assert_eq!(
            normalized.output_dir_override.as_deref(),
            Some("/tmp/exports")
        );
    }

    #[test]
    fn normalize_loaded_settings_preserves_trimmed_override_path() {
        let settings = AppSettings {
            runtime_dir: "/Users/tester/.vision-export-studio".to_string(),
            python_path_override: Some("  /custom/python  ".to_string()),
            output_dir_override: None,
        };

        let (normalized, changed) =
            normalize_loaded_settings(settings, "/Users/tester/.vision-export-studio");

        assert!(changed);
        assert_eq!(
            normalized.python_path_override.as_deref(),
            Some("/custom/python")
        );
    }

    #[test]
    fn normalize_loaded_settings_leaves_healthy_settings_untouched() {
        let settings = AppSettings {
            runtime_dir: "/Users/tester/.vision-export-studio".to_string(),
            python_path_override: None,
            output_dir_override: Some("/tmp/exports".to_string()),
        };

        let (normalized, changed) =
            normalize_loaded_settings(settings, "/Users/tester/.vision-export-studio");

        assert!(!changed);
        assert_eq!(
            normalized.output_dir_override.as_deref(),
            Some("/tmp/exports")
        );
    }

    #[test]
    fn legacy_setup_complete_field_is_ignored_without_forced_rewrite() {
        // Ticket 15: older files carry the retired global flag. Deserialization
        // must tolerate it (present true/false) and normalization must not
        // derive or preserve it, so loading never forces a rewrite.
        for legacy in ["true", "false"] {
            let raw = format!(
                r#"{{"runtime_dir":"/Users/tester/.vision-export-studio","setup_complete":{legacy},"python_path_override":null,"output_dir_override":null}}"#
            );
            let settings: AppSettings = serde_json::from_str(&raw).unwrap();
            assert_eq!(settings.runtime_dir, "/Users/tester/.vision-export-studio");
            assert_eq!(settings.python_path_override, None);

            let (normalized, changed) =
                normalize_loaded_settings(settings, "/Users/tester/.vision-export-studio");
            assert!(
                !changed,
                "legacy setup_complete={legacy} must not dirty settings"
            );
            // The retired flag never round-trips: new writes omit it while
            // unrelated settings survive exactly.
            let written = serde_json::to_string(&normalized).unwrap();
            assert!(
                !written.contains("setup_complete"),
                "serialized settings must omit legacy flag: {written}"
            );
        }
    }

    #[test]
    fn missing_optional_fields_default_without_data_loss() {
        // New minimal files and provider-only states (runtime_dir alone) load
        // with absent overrides defaulting to None.
        let settings: AppSettings =
            serde_json::from_str(r#"{"runtime_dir":"/tmp/runtime"}"#).unwrap();
        assert_eq!(settings.runtime_dir, "/tmp/runtime");
        assert_eq!(settings.python_path_override, None);
        assert_eq!(settings.output_dir_override, None);

        let (normalized, changed) = normalize_loaded_settings(settings, "/tmp/runtime");
        assert!(!changed);
        assert_eq!(normalized.runtime_dir, "/tmp/runtime");
    }

    #[test]
    fn unrelated_settings_survive_trim_normalization_exactly() {
        let settings = AppSettings {
            runtime_dir: "/Users/tester/.vision-export-studio".to_string(),
            python_path_override: Some("  /custom/python  ".to_string()),
            output_dir_override: Some("/tmp/keep-me".to_string()),
        };

        let (normalized, changed) =
            normalize_loaded_settings(settings, "/Users/tester/.vision-export-studio");

        assert!(changed);
        assert_eq!(
            normalized.python_path_override.as_deref(),
            Some("/custom/python")
        );
        // Unrelated output settings are preserved byte-for-byte through the
        // same save path that drops the legacy flag.
        assert_eq!(
            normalized.output_dir_override.as_deref(),
            Some("/tmp/keep-me")
        );
    }
}
