use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};
use std::str::FromStr;

use pep440_rs::Version;
use tauri::Emitter;
use uuid::Uuid;

use crate::commands::provider_registry::{
    validate_current_route_platform, validate_route_platform,
};
use crate::commands::runtime_operations::{
    emit_after_operation_released, RuntimeOperation, RuntimeOperationCoordinator,
};
use crate::commands::setup::{build_venv_command, load_settings};
use crate::commands::stack_environments::{stack_for_route, stack_python, stack_venv_dir};

// ---------------------------------------------------------------------------
// Runtime version floors
// ---------------------------------------------------------------------------

const MIN_ULTRALYTICS_VERSION: &str = "8.4.80";
const MIN_LITERT_ULTRALYTICS_VERSION: &str = "8.4.83";
const MIN_LITERT_PYTHON_VERSION: &str = "3.10";

/// Minimum Ultralytics version required by a route. None for non-Ultralytics routes.
fn minimum_ultralytics_version(route_id: &str) -> Option<&'static str> {
    if !route_id.starts_with("ultralytics.") {
        return None;
    }
    if route_id == "ultralytics.pt.litert" {
        return Some(MIN_LITERT_ULTRALYTICS_VERSION);
    }
    Some(MIN_ULTRALYTICS_VERSION)
}

/// Minimum Python version required by a route. Only LiteRT has a Python floor.
fn minimum_python_version(route_id: &str) -> Option<&'static str> {
    if route_id == "ultralytics.pt.litert" {
        return Some(MIN_LITERT_PYTHON_VERSION);
    }
    None
}

/// True when the installed version is below the required PEP 440 floor.
/// Unparseable versions are treated as below the floor so they block export.
fn version_below(installed: &str, required: &str) -> bool {
    match (Version::from_str(installed), Version::from_str(required)) {
        (Ok(installed), Ok(required)) => installed < required,
        _ => true,
    }
}

fn ultralytics_version_too_old_result(installed: &str, required: &str) -> DepCheckResult {
    DepCheckResult {
        item: "ultralytics".to_string(),
        status: "version_too_old".to_string(),
        reason: format!(
            "Ultralytics {} is installed; {} or newer is required.",
            installed, required
        ),
        install_hint: format!("pip install \"ultralytics>={}\"", required),
        install_package: Some(format!("ultralytics>={}", required)),
    }
}

