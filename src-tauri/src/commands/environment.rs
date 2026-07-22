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

const PYTHON_PROBE_MARKER: &str = "__VES_PYTHON__=";
const PYTHON_PROBE_SCRIPT: &str = "import os, sys; print('__VES_PYTHON__=' + os.path.abspath(sys.executable)); raise SystemExit(0 if sys.version_info[0] == 3 else 1)";

const WINDOWS_PYTHON_CANDIDATES: &[&[&str]] = &[&["python"], &["py", "-3"], &["python3"]];
const UNIX_PYTHON_CANDIDATES: &[&[&str]] = &[&["python3"], &["python"]];

fn python_candidates(is_windows: bool) -> &'static [&'static [&'static str]] {
    if is_windows {
        WINDOWS_PYTHON_CANDIDATES
    } else {
        UNIX_PYTHON_CANDIDATES
    }
}

fn parse_python_probe(stdout: &str, success: bool) -> Option<String> {
    if !success {
        return None;
    }

    stdout.lines().find_map(|line| {
        line.trim()
            .strip_prefix(PYTHON_PROBE_MARKER)
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(str::to_string)
    })
}

fn probe_python<F>(candidate: &[&str], runner: &F) -> Result<String, String>
where
    F: Fn(&[&str]) -> Result<(String, String, bool), String>,
{
    let mut argv = candidate.to_vec();
    argv.push("-c");
    argv.push(PYTHON_PROBE_SCRIPT);

    let (stdout, stderr, success) = runner(&argv)?;
    if let Some(path) = parse_python_probe(&stdout, success) {
        return Ok(path);
    }

    let detail = first_line(&stderr)
        .or_else(|| first_line(&stdout))
        .unwrap_or("probe returned no valid Python 3 executable");
    Err(format!(
        "{} failed validation: {}",
        candidate.join(" "),
        detail
    ))
}

fn resolve_python_with<F>(
    python_path: Option<&str>,
    is_windows: bool,
    runner: F,
) -> Result<String, String>
where
    F: Fn(&[&str]) -> Result<(String, String, bool), String>,
{
    if let Some(path) = python_path {
        if (path.contains('/') || path.contains('\\')) && !Path::new(path).exists() {
            return Err(format!("Python path does not exist: {}", path));
        }

        return probe_python(&[path], &runner)
            .map_err(|error| format!("provided Python failed validation: {}", error));
    }

    let candidates = python_candidates(is_windows);
    let mut failures = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        match probe_python(candidate, &runner) {
            Ok(resolved_path) => return Ok(resolved_path),
            Err(error) => failures.push(error),
        }
    }

    let attempted = candidates
        .iter()
        .map(|candidate| candidate.join(" "))
        .collect::<Vec<_>>()
        .join(", ");
    Err(format!(
        "no working Python 3 interpreter found; tried {}; failures: {}; install Python 3 and restart the app",
        attempted,
        failures.join(" | ")
    ))
}

/// Resolve a working Python 3 interpreter to its actual `sys.executable` path.
/// Windows order: `python`, `py -3`, `python3`.
/// Unix order: `python3`, `python`.
pub(crate) fn resolve_python(python_path: Option<&str>) -> Result<String, String> {
    resolve_python_with(python_path, cfg!(windows), run)
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
    use std::cell::RefCell;

    #[test]
    fn windows_python_candidates_use_expected_priority() {
        let candidates = python_candidates(true)
            .iter()
            .map(|candidate| candidate.join(" "))
            .collect::<Vec<_>>();

        assert_eq!(candidates, vec!["python", "py -3", "python3"]);
    }

    #[test]
    fn unix_python_candidates_use_expected_priority() {
        let candidates = python_candidates(false)
            .iter()
            .map(|candidate| candidate.join(" "))
            .collect::<Vec<_>>();

        assert_eq!(candidates, vec!["python3", "python"]);
    }

    #[test]
    fn python_probe_requires_success_and_marker() {
        let output = "__VES_PYTHON__=C:\\Python310\\python.exe";

        assert_eq!(
            parse_python_probe(output, true),
            Some("C:\\Python310\\python.exe".to_string())
        );
        assert_eq!(parse_python_probe(output, false), None);
        assert_eq!(parse_python_probe("Python 3.10.11", true), None);
    }

    #[test]
    fn windows_resolver_skips_failed_alias_and_uses_launcher() {
        let calls = RefCell::new(Vec::<Vec<String>>::new());

        let resolved = resolve_python_with(None, true, |argv| {
            calls
                .borrow_mut()
                .push(argv.iter().map(|arg| arg.to_string()).collect());

            match argv[0] {
                "python" => Ok((
                    String::new(),
                    "process exited with code 9009".to_string(),
                    false,
                )),
                "py" => Ok((
                    "__VES_PYTHON__=C:\\Python310\\python.exe".to_string(),
                    String::new(),
                    true,
                )),
                _ => panic!("unexpected candidate: {}", argv[0]),
            }
        })
        .unwrap();

        assert_eq!(resolved, "C:\\Python310\\python.exe");
        let calls = calls.borrow();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0][0], "python");
        assert_eq!(calls[1][..3], ["py", "-3", "-c"]);
    }

    #[test]
    fn windows_resolver_falls_back_to_python3() {
        let resolved = resolve_python_with(None, true, |argv| match argv[0] {
            "python" | "py" => Ok((String::new(), String::new(), false)),
            "python3" => Ok((
                "__VES_PYTHON__=C:\\Python312\\python.exe".to_string(),
                String::new(),
                true,
            )),
            _ => panic!("unexpected candidate: {}", argv[0]),
        })
        .unwrap();

        assert_eq!(resolved, "C:\\Python312\\python.exe");
    }

    #[test]
    fn resolver_rejects_failed_explicit_python() {
        let error = resolve_python_with(Some("custom-python"), true, |_| {
            Ok((String::new(), "interpreter failed".to_string(), false))
        })
        .unwrap_err();

        assert!(error.contains("provided Python failed validation"));
        assert!(error.contains("interpreter failed"));
    }

    #[test]
    fn resolver_reports_all_failed_candidates() {
        let error = resolve_python_with(None, true, |argv| match argv[0] {
            "python" => Ok((String::new(), "store alias failed".to_string(), false)),
            "py" => Err("launcher missing".to_string()),
            "python3" => Ok((String::new(), String::new(), false)),
            _ => panic!("unexpected candidate: {}", argv[0]),
        })
        .unwrap_err();

        assert!(error.contains("no working Python 3 interpreter found"));
        assert!(error.contains("python, py -3, python3"));
        assert!(error.contains("python failed validation: store alias failed"));
        assert!(error.contains("launcher missing"));
        assert!(error.contains("python3 failed validation"));
    }

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
