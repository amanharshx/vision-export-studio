use std::path::{Path, PathBuf};
use std::process::Command;

use crate::commands::deps::{bootstrap_candidate_supported, bootstrap_requirement_label};
use crate::commands::environment::{
    collect_managed_runtime_candidates_with, managed_runtime_windows_location_candidates,
    probe_python_candidate, run, select_managed_runtime_python, PythonCandidate,
};
use crate::commands::provider_registry::{RFDETR_ROUTES, ULTRALYTICS_ROUTES};
use crate::commands::setup::{load_settings, venv_python_at};
use crate::commands::stack_environments::{known_stacks, stack_venv_dir_for_key};

pub(crate) const BOOTSTRAP_SOURCE_EXPLICIT: &str = "explicit-override";
pub(crate) const BOOTSTRAP_SOURCE_ULTRALYTICS: &str = "ultralytics-managed";
pub(crate) const BOOTSTRAP_SOURCE_DISCOVERED: &str = "discovered-system";

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct BootstrapIncompatible {
    pub source: String,
    pub python_path: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum BootstrapPythonResult {
    Available {
        python_path: String,
        source: String,
        version: String,
    },
    Missing {
        requirement: String,
        reason: String,
        incompatible: Vec<BootstrapIncompatible>,
    },
    InvalidOverride {
        python_path: String,
        source: String,
        reason: String,
        version: Option<String>,
        requirement: String,
    },
    Error {
        reason: String,
    },
}

fn version_string(candidate: &PythonCandidate) -> String {
    format!(
        "{}.{}.{}",
        candidate.major, candidate.minor, candidate.patch
    )
}

fn invalid_override(
    path: &str,
    reason: String,
    version: Option<String>,
    requirement: &str,
) -> BootstrapPythonResult {
    BootstrapPythonResult::InvalidOverride {
        python_path: path.to_string(),
        source: BOOTSTRAP_SOURCE_EXPLICIT.to_string(),
        reason,
        version,
        requirement: requirement.to_string(),
    }
}

/// One cohesive check: version policy (single owner in deps) plus real venv
/// capability. Returns the version on success so callers can build results
/// without re-probing.
enum Usability {
    Ready {
        executable: String,
        version: String,
    },
    WrongVersion {
        executable: String,
        version: String,
    },
    NoVenv {
        executable: String,
        version: String,
        error: String,
    },
}

fn check_usable(
    candidate: &PythonCandidate,
    route_id: &str,
    ensure_venv: &impl Fn(&str) -> Result<(), String>,
) -> Usability {
    let version = version_string(candidate);
    if !bootstrap_candidate_supported(route_id, candidate.major, candidate.minor) {
        return Usability::WrongVersion {
            executable: candidate.executable.clone(),
            version,
        };
    }
    match ensure_venv(&candidate.executable) {
        Ok(()) => Usability::Ready {
            executable: candidate.executable.clone(),
            version,
        },
        Err(error) => Usability::NoVenv {
            executable: candidate.executable.clone(),
            version,
            error,
        },
    }
}

/// Real venv capability: create an environment in a disposable temp dir and
/// remove it afterwards. Never installs packages anywhere.
fn ensure_venv_capability(python_exe: &str) -> Result<(), String> {
    let dir = std::env::temp_dir().join(format!("ves-bootstrap-venv-{}", uuid::Uuid::new_v4()));
    let status = Command::new(python_exe)
        .arg("-m")
        .arg("venv")
        .arg(&dir)
        .status()
        .map_err(|error| format!("cannot run {} -m venv: {}", python_exe, error))?;
    let _ = std::fs::remove_dir_all(&dir);
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "cannot create virtual environments ({} -m venv exited with code {:?})",
            python_exe,
            status.code()
        ))
    }
}

