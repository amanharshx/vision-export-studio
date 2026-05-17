use crate::commands::setup::{load_settings, venv_python, venv_yolo};
use std::path::Path;
use std::process::Command;

#[derive(serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DetectionStatus {
    Ok,
    Partial,
    Missing,
}

#[derive(serde::Serialize)]
pub struct EnvironmentInfo {
    pub python_path: String,
    pub python_version: String,
    pub ultralytics_version: String,
    pub yolo_path: String,
    pub status: DetectionStatus,
    pub warnings: Vec<String>,
}

fn first_line(text: &str) -> Option<&str> {
    text.lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
}

/// Run a command and return (stdout, stderr, success).
/// Returns Err only when the process cannot be spawned at all.
fn run(argv: &[&str]) -> Result<(String, String, bool), String> {
    if argv.is_empty() {
        return Err("empty argv".to_string());
    }
    let mut cmd = Command::new(argv[0]);
    for arg in &argv[1..] {
        cmd.arg(arg);
    }
    let output = cmd
        .output()
        .map_err(|e| format!("failed to spawn {:?}: {}", argv[0], e))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Ok((stdout, stderr, output.status.success()))
}

/// Attempt to resolve the Python executable.
/// If `python_path` is provided, use it directly.
/// Otherwise try "python3" then "python", picking the first that responds to --version.
pub(crate) fn resolve_python(python_path: Option<&str>) -> Result<String, String> {
    if let Some(path) = python_path {
        // If the caller supplied an explicit filesystem path (contains a separator),
        // verify it exists before spawning — avoids misleading spawn errors.
        if path.contains('/') || path.contains('\\') {
            if !Path::new(path).exists() {
                return Err(format!("Python path does not exist: {}", path));
            }
        }
        // Validate the provided path by running --version.
        run(&[path, "--version"])
            .map_err(|e| format!("provided python path is not executable: {}", e))?;
        return Ok(path.to_string());
    }

    for candidate in &["python3", "python"] {
        if run(&[candidate, "--version"]).is_ok() {
            return Ok(candidate.to_string());
        }
    }

    Err("no Python executable found; install Python 3 and ensure it is on PATH".to_string())
}

fn pick_python_candidate(
    explicit_override: Option<String>,
    setup_complete: bool,
    managed_python: Option<String>,
) -> Option<String> {
    if let Some(path) = explicit_override {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    if setup_complete {
        return managed_python.filter(|path| !path.trim().is_empty());
    }

    None
}

fn resolve_effective_python(
    app_handle: &tauri::AppHandle,
    explicit_override: Option<String>,
) -> Result<String, String> {
    let settings = load_settings(app_handle.clone())?;
    let managed_python = if settings.setup_complete {
        let candidate = venv_python(&settings.runtime_dir);
        Path::new(&candidate).exists().then_some(candidate)
    } else {
        None
    };

    match pick_python_candidate(explicit_override, settings.setup_complete, managed_python) {
        Some(candidate) => resolve_python(Some(candidate.as_str())),
        None => resolve_python(None),
    }
}

fn detect_yolo_path(
    python_path: &str,
    managed_runtime_dir: Option<&str>,
) -> Result<String, String> {
    if let Some(runtime_dir) = managed_runtime_dir {
        let managed_python = venv_python(runtime_dir);
        if python_path == managed_python {
            let managed_yolo = venv_yolo(runtime_dir);
            if Path::new(&managed_yolo).exists() {
                return Ok(managed_yolo);
            }
        }
    }

    let script = "import os, shutil, sysconfig; scripts = sysconfig.get_path('scripts') or ''; name = 'yolo.exe' if os.name == 'nt' else 'yolo'; candidate = os.path.join(scripts, name) if scripts else ''; print(candidate if candidate and os.path.exists(candidate) else (shutil.which('yolo') or ''))";
    let (stdout, _, _) = run(&[python_path, "-c", script])?;
    Ok(stdout)
}

#[tauri::command]
pub async fn detect_environment(
    app_handle: tauri::AppHandle,
    python_path: Option<String>,
) -> Result<EnvironmentInfo, String> {
    let mut warnings: Vec<String> = Vec::new();
    let settings = load_settings(app_handle.clone())?;

    // Step 1: resolve the Python executable.
    let resolved = resolve_effective_python(&app_handle, python_path)?;

    // Step 2: python_version — Python 2 prints to stderr, Python 3 to stdout.
    let python_version = {
        let (stdout, stderr, _) = run(&[&resolved, "--version"])?;
        let raw = if !stdout.is_empty() { stdout } else { stderr };
        raw.strip_prefix("Python ")
            .unwrap_or(&raw)
            .trim()
            .to_string()
    };

    // Step 3: ultralytics_version — non-zero exit or empty stdout is a warning, not an error.
    let ultralytics_version = {
        match run(&[
            &resolved,
            "-c",
            "import ultralytics; print(ultralytics.__version__)",
        ]) {
            Ok((stdout, _, true)) if !stdout.is_empty() => stdout,
            Ok((_, stderr, _)) => {
                let hint = first_line(&stderr)
                    .map(|line| format!(" ({})", line))
                    .unwrap_or_default();
                warnings.push(format!(
                    "Ultralytics import missing in selected Python environment{}",
                    hint
                ));
                String::new()
            }
            Err(e) => {
                warnings.push(format!("could not query ultralytics version: {}", e));
                String::new()
            }
        }
    };

    // Step 4: yolo_path derived from the selected Python environment.
    let yolo_path = {
        match detect_yolo_path(&resolved, Some(settings.runtime_dir.as_str())) {
            Ok(stdout) if !stdout.is_empty() => stdout,
            Ok(_) => {
                warnings.push("yolo executable missing in selected Python environment".to_string());
                String::new()
            }
            Err(e) => {
                warnings.push(format!("could not locate yolo CLI: {}", e));
                String::new()
            }
        }
    };

    // Step 5: derive status.
    let status = if python_version.is_empty() {
        DetectionStatus::Missing
    } else if !ultralytics_version.is_empty() && !yolo_path.is_empty() {
        DetectionStatus::Ok
    } else {
        DetectionStatus::Partial
    };

    Ok(EnvironmentInfo {
        python_path: resolved,
        python_version,
        ultralytics_version,
        yolo_path,
        status,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_override_wins_when_present() {
        let selected = pick_python_candidate(
            Some("/custom/python".to_string()),
            true,
            Some("/managed/.venv/bin/python".to_string()),
        );
        assert_eq!(selected, Some("/custom/python".to_string()));
    }

    #[test]
    fn managed_runtime_used_when_setup_complete_and_no_override() {
        let selected =
            pick_python_candidate(None, true, Some("/managed/.venv/bin/python".to_string()));
        assert_eq!(selected, Some("/managed/.venv/bin/python".to_string()));
    }

    #[test]
    fn system_python_fallback_used_before_setup() {
        let selected =
            pick_python_candidate(None, false, Some("/managed/.venv/bin/python".to_string()));
        assert_eq!(selected, None);
    }

    #[test]
    fn blank_override_falls_back_to_managed_runtime() {
        let selected = pick_python_candidate(
            Some("   ".to_string()),
            true,
            Some("/managed/.venv/bin/python".to_string()),
        );
        assert_eq!(selected, Some("/managed/.venv/bin/python".to_string()));
    }
}
