use crate::commands::deps;
use crate::commands::setup::{load_settings, venv_python, venv_yolo};
use std::path::{Path, PathBuf};
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
const PYTHON_VERSION_PROBE_MARKER: &str = "__VES_PYTHON_VERSION__=";
const PYTHON_PROBE_SCRIPT: &str = "import os, sys; print('__VES_PYTHON__=' + os.path.abspath(sys.executable)); print('__VES_PYTHON_VERSION__={}.{}.{}'.format(*sys.version_info[:3])); raise SystemExit(0 if sys.version_info[0] == 3 else 1)";

const WINDOWS_PYTHON_CANDIDATES: &[&[&str]] = &[&["python"], &["py", "-3"], &["python3"]];
const UNIX_PYTHON_CANDIDATES: &[&[&str]] = &[&["python3"], &["python"]];

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PythonCandidate {
    pub executable: String,
    pub major: u8,
    pub minor: u8,
    pub patch: u8,
}

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

fn parse_python_probe_candidate(stdout: &str, success: bool) -> Option<PythonCandidate> {
    if !success {
        return None;
    }

    let executable = parse_python_probe(stdout, true)?;
    let version = stdout.lines().find_map(|line| {
        line.trim()
            .strip_prefix(PYTHON_VERSION_PROBE_MARKER)
            .and_then(|version| {
                let mut parts = version.trim().split('.');
                Some((
                    parts.next()?.parse().ok()?,
                    parts.next()?.parse().ok()?,
                    parts.next()?.parse().ok()?,
                ))
            })
    })?;

    Some(PythonCandidate {
        executable,
        major: version.0,
        minor: version.1,
        patch: version.2,
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

fn probe_python_candidate<F>(candidate: &[&str], runner: &F) -> Result<PythonCandidate, String>
where
    F: Fn(&[&str]) -> Result<(String, String, bool), String>,
{
    let mut argv = candidate.to_vec();
    argv.push("-c");
    argv.push(PYTHON_PROBE_SCRIPT);

    let (stdout, stderr, success) = runner(&argv)?;
    parse_python_probe_candidate(&stdout, success).ok_or_else(|| {
        let detail = first_line(&stderr)
            .or_else(|| first_line(&stdout))
            .unwrap_or("probe returned no valid Python 3 executable and version");
        format!("{} failed validation: {}", candidate.join(" "), detail)
    })
}

fn parse_windows_py_zero_p(output: &str) -> Vec<String> {
    output
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let remainder = line.strip_prefix('-')?;
            let (_, path) = remainder.split_once(char::is_whitespace)?;
            let path = path.trim().trim_start_matches('*').trim();
            (!path.is_empty()).then_some(path.to_string())
        })
        .collect()
}

fn directory_entries_matching(dir: &Path, prefix: &str) -> Vec<PathBuf> {
    let mut entries = std::fs::read_dir(dir)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(prefix))
        })
        .collect::<Vec<_>>();
    entries.sort();
    entries
}

fn unix_location_candidates(
    framework_versions: &Path,
    homebrew_bin: &Path,
    usr_local_bin: &Path,
    pyenv_versions: &Path,
) -> Vec<PathBuf> {
    let mut candidates = directory_entries_matching(framework_versions, "3.")
        .into_iter()
        .map(|version_dir| version_dir.join("bin/python3"))
        .filter(|path| path.is_file())
        .collect::<Vec<_>>();
    candidates.extend(
        directory_entries_matching(homebrew_bin, "python3.")
            .into_iter()
            .filter(|path| path.is_file()),
    );
    candidates.extend(
        directory_entries_matching(usr_local_bin, "python3.")
            .into_iter()
            .filter(|path| path.is_file()),
    );
    candidates.extend(
        directory_entries_matching(pyenv_versions, "")
            .into_iter()
            .map(|version_dir| version_dir.join("bin/python"))
            .filter(|path| path.is_file()),
    );
    candidates
}