/// Resolve a bootstrap Python that can create the selected route's
/// app-owned environment.
///
/// Order: explicit override, existing Ultralytics managed Python, existing
/// compatible RF-DETR stack Python, then compatible discovered system Python.
///
/// The bootstrap interpreter is only used to run `python -m venv` for the
/// new isolated environment. Packages are never installed into it and
/// exports never run through it. An invalid or incompatible explicit
/// override is an actionable error; incompatible automatically discovered
/// candidates are skipped in favour of the next source.
///
/// Bounded discovery (standard installs, Homebrew, pyenv, Windows
/// launcher/install locations, PATH) is reused via
/// `collect_managed_runtime_candidates_with`. No uv/asdf/mise/Conda
/// discovery is added here.
pub(crate) fn resolve_bootstrap_python_with<F, V, D>(
    route_id: &str,
    explicit_override: Option<&str>,
    runtime_dir: &Path,
    probe: &F,
    ensure_venv: &V,
    discovered: &D,
) -> BootstrapPythonResult
where
    F: Fn(&[&str]) -> Result<(String, String, bool), String>,
    V: Fn(&str) -> Result<(), String>,
    D: Fn() -> Vec<PythonCandidate>,
{
    if route_id.trim().is_empty() {
        return BootstrapPythonResult::Error {
            reason: "route_id must not be empty".to_string(),
        };
    }
    if !(ULTRALYTICS_ROUTES.contains(&route_id) || RFDETR_ROUTES.contains(&route_id)) {
        return BootstrapPythonResult::Error {
            reason: format!("unknown route_id: {}", route_id),
        };
    }
    if runtime_dir.as_os_str().is_empty() {
        return BootstrapPythonResult::Error {
            reason: "managed runtime root must not be empty".to_string(),
        };
    }
    let requirement = bootstrap_requirement_label(route_id).to_string();
    let mut incompatible: Vec<BootstrapIncompatible> = Vec::new();
    let mut record = |source: &str, executable: String, version: String| {
        let entry = BootstrapIncompatible {
            source: source.to_string(),
            python_path: executable,
            version,
        };
        if !incompatible.contains(&entry) {
            incompatible.push(entry);
        }
    };

    if let Some(raw) = explicit_override {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            if (trimmed.contains('/') || trimmed.contains('\\')) && !Path::new(trimmed).exists() {
                return invalid_override(
                    trimmed,
                    format!("Python path does not exist: {}", trimmed),
                    None,
                    &requirement,
                );
            }
            let candidate = match probe_python_candidate(&[trimmed], probe) {
                Err(error) => {
                    return invalid_override(
                        trimmed,
                        format!("provided Python failed validation: {}", error),
                        None,
                        &requirement,
                    );
                }
                Ok(candidate) => candidate,
            };
            return match check_usable(&candidate, route_id, ensure_venv) {
                Usability::Ready {
                    executable,
                    version,
                } => BootstrapPythonResult::Available {
                    python_path: executable,
                    source: BOOTSTRAP_SOURCE_EXPLICIT.to_string(),
                    version,
                },
                Usability::WrongVersion {
                    executable: _,
                    version,
                } => invalid_override(
                    trimmed,
                    format!(
                        "Python {} is not supported for {}; requires {}.",
                        version, route_id, requirement
                    ),
                    Some(version),
                    &requirement,
                ),
                Usability::NoVenv { version, error, .. } => invalid_override(
                    trimmed,
                    format!("Python {} cannot create environments: {}", version, error),
                    Some(version),
                    &requirement,
                ),
            };
        }
    }

    // Existing environments in priority order: Ultralytics first, then each
    // known RF-DETR stack. One loop, one evaluation helper.
    let mut ordered: Vec<(String, String)> = Vec::new();
    let ultralytics = PathBuf::from(venv_python_at(&runtime_dir.join(".venv")));
    if ultralytics.exists() {
        if let Some(path) = ultralytics.to_str() {
            ordered.push((BOOTSTRAP_SOURCE_ULTRALYTICS.to_string(), path.to_string()));
        }
    }
    for stack in known_stacks() {
        if let Some(venv) = stack_venv_dir_for_key(runtime_dir, stack.key) {
            let python = venv_python_at(&venv);
            if Path::new(&python).exists() {
                ordered.push((stack.key.to_string(), python));
            }
        }
    }
    for (source, path) in &ordered {
        let Ok(candidate) = probe_python_candidate(&[path.as_str()], probe) else {
            continue;
        };
        match check_usable(&candidate, route_id, ensure_venv) {
            Usability::Ready {
                executable,
                version,
            } => {
                return BootstrapPythonResult::Available {
                    python_path: executable,
                    source: source.clone(),
                    version,
                };
            }
            Usability::WrongVersion {
                executable,
                version,
            }
            | Usability::NoVenv {
                executable,
                version,
                ..
            } => record(source, executable, version),
        }
    }

    // Discovered interpreters reuse the managed preference order by
    // repeatedly taking the existing selector's best remaining pick, so the
    // order is owned in exactly one place.
    let all = discovered();
    let mut remaining = all.clone();
    while let Some(best) = select_managed_runtime_python(remaining.clone()) {
        remaining.retain(|item| item.executable != best.executable);
        match check_usable(&best, route_id, ensure_venv) {
            Usability::Ready {
                executable,
                version,
            } => {
                return BootstrapPythonResult::Available {
                    python_path: executable,
                    source: BOOTSTRAP_SOURCE_DISCOVERED.to_string(),
                    version,
                };
            }
            Usability::WrongVersion {
                executable,
                version,
            }
            | Usability::NoVenv {
                executable,
                version,
                ..
            } => record(BOOTSTRAP_SOURCE_DISCOVERED, executable, version),
        }
    }
    // Anything the preference selector never picked (wrong route version or
    // outside the managed range) is still reported for the dialog.
    for candidate in all {
        record(
            BOOTSTRAP_SOURCE_DISCOVERED,
            candidate.executable.clone(),
            version_string(&candidate),
        );
    }

    BootstrapPythonResult::Missing {
        reason: format!(
            "no compatible {} interpreter found for {}; install {} and try again",
            requirement, route_id, requirement
        ),
        requirement,
        incompatible,
    }
}