fn python_version_too_old_result(installed: &str) -> DepCheckResult {
    DepCheckResult {
        item: "Python 3.10+".to_string(),
        status: "version_too_old".to_string(),
        reason: format!(
            "Python {} is selected; LiteRT requires Python 3.10 or newer.",
            installed
        ),
        install_hint: "Install/select Python 3.10 or newer, then re-detect the environment and recreate the export runtime.".to_string(),
        install_package: None,
    }
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
pub struct DepCheckResult {
    pub item: String,
    pub status: String,
    pub reason: String,
    pub install_hint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_package: Option<String>,
}

#[derive(serde::Serialize)]
pub struct DepCheckResponse {
    pub results: Vec<DepCheckResult>,
}

fn platform_unsupported_result(reason: String) -> DepCheckResult {
    DepCheckResult {
        item: "platform".to_string(),
        status: "platform_unsupported".to_string(),
        reason: reason.clone(),
        install_hint: reason,
        install_package: None,
    }
}

// ---------------------------------------------------------------------------
// Route dependency table
// TODO(Phase 5): verify parity with src/lib/routes.ts
// ---------------------------------------------------------------------------

struct PipDep {
    package_name: &'static str,
    install_hint: &'static str,
    /// When true, a missing package emits status "warning" instead of "missing_package".
    optional: bool,
}

struct SysDep {
    binary_name: &'static str,
    install_hint: &'static str,
}

struct RouteDeps {
    pip: &'static [PipDep],
    sys: &'static [SysDep],
}

fn route_deps(route_id: &str) -> Option<RouteDeps> {
    match route_id {
        "ultralytics.pt.torchscript" => Some(RouteDeps { pip: &[], sys: &[] }),
        "ultralytics.pt.onnx" => Some(RouteDeps {
            pip: &[
                PipDep {
                    package_name: "onnx",
                    install_hint: "pip install onnx",
                    optional: false,
                },
                PipDep {
                    package_name: "onnxslim",
                    install_hint: "pip install onnxslim",
                    // onnxslim is optional: the route note says "onnxslim optional"
                    optional: true,
                },
            ],
            sys: &[],
        }),
        "ultralytics.pt.openvino" => Some(RouteDeps {
            pip: &[
                PipDep {
                    package_name: "openvino",
                    install_hint: "pip install openvino",
                    optional: false,
                },
                PipDep {
                    package_name: "nncf",
                    install_hint: "pip install nncf",
                    optional: false,
                },
            ],
            sys: &[],
        }),
        "ultralytics.pt.coreml" => Some(RouteDeps {
            pip: &[PipDep {
                package_name: "coremltools",
                install_hint: "pip install coremltools",
                optional: false,
            }],
            sys: &[],
        }),
        "ultralytics.pt.ncnn" => Some(RouteDeps {
            pip: &[
                PipDep {
                    package_name: "ncnn",
                    install_hint: "pip install ncnn",
                    optional: false,
                },
                PipDep {
                    package_name: "pnnx",
                    install_hint: "pip install pnnx",
                    optional: false,
                },
            ],
            sys: &[],
        }),
        "ultralytics.pt.mnn" => Some(RouteDeps {
            pip: &[
                PipDep {
                    package_name: "MNN",
                    install_hint: "pip install MNN",
                    optional: false,
                },
                PipDep {
                    package_name: "onnx",
                    install_hint: "pip install onnx",
                    optional: false,
                },
            ],
            sys: &[],
        }),
        "ultralytics.pt.litert" => Some(RouteDeps {
            pip: &[
                PipDep {
                    package_name: "litert-torch>=0.9.0",
                    install_hint: "pip install \"ultralytics[export-litert]\"",
                    optional: false,
                },
                PipDep {
                    package_name: "ai-edge-litert>=2.1.4",
                    install_hint: "pip install \"ultralytics[export-litert]\"",
                    optional: false,
                },
            ],
            sys: &[],
        }),
        "ultralytics.pt.engine" => Some(RouteDeps {
            pip: &[PipDep {
                package_name: "tensorrt",
                install_hint: "pip install tensorrt",
                optional: false,
            }],
            sys: &[],
        }),
        "ultralytics.pt.rknn" => Some(RouteDeps {
            pip: &[
                PipDep {
                    package_name: "rknn-toolkit2",
                    install_hint: "pip install rknn-toolkit2",
                    optional: false,
                },
                PipDep {
                    package_name: "onnx",
                    install_hint: "pip install onnx",
                    optional: false,
                },
            ],
            sys: &[],
        }),
        "ultralytics.pt.executorch" => Some(RouteDeps {
            pip: &[PipDep {
                package_name: "executorch",
                install_hint: "pip install executorch",
                optional: false,
            }],
            sys: &[],
        }),
        "ultralytics.pt.edgetpu" => Some(RouteDeps {
            pip: &[
                PipDep {
                    package_name: "tensorflow",
                    install_hint: "pip install tensorflow",
                    optional: false,
                },
                PipDep {
                    package_name: "onnx2tf",
                    install_hint: "pip install onnx2tf",
                    optional: false,
                },
                PipDep {
                    package_name: "onnx",
                    install_hint: "pip install onnx",
                    optional: false,
                },
                PipDep {
                    package_name: "onnxruntime",
                    install_hint: "pip install onnxruntime",
                    optional: false,
                },
            ],
            sys: &[SysDep {
                binary_name: "edgetpu_compiler",
                install_hint: "Download from https://coral.ai/docs/edgetpu/compiler/#download",
            }],
        }),
        "ultralytics.pt.paddle" => Some(RouteDeps {
            pip: &[
                PipDep {
                    package_name: "paddlepaddle",
                    install_hint: "pip install paddlepaddle",
                    optional: false,
                },
                PipDep {
                    package_name: "x2paddle",
                    install_hint: "pip install x2paddle",
                    optional: false,
                },
            ],
            sys: &[],
        }),
        "ultralytics.pt.imx" => Some(RouteDeps {
            pip: &[
                PipDep {
                    package_name: "model-compression-toolkit",
                    install_hint: "pip install model-compression-toolkit",
                    optional: false,
                },
                PipDep {
                    package_name: "sony-custom-layers",
                    install_hint: "pip install sony-custom-layers",
                    optional: false,
                },
                PipDep {
                    package_name: "imx500-converter",
                    install_hint: "pip install imx500-converter",
                    optional: false,
                },
            ],
            sys: &[
                SysDep {
                    binary_name: "imxconv-pt",
                    install_hint: "pip install imx500-converter",
                },
                SysDep {
                    binary_name: "java",
                    install_hint: "Install Java >= 17: https://adoptium.net/",
                },
            ],
        }),
        "ultralytics.pt.axelera" => Some(RouteDeps {
            pip: &[PipDep {
                package_name: "axelera",
                install_hint: "pip install axelera-devkit",
                optional: false,
            }],
            sys: &[],
        }),
        "ultralytics.pt.saved_model" | "ultralytics.pt.pb" => Some(RouteDeps {
            pip: &[
                PipDep {
                    package_name: "tensorflow",
                    install_hint: "pip install tensorflow",
                    optional: false,
                },
                PipDep {
                    package_name: "onnx2tf",
                    install_hint: "pip install onnx2tf",
                    optional: false,
                },
                PipDep {
                    package_name: "onnx",
                    install_hint: "pip install onnx",
                    optional: false,
                },
                PipDep {
                    package_name: "onnxruntime",
                    install_hint: "pip install onnxruntime",
                    optional: false,
                },
            ],
            sys: &[],
        }),
        // RF-DETR routes
        "rfdetr.pth.onnx" => Some(RouteDeps {
            pip: &[PipDep {
                package_name: "rfdetr",
                install_hint: "pip install \"rfdetr[onnx]\"",
                optional: false,
            }],
            sys: &[],
        }),
        "rfdetr.pth.engine" => Some(RouteDeps {
            pip: &[PipDep {
                package_name: "rfdetr",
                install_hint: "pip install \"rfdetr[onnx]\"",
                optional: false,
            }],
            sys: &[SysDep {
                binary_name: "trtexec",
                install_hint: "Install NVIDIA TensorRT and ensure trtexec is on PATH.",
            }],
        }),
        _ => None,
    }
}

fn validate_install_route_platform(route_id: &str, os: &str, arch: &str) -> Result<(), String> {
    route_deps(route_id).ok_or_else(|| format!("unknown route_id: {}", route_id))?;
    validate_route_platform(route_id, os, arch)
}

// ---------------------------------------------------------------------------
// Importable-name mapping
// ---------------------------------------------------------------------------

/// Convert a pip package name to the Python importable name used with
/// importlib.util.find_spec. Version/extra specifiers are stripped first.
fn importable_name(package_name: &str) -> String {
    let base = package_name
        .split(|c: char| ['[', '>', '<', '=', '!', '~', ',', ' '].contains(&c))
        .next()
        .unwrap_or(package_name)
        .trim();
    match base {
        "paddlepaddle" => "paddle".to_string(),
        "rknn-toolkit2" => "rknn".to_string(),
        "model-compression-toolkit" => "model_compression_toolkit".to_string(),
        "sony-custom-layers" => "sony_custom_layers".to_string(),
        "imx500-converter" => "imx500_converter".to_string(),
        // axelera is already the importable name used in routes.ts pipDeps
        "axelera" => "axelera".to_string(),
        // MNN preserves case
        "MNN" => "MNN".to_string(),
        // General rule: replace hyphens with underscores
        other => other.replace('-', "_"),
    }
}

// ---------------------------------------------------------------------------
// Probe helper
// ---------------------------------------------------------------------------

/// Run `python -c <code>` and return trimmed stdout.
/// Returns Err when the process cannot be spawned or exits with a non-zero status.
fn probe(python: &str, code: &str) -> Result<String, String> {
    let output = Command::new(python)
        .arg("-c")
        .arg(code)
        .output()
        .map_err(|e| format!("failed to spawn probe: {}", e))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!(
            "python probe exited {:?}: {}",
            output.status.code(),
            err
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Return the selected interpreter's version (e.g. "3.9.6").
fn probe_python_version(python: &str) -> Result<String, String> {
    probe(python, "import platform; print(platform.python_version())")
}

/// Python snippet that prints a distribution version without importing the
/// package. Falls back to the module's `__version__` when metadata is absent.
/// Assumes the distribution name matches the importable name, which holds for
/// the only caller (`ultralytics`).
pub(crate) fn version_probe_code(importable: &str) -> String {
    format!(
        "import importlib.metadata as _m\n\
         try:\n\
         \x20   _v = _m.version(\"{name}\")\n\
         except Exception:\n\
         \x20   import {name} as _p\n\
         \x20   _v = _p.__version__\n\
         print(_v)",
        name = importable
    )
}

/// Last non-empty line of probe output, trimmed. Probe stdout can carry
/// warning banners ahead of the value (Ultralytics logs to stdout).
pub(crate) fn last_version_line(raw: &str) -> &str {
    raw.lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .unwrap_or("")
}

/// Return the installed version of an importable module (e.g. "8.4.79").
fn probe_installed_version(python: &str, importable: &str) -> Result<String, String> {
    probe(python, &version_probe_code(importable)).map(|out| last_version_line(&out).to_string())
}

// ---------------------------------------------------------------------------
// check_dependencies command
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn check_dependencies(
    app_handle: tauri::AppHandle,
    route_id: String,
    python_path: String,
) -> Result<DepCheckResponse, String> {
    // Validate inputs.
    if route_id.is_empty() {
        return Err("route_id must not be empty".to_string());
    }
    if python_path.is_empty() {
        return Err("python_path must not be empty".to_string());
    }

    let stack_runtime_dir = if stack_for_route(&route_id).is_some() {
        Some(load_settings(app_handle)?.runtime_dir)
    } else {
        None
    };

    check_dependencies_for_runtime(&route_id, &python_path, stack_runtime_dir.as_deref())
}

fn check_dependencies_for_runtime(
    route_id: &str,
    python_path: &str,
    stack_runtime_dir: Option<&str>,
) -> Result<DepCheckResponse, String> {
    let deps = route_deps(route_id).ok_or_else(|| format!("unknown route_id: {}", route_id))?;

    if stack_for_route(route_id).is_none() {
        // For bare names like "python3" skip the existence check; they live on PATH.
        let python_is_path = python_path.contains('/') || python_path.contains('\\');
        if python_is_path && !Path::new(python_path).exists() {
            return Err(format!("python executable not found: {}", python_path));
        }
    }

    if let Err(reason) = validate_current_route_platform(route_id) {
        return Ok(DepCheckResponse {
            results: vec![platform_unsupported_result(reason)],
        });
    }

    let dependency_python = if stack_for_route(route_id).is_some() {
        let runtime_dir = stack_runtime_dir.expect("mapped route has a runtime directory");
        if let Some(results) = missing_stack_results_if_absent(runtime_dir, route_id) {
            return Ok(DepCheckResponse { results });
        }
        stack_python(runtime_dir, route_id).expect("mapped route has Python path")
    } else {
        python_path.to_string()
    };

    let mut results: Vec<DepCheckResult> = Vec::new();

    // LiteRT Python floor: below 3.10 this is the only blocker and LiteRT package
    // checks are skipped entirely to avoid predictable pip failures.
    if let Some(required_python) = minimum_python_version(route_id) {
        if let Ok(installed_python) = probe_python_version(&dependency_python) {
            if version_below(&installed_python, required_python) {
                return Ok(DepCheckResponse {
                    results: vec![python_version_too_old_result(&installed_python)],
                });
            }
        }
    }

    // Check ultralytics only for Ultralytics routes.
    if route_id.starts_with("ultralytics.") {
        let required = minimum_ultralytics_version(route_id)
            .expect("ultralytics routes always declare a minimum version");
        results.push(check_ultralytics_dep(&dependency_python, required));
    }

    // Check route pip deps — RF-DETR routes use probe-based checks for extras.
    if route_id == "rfdetr.pth.onnx" || route_id == "rfdetr.pth.engine" {
        results.push(check_python_probe_dep(
            &dependency_python,
            "rfdetr[onnx]",
            "import importlib.util; ok = importlib.util.find_spec('rfdetr') is not None and importlib.util.find_spec('onnx') is not None; print(ok)",
            "pip install \"rfdetr[onnx]\"",
            "rfdetr[onnx]",
        ));
    } else {
        for dep in deps.pip {
            let result = check_pip_dep(
                &dependency_python,
                dep.package_name,
                dep.install_hint,
                dep.optional,
            );
            results.push(result);
        }
    }

    // Check route sys deps.
    for dep in deps.sys {
        let result = check_sys_dep(&dependency_python, dep.binary_name, dep.install_hint);
        results.push(result);
    }

    Ok(DepCheckResponse { results })
}

fn stack_paths_from_settings(
    app_handle: &tauri::AppHandle,
    route_id: &str,
) -> Result<Option<(std::path::PathBuf, String)>, String> {
    let settings = load_settings(app_handle.clone())?;
    Ok(stack_venv_dir(&settings.runtime_dir, route_id)
        .zip(stack_python(&settings.runtime_dir, route_id)))
}

fn missing_stack_results(route_id: &str) -> Option<Vec<DepCheckResult>> {
    match route_id {
        "rfdetr.pth.onnx" | "rfdetr.pth.engine" => Some(vec![DepCheckResult {
            item: "rfdetr[onnx]".to_string(),
            status: "missing_package".to_string(),
            reason: "RF-DETR stack environment has not been created.".to_string(),
            install_hint: "pip install \"rfdetr[onnx]\"".to_string(),
            install_package: Some("rfdetr[onnx]".to_string()),
        }]),
        _ => None,
    }
}

fn missing_stack_results_if_absent(
    runtime_dir: &str,
    route_id: &str,
) -> Option<Vec<DepCheckResult>> {
    let stack_python = stack_python(runtime_dir, route_id)?;
    (!Path::new(&stack_python).exists())
        .then(|| missing_stack_results(route_id).expect("mapped stack has dependencies"))
}

// ---------------------------------------------------------------------------
// Per-dep check helpers
// ---------------------------------------------------------------------------

/// Version-aware Ultralytics check for Ultralytics routes.
///
/// When Ultralytics is absent, the ordinary missing-package remedy is overridden
/// with the route minimum so a fresh install lands on the required floor instead
/// of a bare `ultralytics`. When it is present but below the floor, the result
/// becomes `version_too_old` with an explicit pinned `install_package`.
fn check_ultralytics_dep(python: &str, required: &str) -> DepCheckResult {
    let install_hint = format!("pip install \"ultralytics>={}\"", required);
    let install_package = Some(format!("ultralytics>={}", required));
    let presence = check_pip_dep(python, "ultralytics", &install_hint, false);

    match presence.status.as_str() {
        "ready" => match probe_installed_version(python, "ultralytics") {
            Ok(installed) if !version_below(&installed, required) => presence,
            Ok(installed) => ultralytics_version_too_old_result(&installed, required),
            Err(_) => ultralytics_version_too_old_result("unknown", required),
        },
        "missing_package" => DepCheckResult {
            item: presence.item,
            status: presence.status,
            reason: presence.reason,
            install_hint,
            install_package,
        },
        _ => presence,
    }
}

fn check_pip_dep(
    python: &str,
    package_name: &str,
    install_hint: &str,
    optional: bool,
) -> DepCheckResult {
    let imp = importable_name(package_name);
    let code = format!(
        "import importlib.util; print(importlib.util.find_spec('{}') is not None)",
        imp
    );
    match probe(python, &code) {
        Err(e) => DepCheckResult {
            item: package_name.to_string(),
            status: "unknown".to_string(),
            reason: format!("probe failed: {}", e),
            install_hint: install_hint.to_string(),
            install_package: None,
        },
        Ok(out) => {
            if out == "True" {
                DepCheckResult {
                    item: package_name.to_string(),
                    status: "ready".to_string(),
                    reason: String::new(),
                    install_hint: install_hint.to_string(),
                    install_package: None,
                }
            } else if optional {
                DepCheckResult {
                    item: package_name.to_string(),
                    status: "warning".to_string(),
                    reason: "optional: improves model portability".to_string(),
                    install_hint: install_hint.to_string(),
                    install_package: None,
                }
            } else {
                DepCheckResult {
                    item: package_name.to_string(),
                    status: "missing_package".to_string(),
                    reason: format!("importlib.util.find_spec('{}') returned False", imp),
                    install_hint: install_hint.to_string(),
                    install_package: Some(package_name.to_string()),
                }
            }
        }
    }
}

fn check_python_probe_dep(
    python: &str,
    item: &str,
    code: &str,
    install_hint: &str,
    install_package: &str,
) -> DepCheckResult {
    match probe(python, code) {
        Err(e) => DepCheckResult {
            item: item.to_string(),
            status: "missing_package".to_string(),
            reason: format!("probe failed: {}", e),
            install_hint: install_hint.to_string(),
            install_package: Some(install_package.to_string()),
        },
        Ok(out) if out == "True" => DepCheckResult {
            item: item.to_string(),
            status: "ready".to_string(),
            reason: String::new(),
            install_hint: install_hint.to_string(),
            install_package: None,
        },
        Ok(out) => DepCheckResult {
            item: item.to_string(),
            status: "missing_package".to_string(),
            reason: format!("probe returned {}", out),
            install_hint: install_hint.to_string(),
            install_package: Some(install_package.to_string()),
        },
    }
}

// ---------------------------------------------------------------------------
// install_dependencies — payload types
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, Clone)]
struct InstallLinePayload {
    session_id: String,
    line: String,
}

#[derive(serde::Serialize, Clone)]
struct InstallFinishedPayload {
    session_id: String,
}

#[derive(serde::Serialize, Clone)]
struct InstallFailedPayload {
    session_id: String,
    error: String,
}

// ---------------------------------------------------------------------------
// Package name validation
// ---------------------------------------------------------------------------

/// Accept only characters valid in a PyPI package name or version specifier.
/// Rejects anything that could be used for argument injection.
fn validate_package_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("package name must not be empty".to_string());
    }
    if !name.chars().all(|c| {
        c.is_alphanumeric()
            || c == '-'
            || c == '_'
            || c == '.'
            || c == '['
            || c == ']'
            || c == ','
            || c == '>'
            || c == '<'
            || c == '='
            || c == '!'
            || c == '~'
            || c == '*'
    }) {
        return Err(format!("invalid package name: {}", name));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// install_dependencies command
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn install_dependencies(
    app_handle: tauri::AppHandle,
    runtime_operations: tauri::State<'_, RuntimeOperationCoordinator>,
    route_id: Option<String>,
    packages: Vec<String>,
    python_path: String,
) -> Result<String, String> {
    // Enforce platform compatibility before any package-manager command runs.
    // Route-scoped installs (route_id = Some) must not proceed on an unsupported
    // OS/architecture. The route-agnostic base runtime install (route_id = None,
    // e.g. `ultralytics`) is installable on every platform and is not gated.
    if let Some(route_id) = route_id.as_deref() {
        validate_install_route_platform(route_id, std::env::consts::OS, std::env::consts::ARCH)?;
    }
    if python_path.is_empty() {
        return Err("python_path must not be empty".to_string());
    }
    let python_is_path = python_path.contains('/') || python_path.contains('\\');
    if python_is_path && !Path::new(&python_path).exists() {
        return Err(format!("python executable not found: {}", python_path));
    }
    if packages.is_empty() {
        return Err("packages must not be empty".to_string());
    }
    for pkg in &packages {
        validate_package_name(pkg)?;
    }
    let operation_guard = runtime_operations.acquire(RuntimeOperation::Install)?;

    let install_python = if let Some(route_id) = route_id.as_deref() {
        if let Some((stack_venv, stack_python)) = stack_paths_from_settings(&app_handle, route_id)?
        {
            if !Path::new(&stack_python).exists() {
                let status = build_venv_command(&python_path, &stack_venv)
                    .status()
                    .map_err(|e| format!("failed to create RF-DETR environment: {}", e))?;
                if !status.success() {
                    return Err(format!(
                        "failed to create RF-DETR environment: exit code {:?}",
                        status.code()
                    ));
                }
            }
            stack_python
        } else {
            python_path.clone()
        }
    } else {
        python_path.clone()
    };

    // Build argv: python -m pip install pkg1 pkg2 ...
    let mut cmd = build_pip_install_command(&install_python, &packages);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn pip: {}", e))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "no stdout handle".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "no stderr handle".to_string())?;

    let session_id = Uuid::new_v4().to_string();

    // stdout reader thread
    let ah_stdout = app_handle.clone();
    let sid_stdout = session_id.clone();
    let stdout_handle = std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(l) => {
                    let _ = ah_stdout.emit(
                        "install:stdout",
                        InstallLinePayload {
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
                        "install:stderr",
                        InstallLinePayload {
                            session_id: sid_stderr.clone(),
                            line: l,
                        },
                    );
                }
                Err(_) => break,
            }
        }
    });

    // waiter thread — joins readers then waits on child
    let ah_wait = app_handle.clone();
    let sid_wait = session_id.clone();
    std::thread::spawn(move || {
        let operation_guard = operation_guard;
        let _ = stdout_handle.join();
        let _ = stderr_handle.join();

        match child.wait() {
            Ok(status) => {
                if status.success() {
                    emit_after_operation_released(operation_guard, || {
                        let _ = ah_wait.emit(
                            "install:finished",
                            InstallFinishedPayload {
                                session_id: sid_wait,
                            },
                        );
                    });
                } else {
                    let code = status.code().unwrap_or(-1);
                    emit_after_operation_released(operation_guard, || {
                        let _ = ah_wait.emit(
                            "install:failed",
                            InstallFailedPayload {
                                session_id: sid_wait,
                                error: format!("pip exited with code {}", code),
                            },
                        );
                    });
                }
            }
            Err(e) => {
                emit_after_operation_released(operation_guard, || {
                    let _ = ah_wait.emit(
                        "install:failed",
                        InstallFailedPayload {
                            session_id: sid_wait,
                            error: format!("wait error: {}", e),
                        },
                    );
                });
            }
        }
    });

    Ok(session_id)
}

