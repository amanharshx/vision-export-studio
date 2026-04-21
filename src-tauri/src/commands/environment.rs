use std::process::Command;

#[derive(serde::Serialize)]
pub struct EnvironmentInfo {
    pub python_path: String,
    pub python_version: String,
    pub ultralytics_version: String,
    pub yolo_path: String,
    pub status: String,
    pub warnings: Vec<String>,
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
fn resolve_python(python_path: Option<&str>) -> Result<String, String> {
    if let Some(path) = python_path {
        // Validate the provided path by running --version.
        run(&[path, "--version"])
            .map_err(|e| format!("provided python path is not executable: {}", e))?;
        return Ok(path.to_string());
    }

    for candidate in &["python3", "python"] {
        if let Ok(_) = run(&[candidate, "--version"]) {
            return Ok(candidate.to_string());
        }
    }

    Err("no Python executable found; install Python 3 and ensure it is on PATH".to_string())
}

#[tauri::command]
pub fn detect_environment(python_path: Option<String>) -> Result<EnvironmentInfo, String> {
    let mut warnings: Vec<String> = Vec::new();

    // Step 1: resolve the Python executable.
    let resolved = resolve_python(python_path.as_deref())?;

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
                let hint = if !stderr.is_empty() {
                    format!(" ({})", stderr.lines().next().unwrap_or(""))
                } else {
                    String::new()
                };
                warnings.push(format!(
                    "ultralytics not importable{}; install with: pip install ultralytics",
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

    // Step 4: yolo_path via shutil.which inside the resolved Python.
    let yolo_path = {
        match run(&[
            &resolved,
            "-c",
            "import shutil; p = shutil.which('yolo'); print(p if p else '')",
        ]) {
            Ok((stdout, _, _)) if !stdout.is_empty() => stdout,
            Ok(_) => {
                warnings
                    .push("yolo CLI not found on PATH; install ultralytics to get it".to_string());
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
        "missing".to_string()
    } else if !ultralytics_version.is_empty() && !yolo_path.is_empty() {
        "ok".to_string()
    } else {
        "partial".to_string()
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