#[tauri::command]
pub async fn resolve_bootstrap_python(
    app_handle: tauri::AppHandle,
    route_id: String,
    python_path_override: Option<String>,
) -> BootstrapPythonResult {
    let settings = match load_settings(app_handle) {
        Ok(settings) => settings,
        Err(error) => {
            return BootstrapPythonResult::Error { reason: error };
        }
    };
    let runtime_dir = PathBuf::from(settings.runtime_dir);
    let effective_override = python_path_override
        .or(settings.python_path_override)
        .unwrap_or_default();
    let override_opt =
        (!effective_override.trim().is_empty()).then_some(effective_override.as_str());
    resolve_bootstrap_python_with(
        &route_id,
        override_opt,
        &runtime_dir,
        &run,
        &ensure_venv_capability,
        &|| {
            collect_managed_runtime_candidates_with(
                cfg!(windows),
                managed_runtime_windows_location_candidates(),
                &run,
            )
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};
    use std::fs::{self, File};

    fn candidate(executable: &str, major: u8, minor: u8, patch: u8) -> PythonCandidate {
        PythonCandidate {
            executable: executable.to_string(),
            major,
            minor,
            patch,
        }
    }

    fn temp_runtime(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("ves-bootstrap-{}-{}", label, uuid::Uuid::new_v4()))
    }

    fn managed_path(runtime: &Path) -> PathBuf {
        PathBuf::from(venv_python_at(&runtime.join(".venv")))
    }

    fn stack_path(runtime: &Path, key: &str) -> PathBuf {
        stack_venv_dir_for_key(runtime, key)
            .map(|venv| PathBuf::from(venv_python_at(&venv)))
            .expect("known stack key")
    }

    fn touch(path: &Path) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        File::create(path).unwrap();
    }

    /// One fake for both dimensions: probed versions and venv capability.
    struct FakeEnv {
        versions: HashMap<String, (u8, u8, u8)>,
        probe_fail: HashSet<String>,
        venv_fail: HashSet<String>,
    }

    impl FakeEnv {
        fn new() -> Self {
            Self {
                versions: HashMap::new(),
                probe_fail: HashSet::new(),
                venv_fail: HashSet::new(),
            }
        }

        fn version(mut self, path: &str, major: u8, minor: u8, patch: u8) -> Self {
            self.versions
                .insert(path.to_string(), (major, minor, patch));
            self
        }

        fn probe_fail(mut self, path: &str) -> Self {
            self.probe_fail.insert(path.to_string());
            self
        }

        fn venv_fail(mut self, path: &str) -> Self {
            self.venv_fail.insert(path.to_string());
            self
        }

        fn probe(&self) -> impl Fn(&[&str]) -> Result<(String, String, bool), String> + '_ {
            move |argv: &[&str]| {
                // Bootstrap probes only; it never installs packages.
                assert!(
                    !argv
                        .iter()
                        .any(|arg| *arg == "pip" || arg.contains("install")),
                    "bootstrap must never install: {:?}",
                    argv
                );
                let path = argv.first().copied().unwrap_or_default();
                if self.probe_fail.contains(path) {
                    return Ok(("".to_string(), "interpreter crashed".to_string(), false));
                }
                match self.versions.get(path) {
                    Some((major, minor, patch)) => Ok((
                        format!(
                            "__VES_PYTHON__={}\n__VES_PYTHON_VERSION__={}.{}.{}",
                            path, major, minor, patch
                        ),
                        String::new(),
                        true,
                    )),
                    None => Err(format!("unexpected probe for {}", path)),
                }
            }
        }

        fn venv(&self) -> impl Fn(&str) -> Result<(), String> + '_ {
            move |exe: &str| {
                if self.venv_fail.contains(exe) {
                    return Err(format!("{} -m venv failed: no ensurepip", exe));
                }
                Ok(())
            }
        }

        fn resolve(
            &self,
            route: &str,
            override_opt: Option<&str>,
            runtime: &Path,
            discovered: Vec<PythonCandidate>,
        ) -> BootstrapPythonResult {
            resolve_bootstrap_python_with(
                route,
                override_opt,
                runtime,
                &self.probe(),
                &self.venv(),
                &|| discovered.clone(),
            )
        }
    }

    fn available(result: &BootstrapPythonResult) -> (&str, &str, &str) {
        match result {
            BootstrapPythonResult::Available {
                python_path,
                source,
                version,
            } => (python_path, source, version),
            other => panic!("expected available, got {:?}", other),
        }
    }

    fn invalid(result: &BootstrapPythonResult) -> (&str, &str, &str, Option<&str>, &str) {
        match result {
            BootstrapPythonResult::InvalidOverride {
                python_path,
                source,
                reason,
                version,
                requirement,
            } => (
                python_path,
                source,
                reason.as_str(),
                version.as_deref(),
                requirement.as_str(),
            ),
            other => panic!("expected invalid_override, got {:?}", other),
        }
    }

    /// Source priority: override > Ultralytics > RF-DETR stack > discovered.
    /// Each row names the sources present and the expected winner.
    #[test]
    fn source_priority_order() {
        // (name, with_override, with_managed, with_stack, with_discovered, expected_source, expected_version)
        let rows = [
            (
                "override wins",
                true,
                true,
                true,
                true,
                "explicit-override",
                "3.12.1",
            ),
            (
                "managed wins",
                false,
                true,
                true,
                true,
                "ultralytics-managed",
                "3.12.1",
            ),
            (
                "stack without managed",
                false,
                false,
                true,
                true,
                "rfdetr-default",
                "3.12.1",
            ),
            (
                "discovered fallback",
                false,
                false,
                false,
                true,
                "discovered-system",
                "3.12.0",
            ),
        ];
        for (
            name,
            with_override,
            with_managed,
            with_stack,
            with_discovered,
            expected,
            expected_version,
        ) in rows
        {
            let runtime = temp_runtime("priority");
            let override_exe = runtime.join("custom-python").to_string_lossy().into_owned();
            let managed_exe = managed_path(&runtime).to_string_lossy().into_owned();
            let stack_exe = stack_path(&runtime, "rfdetr-default")
                .to_string_lossy()
                .into_owned();
            if with_override {
                touch(Path::new(&override_exe));
            }
            if with_managed {
                touch(Path::new(&managed_exe));
            }
            if with_stack {
                touch(Path::new(&stack_exe));
            }
            let mut env = FakeEnv::new();
            for exe in [&override_exe, &managed_exe, &stack_exe] {
                env = env.version(exe, 3, 12, 1);
            }
            let discovered = if with_discovered {
                vec![candidate("/discovered", 3, 12, 0)]
            } else {
                vec![]
            };
            let result = env.resolve(
                "ultralytics.pt.onnx",
                with_override.then_some(override_exe.as_str()),
                &runtime,
                discovered,
            );
            let (_, source, version) = available(&result);
            assert_eq!(source, expected, "row {name}");
            assert_eq!(version, expected_version, "row {name}");
            let _ = fs::remove_dir_all(&runtime);
        }
    }

    /// Any unusable override is terminal: no fallback to the next source.
    #[test]
    fn invalid_override_never_falls_back() {
        // (name, setup_override, expected_reason_part)
        let rows = [
            ("missing file", "missing", "does not exist"),
            ("probe failure", "probe-fail", "failed validation"),
            ("wrong version", "wrong-version", "not supported"),
            ("no venv", "no-venv", "cannot create environments"),
        ];
        for (name, mode, reason_part) in rows {
            let runtime = temp_runtime("invalid");
            let managed_exe = managed_path(&runtime).to_string_lossy().into_owned();
            touch(Path::new(&managed_exe));
            let mut env = FakeEnv::new().version(&managed_exe, 3, 12, 0);
            let missing_path = runtime
                .join("does-not-exist/python")
                .to_string_lossy()
                .into_owned();
            let present_path = runtime
                .join("override-python")
                .to_string_lossy()
                .into_owned();
            let override_opt: Option<&str>;
            if mode == "missing" {
                // Never created: path contains '/' so existence is checked.
                override_opt = Some(&missing_path);
            } else {
                touch(Path::new(&present_path));
                override_opt = Some(&present_path);
                env = match mode {
                    "probe-fail" => env.probe_fail(&present_path),
                    "wrong-version" => env.version(&present_path, 3, 9, 6),
                    _ => env
                        .version(&present_path, 3, 12, 4)
                        .venv_fail(&present_path),
                };
            }
            let result = env.resolve(
                "ultralytics.pt.onnx",
                override_opt,
                &runtime,
                vec![candidate("/discovered", 3, 12, 0)],
            );
            let (_, source, reason, _, requirement) = invalid(&result);
            assert_eq!(source, "explicit-override", "row {name}");
            assert!(reason.contains(reason_part), "row {name}: {reason}");
            assert_eq!(requirement, "Python 3.10 through 3.13", "row {name}");
            let _ = fs::remove_dir_all(&runtime);
        }
    }

    /// Unusable automatic candidates are skipped in favour of the next source.
    #[test]
    fn broken_automatic_candidate_continues() {
        // (name, managed_mode, stack_mode, expected_source)
        // managed_mode: ok | version | probe | venv | absent
        // stack_mode: ok | version
        let rows = [
            ("managed wrong version", "version", "ok", "rfdetr-default"),
            ("managed probe failure", "probe", "ok", "rfdetr-default"),
            ("managed no venv", "venv", "ok", "rfdetr-default"),
            (
                "stack wrong version",
                "absent",
                "version",
                "discovered-system",
            ),
        ];
        for (name, managed_mode, stack_mode, expected) in rows {
            let runtime = temp_runtime("skip");
            let managed_exe = managed_path(&runtime).to_string_lossy().into_owned();
            if managed_mode != "absent" {
                touch(Path::new(&managed_exe));
            }
            let stack_exe = stack_path(&runtime, "rfdetr-default")
                .to_string_lossy()
                .into_owned();
            touch(Path::new(&stack_exe));
            let mut env = FakeEnv::new().version(&stack_exe, 3, 12, 2);
            if managed_mode != "absent" {
                env = env.version(&managed_exe, 3, 12, 0);
            }
            env = match managed_mode {
                "version" => {
                    env.versions.insert(managed_exe.clone(), (3, 9, 6));
                    env
                }
                "probe" => env.probe_fail(&managed_exe),
                "venv" => env.venv_fail(&managed_exe),
                _ => env,
            };
            if stack_mode == "version" {
                env.versions.insert(stack_exe.clone(), (3, 9, 6));
            }
            let result = env.resolve(
                "ultralytics.pt.onnx",
                None,
                &runtime,
                vec![candidate("/discovered", 3, 12, 5)],
            );
            let (_, source, _) = available(&result);
            assert_eq!(source, expected, "row {name}");
            let _ = fs::remove_dir_all(&runtime);
        }
    }

    /// The TFLite route accepts exactly 3.12 through every source.
    #[test]
    fn tflite_requires_exactly_312() {
        for (major, minor, ok) in [(3, 11, false), (3, 12, true), (3, 13, false)] {
            let runtime = temp_runtime("tflite");
            fs::create_dir_all(&runtime).unwrap();
            let env = FakeEnv::new();
            let result = env.resolve(
                "rfdetr.pth.tflite",
                None,
                &runtime,
                vec![candidate("/py", major, minor, 1)],
            );
            match (ok, &result) {
                (true, BootstrapPythonResult::Available { version, .. }) => {
                    assert_eq!(version, "3.12.1")
                }
                (false, BootstrapPythonResult::Missing { requirement, .. }) => {
                    assert_eq!(requirement, "Python 3.12")
                }
                _ => panic!("3.{minor}: unexpected {:?}", result),
            }
            let _ = fs::remove_dir_all(&runtime);
        }
    }

    /// Missing reports the requirement plus every found-but-unusable version.
    #[test]
    fn missing_reports_requirement_and_found_versions() {
        let runtime = temp_runtime("missing");
        let managed_exe = managed_path(&runtime).to_string_lossy().into_owned();
        touch(Path::new(&managed_exe));
        let env = FakeEnv::new().version(&managed_exe, 3, 9, 6);
        let result = env.resolve(
            "ultralytics.pt.onnx",
            None,
            &runtime,
            vec![candidate("/py314", 3, 14, 0)],
        );
        match &result {
            BootstrapPythonResult::Missing {
                requirement,
                reason,
                incompatible,
            } => {
                assert_eq!(requirement, "Python 3.10 through 3.13");
                assert!(reason.contains("ultralytics.pt.onnx"));
                assert!(incompatible
                    .iter()
                    .any(|item| item.version == "3.9.6" && item.source == "ultralytics-managed"));
                assert!(incompatible
                    .iter()
                    .any(|item| item.version == "3.14.0" && item.source == "discovered-system"));
            }
            other => panic!("expected missing, got {:?}", other),
        }
        let _ = fs::remove_dir_all(&runtime);
    }

    /// Unknown and empty routes are typed errors, not panics.
    #[test]
    fn unknown_route_is_typed_error() {
        let runtime = temp_runtime("route-error");
        fs::create_dir_all(&runtime).unwrap();
        let env = FakeEnv::new();
        for route in ["unknown.route", ""] {
            assert!(
                matches!(
                    env.resolve(route, None, &runtime, vec![]),
                    BootstrapPythonResult::Error { .. }
                ),
                "route {route:?}"
            );
        }
        let _ = fs::remove_dir_all(&runtime);
    }

    /// The real venv probe creates and cleans a temp env; failures surface.
    #[cfg(unix)]
    #[test]
    fn venv_capability_probe_creates_and_cleans() {
        use std::os::unix::fs::PermissionsExt;

        let root = temp_runtime("venvprobe");
        fs::create_dir_all(&root).unwrap();
        let passing = root.join("pass-python");
        let failing = root.join("fail-python");
        fs::write(&passing, "#!/bin/sh\nmkdir -p \"$3\"\nexit 0\n").unwrap();
        fs::write(&failing, "#!/bin/sh\nexit 1\n").unwrap();
        for path in [&passing, &failing] {
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        fn venv_dirs() -> HashSet<String> {
            fs::read_dir(std::env::temp_dir())
                .unwrap()
                .filter_map(|entry| {
                    entry.ok().and_then(|entry| {
                        entry.file_name().into_string().ok().filter(|name| {
                            name.starts_with("ves-bootstrap-venv-")
                                && std::env::temp_dir().join(name).exists()
                        })
                    })
                })
                .collect()
        }
        let before = venv_dirs();
        assert!(ensure_venv_capability(passing.to_str().unwrap()).is_ok());
        // The passing probe leaves no new residue behind.
        assert_eq!(venv_dirs(), before);
        assert!(ensure_venv_capability(failing.to_str().unwrap()).is_err());
        let _ = fs::remove_dir_all(&root);
    }
}