fn build_pip_install_command(python: &str, packages: &[String]) -> Command {
    let mut cmd = Command::new(python);
    cmd.args(["-m", "pip", "install"]);
    cmd.args(packages);
    cmd
}

// ---------------------------------------------------------------------------

fn check_sys_dep(python: &str, binary_name: &str, install_hint: &str) -> DepCheckResult {
    // Escape single quotes in binary_name defensively; binary names should
    // never contain them, but guard anyway.
    let safe_name = binary_name.replace('\'', "");
    let code = format!("import shutil; print(shutil.which('{}') or '')", safe_name);
    match probe(python, &code) {
        Err(e) => DepCheckResult {
            item: binary_name.to_string(),
            status: "unknown".to_string(),
            reason: format!("probe failed: {}", e),
            install_hint: install_hint.to_string(),
            install_package: None,
        },
        Ok(out) => {
            if out.is_empty() {
                DepCheckResult {
                    item: binary_name.to_string(),
                    status: "missing_binary".to_string(),
                    reason: format!("shutil.which('{}') returned None", binary_name),
                    install_hint: install_hint.to_string(),
                    install_package: None,
                }
            } else {
                DepCheckResult {
                    item: binary_name.to_string(),
                    status: "ready".to_string(),
                    reason: String::new(),
                    install_hint: install_hint.to_string(),
                    install_package: None,
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paddlepaddle_distribution_maps_to_paddle_import() {
        assert_eq!(importable_name("paddlepaddle"), "paddle");
    }

    #[test]
    fn paddle_route_installs_paddlepaddle_distribution() {
        let deps = route_deps("ultralytics.pt.paddle").expect("route deps");
        assert_eq!(deps.pip[0].package_name, "paddlepaddle");
        assert_eq!(deps.pip[0].install_hint, "pip install paddlepaddle");
    }

    #[test]
    fn litert_route_has_two_pip_deps_and_no_system_binaries() {
        let deps = route_deps("ultralytics.pt.litert").expect("route deps");
        assert!(deps.sys.is_empty());
        let names: Vec<&str> = deps.pip.iter().map(|d| d.package_name).collect();
        assert_eq!(names, vec!["litert-torch>=0.9.0", "ai-edge-litert>=2.1.4"]);
        for dep in deps.pip {
            assert_eq!(
                dep.install_hint,
                "pip install \"ultralytics[export-litert]\""
            );
            assert!(!dep.optional);
        }
    }

    #[test]
    fn removed_tfjs_and_ultralytics_tflite_deps_are_unknown() {
        assert!(route_deps("ultralytics.pt.tfjs").is_none());
        assert!(route_deps("ultralytics.pt.tflite").is_none());
    }

    #[test]
    fn litert_import_names_strip_version_specifiers() {
        assert_eq!(importable_name("litert-torch>=0.9.0"), "litert_torch");
        assert_eq!(importable_name("ai-edge-litert>=2.1.4"), "ai_edge_litert");
    }

    #[test]
    fn litert_dependency_install_gates_export_host() {
        assert!(
            validate_install_route_platform("ultralytics.pt.litert", "macos", "x86_64").is_ok()
        );
        assert!(
            validate_install_route_platform("ultralytics.pt.litert", "macos", "aarch64").is_ok()
        );
        assert!(
            validate_install_route_platform("ultralytics.pt.litert", "linux", "x86_64").is_ok()
        );
        assert!(
            validate_install_route_platform("ultralytics.pt.litert", "windows", "x86_64").is_err()
        );
        assert!(
            validate_install_route_platform("ultralytics.pt.litert", "linux", "aarch64").is_err()
        );
    }

    #[test]
    fn litert_package_specs_survive_validation() {
        assert!(validate_package_name("litert-torch>=0.9.0").is_ok());
        assert!(validate_package_name("ai-edge-litert>=2.1.4").is_ok());
    }

    #[test]
    fn rfdetr_onnx_route_uses_rfdetr_extra_hint() {
        let deps = route_deps("rfdetr.pth.onnx").expect("route deps");
        assert_eq!(deps.pip[0].package_name, "rfdetr");
        assert_eq!(deps.pip[0].install_hint, "pip install \"rfdetr[onnx]\"");
    }

    #[test]
    fn rfdetr_tflite_route_is_unknown() {
        assert!(route_deps("rfdetr.pth.tflite").is_none());
    }

    #[test]
    fn rfdetr_engine_route_requires_trtexec() {
        let deps = route_deps("rfdetr.pth.engine").expect("route deps");
        assert_eq!(deps.sys[0].binary_name, "trtexec");
    }

    #[test]
    fn rfdetr_extra_install_package_survives_validation() {
        assert!(validate_package_name("rfdetr").is_ok());
        assert!(validate_package_name("rfdetr[onnx]").is_ok());
    }

    #[test]
    fn absent_rfdetr_stack_returns_installable_missing_results() {
        let runtime = std::env::temp_dir().join(format!("rfdetr-stack-{}", Uuid::new_v4()));
        let runtime = runtime.to_string_lossy();
        let results = missing_stack_results_if_absent(&runtime, "rfdetr.pth.onnx")
            .expect("RF-DETR stack results");

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].status, "missing_package");
        assert_eq!(results[0].install_package.as_deref(), Some("rfdetr[onnx]"));
        assert!(!stack_venv_dir(&runtime, "rfdetr.pth.onnx")
            .unwrap()
            .exists());
    }

    #[test]
    fn existing_rfdetr_stack_ignores_missing_base_python() {
        let runtime = std::env::temp_dir().join(format!("rfdetr-stack-{}", Uuid::new_v4()));
        let runtime = runtime.to_string_lossy().into_owned();
        let stack_python = stack_python(&runtime, "rfdetr.pth.onnx").unwrap();
        std::fs::create_dir_all(Path::new(&stack_python).parent().unwrap()).unwrap();
        std::fs::write(&stack_python, b"not a Python interpreter").unwrap();

        let response = check_dependencies_for_runtime(
            "rfdetr.pth.onnx",
            "/missing/base/python",
            Some(&runtime),
        )
        .expect("RF-DETR check uses existing stack, not base Python");

        assert_eq!(response.results[0].status, "missing_package");
        assert_eq!(
            response.results[0].install_package.as_deref(),
            Some("rfdetr[onnx]")
        );
        std::fs::remove_dir_all(runtime).unwrap();
    }

    #[test]
    fn ultralytics_check_rejects_missing_base_python() {
        let error = match check_dependencies_for_runtime(
            "ultralytics.pt.onnx",
            "/missing/base/python",
            None,
        ) {
            Err(error) => error,
            Ok(_) => panic!("Ultralytics check must validate base Python"),
        };

        assert_eq!(error, "python executable not found: /missing/base/python");
    }

    #[test]
    fn rfdetr_install_command_targets_stack_python() {
        let command = build_pip_install_command(
            "/tmp/runtime/envs/rfdetr-default/.venv/bin/python",
            &["rfdetr[onnx]".to_string()],
        );

        assert_eq!(
            command.get_program(),
            "/tmp/runtime/envs/rfdetr-default/.venv/bin/python"
        );
    }

    #[test]
    fn ultralytics_install_command_keeps_base_python() {
        let command =
            build_pip_install_command("/tmp/runtime/.venv/bin/python", &["onnx".to_string()]);

        assert_eq!(command.get_program(), "/tmp/runtime/.venv/bin/python");
    }

    #[test]
    fn rfdetr_install_creates_stack_from_base_then_pips_into_stack() {
        let stack_venv = stack_venv_dir("/tmp/runtime", "rfdetr.pth.onnx").unwrap();
        let create = build_venv_command("/base/python", &stack_venv);
        let install = build_pip_install_command(
            &stack_python("/tmp/runtime", "rfdetr.pth.onnx").unwrap(),
            &["rfdetr[onnx]".to_string()],
        );

        assert_eq!(create.get_program(), "/base/python");
        assert_eq!(
            install.get_program(),
            std::ffi::OsStr::new(&stack_python("/tmp/runtime", "rfdetr.pth.onnx").unwrap())
        );
    }

    #[test]
    fn package_validation_allows_safe_extras() {
        assert!(validate_package_name("rfdetr[onnx]").is_ok());
        assert!(validate_package_name("rfdetr[onnx,tflite]").is_ok());
        assert!(validate_package_name("rfdetr[onnx];rm").is_err());
    }

    #[test]
    fn unsupported_platform_result_blocks_dependency_flow() {
        let result =
            platform_unsupported_result("This format is not supported on Linux ARM64.".to_string());

        assert_eq!(result.item, "platform");
        assert_eq!(result.status, "platform_unsupported");
        assert!(result.reason.contains("Linux ARM64"));
        assert!(result.install_package.is_none());
    }

    #[test]
    fn dependency_install_rejects_edge_tpu_on_arm_linux() {
        assert!(
            validate_install_route_platform("ultralytics.pt.edgetpu", "linux", "aarch64").is_err()
        );
    }

    #[test]
    fn dependency_install_rejects_unknown_route() {
        assert!(validate_install_route_platform("unknown.route", "linux", "x86_64").is_err());
    }

    #[test]
    fn dependency_install_allows_supported_route_platform() {
        assert!(
            validate_install_route_platform("ultralytics.pt.edgetpu", "linux", "x86_64").is_ok()
        );
        assert!(
            validate_install_route_platform("ultralytics.pt.paddle", "macos", "aarch64").is_ok()
        );
    }

    #[test]
    fn minimum_ultralytics_version_is_route_aware() {
        assert_eq!(
            minimum_ultralytics_version("ultralytics.pt.onnx"),
            Some("8.4.80")
        );
        assert_eq!(
            minimum_ultralytics_version("ultralytics.pt.litert"),
            Some("8.4.83")
        );
        assert_eq!(minimum_ultralytics_version("rfdetr.pth.onnx"), None);
    }

    #[test]
    fn minimum_python_version_is_litert_only() {
        assert_eq!(
            minimum_python_version("ultralytics.pt.litert"),
            Some("3.10")
        );
        assert_eq!(minimum_python_version("ultralytics.pt.onnx"), None);
        assert_eq!(minimum_python_version("rfdetr.pth.onnx"), None);
    }

    #[test]
    fn pep440_comparison_handles_pre_releases_and_patch_levels() {
        assert!(version_below("8.4.79", "8.4.80"));
        assert!(version_below("8.4.80rc1", "8.4.80"));
        assert!(!version_below("8.4.80", "8.4.80"));
        assert!(!version_below("8.4.115", "8.4.80"));
    }

    #[test]
    fn outdated_ultralytics_result_blocks_with_installable_update() {
        let result = ultralytics_version_too_old_result("8.4.79", "8.4.80");

        assert_eq!(result.item, "ultralytics");
        assert_eq!(result.status, "version_too_old");
        assert_eq!(
            result.install_package,
            Some("ultralytics>=8.4.80".to_string())
        );
        assert!(result.reason.contains("8.4.79"));
        assert!(result.reason.contains("8.4.80"));
        assert!(result.install_hint.contains("ultralytics>=8.4.80"));
    }

    #[test]
    fn litert_python_floor_result_blocks_without_install_package() {
        let result = python_version_too_old_result("3.9.6");

        assert_eq!(result.item, "Python 3.10+");
        assert_eq!(result.status, "version_too_old");
        assert_eq!(result.install_package, None);
        assert!(result.reason.contains("3.9.6"));
        assert!(result.reason.contains("Python 3.10 or newer"));
        assert!(result.install_hint.contains("re-detect the environment"));
    }

    #[test]
    fn failed_ultralytics_probe_remains_unknown_and_uninstallable() {
        let result = check_ultralytics_dep("/path/that/does/not/exist", "8.4.80");

        assert_eq!(result.status, "unknown");
        assert_eq!(result.install_package, None);
    }

    #[test]
    fn last_version_line_keeps_clean_single_line() {
        assert_eq!(last_version_line("8.4.115"), "8.4.115");
    }

    #[test]
    fn last_version_line_drops_warning_prefix() {
        let raw = "WARNING ⚠️ Ultralytics settings reset to default values.\n8.4.115";
        assert_eq!(last_version_line(raw), "8.4.115");
    }

    #[test]
    fn last_version_line_skips_multiple_leading_warning_lines() {
        let raw = "WARNING line one\nWARNING line two\n8.4.115";
        assert_eq!(last_version_line(raw), "8.4.115");
    }

    #[test]
    fn last_version_line_trims_trailing_whitespace() {
        assert_eq!(last_version_line("8.4.115\n  \n"), "8.4.115");
    }

    #[test]
    fn last_version_line_returns_empty_for_empty_input() {
        assert_eq!(last_version_line(""), "");
        assert_eq!(last_version_line("\n \n"), "");
    }

    const NOISY: &str =
        "WARNING ⚠️ Ultralytics settings reset to default values. This may be due to a
possible problem with your settings or a recent ultralytics package update.\n8.4.115";

    #[test]
    fn noisy_version_is_below_floor_before_sanitizing() {
        assert!(version_below(NOISY, "8.4.80"));
    }

    #[test]
    fn sanitized_version_is_not_below_floor() {
        assert!(!version_below(last_version_line(NOISY), "8.4.80"));
    }

    #[test]
    fn version_probe_code_uses_distribution_metadata() {
        let code = version_probe_code("ultralytics");
        assert!(code.contains("importlib.metadata"));
        assert!(!code.starts_with("import ultralytics"));
    }
}