fn windows_location_candidates(
    local_app_data: &Path,
    program_files: &Path,
    c_drive: &Path,
) -> Vec<PathBuf> {
    let mut candidates =
        directory_entries_matching(&local_app_data.join("Programs/Python"), "Python3")
            .into_iter()
            .map(|version_dir| version_dir.join("python.exe"))
            .filter(|path| path.is_file())
            .collect::<Vec<_>>();
    candidates.extend(
        directory_entries_matching(program_files, "Python3")
            .into_iter()
            .map(|version_dir| version_dir.join("python.exe"))
            .filter(|path| path.is_file()),
    );
    candidates.extend(
        directory_entries_matching(c_drive, "Python3")
            .into_iter()
            .map(|version_dir| version_dir.join("python.exe"))
            .filter(|path| path.is_file()),
    );
    candidates
}

// Prefer 3.12 because rfdetr[tflite] declares every dependency only for 3.12.
// Keep 3.14+ out: coremltools has wheels through cp313, not cp314. Python 3.10
// is floor because LiteRT, torch, and rfdetr require it or newer.
fn select_managed_runtime_python(candidates: Vec<PythonCandidate>) -> Option<PythonCandidate> {
    [(3, 12), (3, 13), (3, 11), (3, 10)]
        .iter()
        .find_map(|&(major, minor)| {
            candidates
                .iter()
                .find(|candidate| candidate.major == major && candidate.minor == minor)
                .cloned()
        })
}

fn discover_managed_runtime_python_candidate_with<F>(
    is_windows: bool,
    windows_locations: Vec<PathBuf>,
    runner: F,
) -> Option<PythonCandidate>
where
    F: Fn(&[&str]) -> Result<(String, String, bool), String>,
{
    let mut commands = Vec::<Vec<String>>::new();
    if is_windows {
        if let Ok((stdout, _, true)) = runner(&["py", "-0p"]) {
            commands.extend(
                parse_windows_py_zero_p(&stdout)
                    .into_iter()
                    .map(|path| vec![path]),
            );
        }
        commands.extend(
            windows_locations
                .into_iter()
                .filter_map(|path| path.to_str().map(|path| vec![path.to_string()])),
        );
    } else {
        let pyenv_versions = std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|home| home.join(".pyenv/versions"))
            .unwrap_or_default();
        commands.extend(
            unix_location_candidates(
                Path::new("/Library/Frameworks/Python.framework/Versions"),
                Path::new("/opt/homebrew/bin"),
                Path::new("/usr/local/bin"),
                &pyenv_versions,
            )
            .into_iter()
            .filter_map(|path| path.to_str().map(|path| vec![path.to_string()])),
        );
    }
    commands.extend(
        python_candidates(is_windows)
            .iter()
            .map(|candidate| candidate.iter().map(|arg| (*arg).to_string()).collect()),
    );

    let candidates = commands
        .iter()
        .filter_map(|command| {
            let argv = command.iter().map(String::as_str).collect::<Vec<_>>();
            probe_python_candidate(&argv, &runner).ok()
        })
        .collect();
    select_managed_runtime_python(candidates)
}

/// Discover compatible Python bases for new managed runtimes. Location discovery
/// precedes PATH because GUI-launched macOS apps do not inherit shell pyenv shims.
pub(crate) fn discover_managed_runtime_python() -> Option<String> {
    discover_managed_runtime_python_candidate_with(
        cfg!(windows),
        managed_runtime_windows_location_candidates(),
        run,
    )
    .map(|candidate| candidate.executable)
}

pub(crate) fn discover_managed_runtime_python_candidate() -> Option<PythonCandidate> {
    discover_managed_runtime_python_candidate_with(
        cfg!(windows),
        managed_runtime_windows_location_candidates(),
        run,
    )
}

fn managed_runtime_windows_location_candidates() -> Vec<PathBuf> {
    if !cfg!(windows) {
        return Vec::new();
    }

    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_default();
    let program_files = std::env::var_os("PROGRAMFILES")
        .map(PathBuf::from)
        .unwrap_or_default();
    windows_location_candidates(&local_app_data, &program_files, Path::new(r"C:\"))
}

/// Resolve an acceptable base for a managed runtime. Explicit paths are probed
/// and then held to the managed-runtime support policy.
pub(crate) fn resolve_managed_runtime_base(python_path: Option<&str>) -> Result<String, String> {
    if let Some(path) = python_path {
        let candidate = probe_python_candidate(&[path], &run)
            .map_err(|error| format!("provided Python failed validation: {}", error))?;
        return select_managed_runtime_python(vec![candidate])
            .map(|candidate| candidate.executable)
            .ok_or_else(|| {
                "provided Python is not supported for managed runtime setup; choose Python 3.10 through 3.13".to_string()
            });
    }

    discover_managed_runtime_python().ok_or_else(|| {
        "no compatible Python 3.10 through 3.13 interpreter found for managed runtime setup"
            .to_string()
    })
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

fn normalize_path_for_comparison(path: &str, is_windows: bool) -> String {
    let normalized = path.trim().trim_end_matches(['/', '\\']);
    if is_windows {
        normalized.replace('\\', "/").to_lowercase()
    } else {
        normalized.to_string()
    }
}

fn paths_equal(left: &str, right: &str, is_windows: bool) -> bool {
    normalize_path_for_comparison(left, is_windows)
        == normalize_path_for_comparison(right, is_windows)
}

fn detect_yolo_path(
    python_path: &str,
    managed_runtime_dir: Option<&str>,
) -> Result<String, String> {
    if let Some(runtime_dir) = managed_runtime_dir {
        let managed_python = venv_python(runtime_dir);
        if paths_equal(python_path, &managed_python, cfg!(windows)) {
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
        let version_code = deps::version_probe_code("ultralytics");
        match run(&[&resolved, "-c", &version_code]) {
            Ok((stdout, _, true)) if !stdout.is_empty() => {
                deps::last_version_line(&stdout).to_string()
            }
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
    use std::fs::{self, File};

    #[test]
    fn managed_runtime_ranking_prefers_supported_versions_in_order() {
        let select = |versions: &[(u8, u8)]| {
            select_managed_runtime_python(
                versions
                    .iter()
                    .map(|&(major, minor)| PythonCandidate {
                        executable: format!("/python{}.{}", major, minor),
                        major,
                        minor,
                        patch: 0,
                    })
                    .collect(),
            )
            .map(|candidate| (candidate.major, candidate.minor))
        };

        assert_eq!(select(&[(3, 9), (3, 12), (3, 13)]), Some((3, 12)));
        assert_eq!(select(&[(3, 13), (3, 11)]), Some((3, 13)));
        assert_eq!(select(&[(3, 10), (3, 14)]), Some((3, 10)));
        assert_eq!(select(&[(3, 14)]), None);
        assert_eq!(select(&[(3, 9)]), None);
        assert_eq!(select(&[]), None);
    }

    #[test]
    fn windows_py_zero_p_parser_skips_noise() {
        let output = "Installed Pythons found by py Launcher for Windows\r\n -3.13-64 * C:\\\\Users\\\\test\\\\AppData\\\\Local\\\\Programs\\\\Python\\\\Python313\\\\python.exe\r\nnot a version entry\r\n -V:3.12-64 C:\\\\Python312\\\\python.exe\r\n";

        assert_eq!(
            parse_windows_py_zero_p(output),
            vec![
                "C:\\\\Users\\\\test\\\\AppData\\\\Local\\\\Programs\\\\Python\\\\Python313\\\\python.exe",
                "C:\\\\Python312\\\\python.exe",
            ]
        );
    }

    #[test]
    fn unix_location_expansion_finds_known_install_paths() {
        let root =
            std::env::temp_dir().join(format!("ves-python-locations-{}", uuid::Uuid::new_v4()));
        let framework_versions = root.join("Library/Frameworks/Python.framework/Versions");
        let homebrew_bin = root.join("opt/homebrew/bin");
        let usr_local_bin = root.join("usr/local/bin");
        let pyenv_versions = root.join(".pyenv/versions");

        for path in [
            framework_versions.join("3.12/bin/python3"),
            homebrew_bin.join("python3.13"),
            usr_local_bin.join("python3.11"),
            pyenv_versions.join("3.10.14/bin/python"),
        ] {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            File::create(path).unwrap();
        }

        let candidates = unix_location_candidates(
            &framework_versions,
            &homebrew_bin,
            &usr_local_bin,
            &pyenv_versions,
        );
        let expected = vec![
            framework_versions.join("3.12/bin/python3"),
            homebrew_bin.join("python3.13"),
            usr_local_bin.join("python3.11"),
            pyenv_versions.join("3.10.14/bin/python"),
        ];
        assert_eq!(candidates, expected);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn windows_location_expansion_finds_known_install_paths() {
        let root = std::env::temp_dir().join(format!(
            "ves-windows-python-locations-{}",
            uuid::Uuid::new_v4()
        ));
        let local_app_data = root.join("LocalAppData");
        let program_files = root.join("ProgramFiles");
        let c_drive = root.join("C");

        for path in [
            local_app_data.join("Programs/Python/Python312/python.exe"),
            program_files.join("Python311/python.exe"),
            c_drive.join("Python310/python.exe"),
            local_app_data.join("Programs/Python/Python2.7/python.exe"),
            program_files.join("PythonXYZ/python.exe"),
        ] {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            File::create(path).unwrap();
        }
        fs::create_dir_all(program_files.join("Python312")).unwrap();

        assert_eq!(
            windows_location_candidates(&local_app_data, &program_files, &c_drive),
            vec![
                local_app_data.join("Programs/Python/Python312/python.exe"),
                program_files.join("Python311/python.exe"),
                c_drive.join("Python310/python.exe"),
            ]
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn windows_discovery_probes_launcher_before_location_candidates() {
        let root =
            std::env::temp_dir().join(format!("ves-windows-python-order-{}", uuid::Uuid::new_v4()));
        let local_app_data = root.join("LocalAppData");
        let program_files = root.join("ProgramFiles");
        let c_drive = root.join("C");
        let location = local_app_data.join("Programs/Python/Python312/python.exe");
        fs::create_dir_all(location.parent().unwrap()).unwrap();
        File::create(&location).unwrap();
        let location = location.to_str().unwrap().to_string();
        let calls = RefCell::new(Vec::<Vec<String>>::new());

        let resolved = discover_managed_runtime_python_candidate_with(
            true,
            windows_location_candidates(&local_app_data, &program_files, &c_drive),
            |argv| {
                calls
                    .borrow_mut()
                    .push(argv.iter().map(|arg| arg.to_string()).collect());
                if argv == ["py", "-0p"] {
                    return Ok((
                        " -3.13-64 C:\\Launcher\\python.exe".to_string(),
                        String::new(),
                        true,
                    ));
                }
                Ok((
                    format!("__VES_PYTHON__={}\n__VES_PYTHON_VERSION__=3.12.0", argv[0]),
                    String::new(),
                    true,
                ))
            },
        )
        .unwrap();

        assert_eq!(resolved.executable, "C:\\Launcher\\python.exe");
        let calls = calls.borrow();
        assert_eq!(calls[0], ["py", "-0p"]);
        assert_eq!(calls[1][0], "C:\\Launcher\\python.exe");
        assert_eq!(calls[2][0], location);

        fs::remove_dir_all(root).unwrap();
    }

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
    fn path_comparison_accepts_equivalent_windows_paths() {
        assert!(paths_equal(
            "C:\\Users\\HP\\.vision-export-studio\\.venv\\Scripts\\python.exe",
            "c:/users/hp/.vision-export-studio/.venv/Scripts/python.exe",
            true,
        ));
    }

    #[test]
    fn path_comparison_rejects_different_windows_environments() {
        assert!(!paths_equal(
            "C:\\Python310\\python.exe",
            "C:/Users/HP/.vision-export-studio/.venv/Scripts/python.exe",
            true,
        ));
    }

    #[test]
    fn path_comparison_keeps_unix_paths_case_sensitive() {
        assert!(!paths_equal(
            "/TMP/runtime/.venv/bin/python",
            "/tmp/runtime/.venv/bin/python",
            false,
        ));
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
