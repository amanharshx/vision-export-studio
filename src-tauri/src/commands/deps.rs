use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};
use std::str::FromStr;

use pep440_rs::Version;
use tauri::Emitter;
use uuid::Uuid;

use crate::commands::provider_registry::{
    current_host_context, validate_route_platform, HostContext,
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
const MIN_RFDETR_EXECUTORCH_VERSION: &str = "1.9.0";
const MIN_RFDETR_EXECUTORCH_TORCH_VERSION: &str = "2.13";

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

fn route_python_version_supported(route_id: &str, installed: &str) -> bool {
    if stack_for_route(route_id)
        .and_then(|stack| stack.python_requirement)
        .is_some()
    {
        let Ok(installed) = Version::from_str(installed) else {
            return false;
        };
        let min = Version::from_str("3.12").expect("valid TFLite minimum");
        let max = Version::from_str("3.13").expect("valid TFLite maximum");
        return installed >= min && installed < max;
    }
    match minimum_python_version(route_id) {
        Some(required) => !version_below(installed, required),
        None => true,
    }
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

fn route_python_version_result(route_id: &str, installed: &str) -> Option<DepCheckResult> {
    if route_python_version_supported(route_id, installed) {
        return None;
    }
    if route_id == "rfdetr.pth.tflite" {
        return Some(DepCheckResult {
            item: "Python 3.12".to_string(),
            status: "version_too_old".to_string(),
            reason: format!(
                "Python {} is selected; TFLite requires Python 3.12.",
                installed
            ),
            install_hint:
                "Select Python 3.12, then recreate the RF-DETR TFLite export environment."
                    .to_string(),
            install_package: None,
        });
    }
    minimum_python_version(route_id).map(|_| python_version_too_old_result(installed))
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

struct DistributionRequirement {
    name: &'static str,
    required: &'static str,
}

#[derive(Clone, Copy)]
struct RfDetrProbeDefinition {
    item: &'static str,
    install_hint: &'static str,
    install_package: &'static str,
    modules: &'static [&'static str],
    distributions: &'static [DistributionRequirement],
}

const RFDETR_MODULES_ONNX: &[&str] = &["rfdetr", "onnx"];
const RFDETR_MODULES_ENGINE: &[&str] = &["rfdetr", "tensorrt"];
const RFDETR_MODULES_COREML: &[&str] = &["rfdetr", "coremltools"];
const RFDETR_MODULES_TFLITE: &[&str] = &["rfdetr", "tensorflow", "onnx2tf"];
const RFDETR_MODULES_EXECUTORCH: &[&str] = &["rfdetr", "executorch.exir", "torch"];
const RFDETR_EXECUTORCH_DISTRIBUTIONS: &[DistributionRequirement] = &[
    DistributionRequirement {
        name: "rfdetr",
        required: MIN_RFDETR_EXECUTORCH_VERSION,
    },
    DistributionRequirement {
        name: "torch",
        required: MIN_RFDETR_EXECUTORCH_TORCH_VERSION,
    },
];

fn rfdetr_probe(route_id: &str) -> RfDetrProbeDefinition {
    match route_id {
        "rfdetr.pth.onnx" => RfDetrProbeDefinition {
            item: "rfdetr[onnx]",
            install_hint: "pip install \"rfdetr[onnx]\"",
            install_package: "rfdetr[onnx]",
            modules: RFDETR_MODULES_ONNX,
            distributions: &[],
        },
        "rfdetr.pth.engine" => RfDetrProbeDefinition {
            item: "rfdetr[tensorrt]",
            install_hint: "pip install \"rfdetr[tensorrt]\"",
            install_package: "rfdetr[tensorrt]",
            modules: RFDETR_MODULES_ENGINE,
            distributions: &[],
        },
        "rfdetr.pth.coreml" => RfDetrProbeDefinition {
            item: "rfdetr[coreml]",
            install_hint: "pip install \"rfdetr[coreml]\"",
            install_package: "rfdetr[coreml]",
            modules: RFDETR_MODULES_COREML,
            distributions: &[],
        },
        "rfdetr.pth.tflite" => RfDetrProbeDefinition {
            item: "rfdetr[tflite]",
            install_hint: "pip install \"rfdetr[tflite]\"",
            install_package: "rfdetr[tflite]",
            modules: RFDETR_MODULES_TFLITE,
            distributions: &[],
        },
        "rfdetr.pth.executorch" => RfDetrProbeDefinition {
            item: "rfdetr[executorch]>=1.9.0",
            install_hint: "pip install \"rfdetr[executorch]>=1.9.0\"",
            install_package: "rfdetr[executorch]>=1.9.0",
            modules: RFDETR_MODULES_EXECUTORCH,
            distributions: RFDETR_EXECUTORCH_DISTRIBUTIONS,
        },
        _ => panic!("unknown RF-DETR route: {route_id}"),
    }
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
                package_name: "rfdetr[tensorrt]",
                install_hint: "pip install \"rfdetr[tensorrt]\"",
                optional: false,
            }],
            sys: &[],
        }),
        "rfdetr.pth.coreml" => Some(RouteDeps {
            pip: &[PipDep {
                package_name: "rfdetr[coreml]",
                install_hint: "pip install \"rfdetr[coreml]\"",
                optional: false,
            }],
            sys: &[],
        }),
        "rfdetr.pth.tflite" => Some(RouteDeps {
            pip: &[PipDep {
                package_name: "rfdetr[tflite]",
                install_hint: "pip install \"rfdetr[tflite]\"",
                optional: false,
            }],
            sys: &[],
        }),
        "rfdetr.pth.executorch" => Some(RouteDeps {
            pip: &[
                PipDep {
                    package_name: "rfdetr[executorch]>=1.9.0",
                    install_hint: "pip install \"rfdetr[executorch]>=1.9.0\"",
                    optional: false,
                },
                PipDep {
                    package_name: "torch>=2.13",
                    install_hint: "pip install \"torch>=2.13\"",
                    optional: false,
                },
            ],
            sys: &[],
        }),
        _ => None,
    }
}

fn validate_install_route_platform(route_id: &str, host: HostContext<'_>) -> Result<(), String> {
    route_deps(route_id).ok_or_else(|| format!("unknown route_id: {}", route_id))?;
    validate_route_platform(route_id, host)
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
pub(crate) fn probe_python_version(python: &str) -> Result<String, String> {
    probe(python, "import platform; print(platform.python_version())")
}

/// Return installed distribution version without importing its package.
pub(crate) fn probe_distribution_version(
    python: &str,
    distribution: &str,
) -> Result<String, String> {
    probe(python, &distribution_version_probe_code(distribution))
        .map(|out| last_version_line(&out).to_string())
}

pub(crate) fn distribution_version_probe_code(distribution: &str) -> String {
    format!("import importlib.metadata as _metadata; print(_metadata.version({distribution:?}))",)
}

/// Python snippet that prints a distribution version without importing the
/// package. Falls back to the module's `__version__` when metadata is absent.
/// Assumes the distribution name matches the importable name, which holds for
/// current callers (`ultralytics`, `rfdetr`, and `torch`).
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

#[derive(serde::Deserialize)]
struct RfDetrProbeOutput {
    modules: Vec<RfDetrModuleRow>,
    distributions: Vec<RfDetrDistributionRow>,
}

#[derive(serde::Deserialize)]
struct RfDetrModuleRow {
    name: String,
    present: bool,
}

#[derive(serde::Deserialize)]
struct RfDetrDistributionRow {
    name: String,
    version: Option<String>,
}

/// Build one import-free probe for one RF-DETR route.
fn rfdetr_probe_code(route_id: &str) -> String {
    let definition = rfdetr_probe(route_id);
    let modules = serde_json::to_string(definition.modules).expect("static module names serialize");
    let distributions: Vec<&str> = definition
        .distributions
        .iter()
        .map(|distribution| distribution.name)
        .collect();
    let distributions =
        serde_json::to_string(&distributions).expect("static distribution names serialize");

    format!(
        r#"import importlib.machinery as _machinery
import importlib.metadata as _metadata
import importlib.util as _util
import json as _json
_modules = {modules}
_distributions = {distributions}
_module_rows = []
for _name in _modules:
    if _name == "executorch.exir":
        _parent = _util.find_spec("executorch")
        _present = (
            _parent is not None
            and _parent.submodule_search_locations is not None
            and _machinery.PathFinder.find_spec(
                "executorch.exir", _parent.submodule_search_locations
            ) is not None
        )
    else:
        _present = _util.find_spec(_name) is not None
    _module_rows.append({{"name": _name, "present": _present}})
_distribution_rows = []
for _name in _distributions:
    try:
        _version = _metadata.version(_name)
    except _metadata.PackageNotFoundError:
        _version = None
    _distribution_rows.append({{"name": _name, "version": _version}})
print(_json.dumps({{"modules": _module_rows, "distributions": _distribution_rows}}))"#,
        modules = modules,
        distributions = distributions,
    )
}

fn probe_failure_result(definition: RfDetrProbeDefinition, reason: String) -> DepCheckResult {
    DepCheckResult {
        item: definition.item.to_string(),
        status: "missing_package".to_string(),
        reason,
        install_hint: definition.install_hint.to_string(),
        install_package: Some(definition.install_package.to_string()),
    }
}

fn probe_failure_results(
    route_id: &str,
    definition: RfDetrProbeDefinition,
    reason: String,
) -> Vec<DepCheckResult> {
    if route_id == "rfdetr.pth.executorch" {
        return vec![
            probe_failure_result(definition, reason.clone()),
            missing_torch_result(reason),
        ];
    }
    vec![probe_failure_result(definition, reason)]
}

fn missing_torch_result(reason: String) -> DepCheckResult {
    DepCheckResult {
        item: "torch>=2.13".to_string(),
        status: "missing_package".to_string(),
        reason,
        install_hint: "pip install \"torch>=2.13\"".to_string(),
        install_package: Some("torch>=2.13".to_string()),
    }
}

fn parse_rfdetr_probe_output(route_id: &str, raw: &str) -> Vec<DepCheckResult> {
    let definition = rfdetr_probe(route_id);
    let fail = |reason: String| probe_failure_results(route_id, definition, reason);
    let output: RfDetrProbeOutput = match serde_json::from_str(raw) {
        Ok(output) => output,
        Err(error) => return fail(format!("probe returned malformed JSON: {}", error)),
    };
    if output.modules.len() != definition.modules.len()
        || output
            .modules
            .iter()
            .map(|row| row.name.as_str())
            .collect::<std::collections::HashSet<_>>()
            .len()
            != output.modules.len()
        || output
            .modules
            .iter()
            .any(|row| !definition.modules.contains(&row.name.as_str()))
    {
        return fail("probe returned incomplete or duplicate module rows".to_string());
    }
    if output.distributions.len() != definition.distributions.len()
        || output
            .distributions
            .iter()
            .map(|row| row.name.as_str())
            .collect::<std::collections::HashSet<_>>()
            .len()
            != output.distributions.len()
        || output
            .distributions
            .iter()
            .any(|row| !definition.distributions.iter().any(|d| d.name == row.name))
    {
        return fail("probe returned incomplete or duplicate distribution rows".to_string());
    }
    for requirement in definition.distributions {
        if !output
            .distributions
            .iter()
            .any(|row| row.name == requirement.name)
        {
            return fail(format!(
                "distribution '{}' row is missing",
                requirement.name
            ));
        }
    }
    if route_id == "rfdetr.pth.executorch" {
        let module_present = |name: &str| {
            output
                .modules
                .iter()
                .find(|row| row.name == name)
                .map(|row| row.present)
                .unwrap_or(false)
        };
        let installed = |name: &str| {
            output
                .distributions
                .iter()
                .find(|row| row.name == name)
                .and_then(|row| row.version.as_deref())
        };
        let rfdetr = if module_present("rfdetr") && module_present("executorch.exir") {
            versioned_rfdetr_result(&definition.distributions[0], installed("rfdetr"))
        } else {
            missing_rfdetr_module_result("rfdetr or executorch.exir")
        };
        let torch = if module_present("torch") {
            versioned_rfdetr_result(&definition.distributions[1], installed("torch"))
        } else {
            missing_torch_result("module 'torch' is not available".to_string())
        };
        return vec![rfdetr, torch];
    }
    if let Some(row) = output.modules.iter().find(|row| !row.present) {
        return fail(format!("module '{}' is not available", row.name));
    }
    if definition.distributions.is_empty() {
        return vec![DepCheckResult {
            item: definition.item.to_string(),
            status: "ready".to_string(),
            reason: String::new(),
            install_hint: definition.install_hint.to_string(),
            install_package: None,
        }];
    }
    fail(format!(
        "probe definition has unexpected distribution shape for {}",
        route_id
    ))
}

fn missing_rfdetr_module_result(module: &str) -> DepCheckResult {
    DepCheckResult {
        item: "rfdetr[executorch]>=1.9.0".to_string(),
        status: "missing_package".to_string(),
        reason: format!("module '{}' is not available", module),
        install_hint: "pip install \"rfdetr[executorch]>=1.9.0\"".to_string(),
        install_package: Some("rfdetr[executorch]>=1.9.0".to_string()),
    }
}

fn versioned_rfdetr_result(
    requirement: &DistributionRequirement,
    installed: Option<&str>,
) -> DepCheckResult {
    let (item, install_hint) = if requirement.name == "rfdetr" {
        (
            "rfdetr[executorch]>=1.9.0",
            "pip install \"rfdetr[executorch]>=1.9.0\"",
        )
    } else {
        ("torch>=2.13", "pip install \"torch>=2.13\"")
    };
    let Some(installed) = installed else {
        return DepCheckResult {
            item: item.to_string(),
            status: "version_too_old".to_string(),
            reason: format!("{} version could not be determined.", requirement.name),
            install_hint: install_hint.to_string(),
            install_package: Some(item.to_string()),
        };
    };
    if version_below(installed, requirement.required) {
        DepCheckResult {
            item: item.to_string(),
            status: "version_too_old".to_string(),
            reason: format!(
                "{} {} is installed; {} or newer is required.",
                requirement.name, installed, requirement.required
            ),
            install_hint: install_hint.to_string(),
            install_package: Some(item.to_string()),
        }
    } else {
        DepCheckResult {
            item: item.to_string(),
            status: "ready".to_string(),
            reason: String::new(),
            install_hint: install_hint.to_string(),
            install_package: None,
        }
    }
}

fn check_rfdetr_probe_dep(python: &str, route_id: &str) -> Vec<DepCheckResult> {
    let definition = rfdetr_probe(route_id);
    let code = rfdetr_probe_code(route_id);
    match probe(python, &code) {
        Ok(output) => parse_rfdetr_probe_output(route_id, &output),
        Err(error) => {
            probe_failure_results(route_id, definition, format!("probe failed: {}", error))
        }
    }
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

    if let Err(reason) = validate_route_platform(route_id, current_host_context()) {
        return Ok(DepCheckResponse {
            results: vec![platform_unsupported_result(reason)],
        });
    }

    if let Ok(installed_python) = probe_python_version(python_path) {
        if let Some(result) = route_python_version_result(route_id, &installed_python) {
            return Ok(DepCheckResponse {
                results: vec![result],
            });
        }
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

    // Check ultralytics only for Ultralytics routes.
    if route_id.starts_with("ultralytics.") {
        let required = minimum_ultralytics_version(route_id)
            .expect("ultralytics routes always declare a minimum version");
        results.push(check_ultralytics_dep(&dependency_python, required));
    }

    // Check route pip deps — RF-DETR routes use probe-based checks for extras.
    if route_id.starts_with("rfdetr.") {
        results.extend(check_rfdetr_probe_dep(&dependency_python, route_id));
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
        "rfdetr.pth.onnx" => Some(vec![DepCheckResult {
            item: "rfdetr[onnx]".to_string(),
            status: "missing_package".to_string(),
            reason: "RF-DETR stack environment has not been created.".to_string(),
            install_hint: "pip install \"rfdetr[onnx]\"".to_string(),
            install_package: Some("rfdetr[onnx]".to_string()),
        }]),
        "rfdetr.pth.engine" => Some(vec![DepCheckResult {
            item: "rfdetr[tensorrt]".to_string(),
            status: "missing_package".to_string(),
            reason: "RF-DETR stack environment has not been created.".to_string(),
            install_hint: "pip install \"rfdetr[tensorrt]\"".to_string(),
            install_package: Some("rfdetr[tensorrt]".to_string()),
        }]),
        "rfdetr.pth.coreml" => Some(vec![DepCheckResult {
            item: "rfdetr[coreml]".to_string(),
            status: "missing_package".to_string(),
            reason: "RF-DETR stack environment has not been created.".to_string(),
            install_hint: "pip install \"rfdetr[coreml]\"".to_string(),
            install_package: Some("rfdetr[coreml]".to_string()),
        }]),
        "rfdetr.pth.tflite" => Some(vec![DepCheckResult {
            item: "rfdetr[tflite]".to_string(),
            status: "missing_package".to_string(),
            reason: "RF-DETR TFLite stack environment has not been created.".to_string(),
            install_hint: "pip install \"rfdetr[tflite]\"".to_string(),
            install_package: Some("rfdetr[tflite]".to_string()),
        }]),
        "rfdetr.pth.executorch" => Some(vec![
            DepCheckResult {
                item: "rfdetr[executorch]>=1.9.0".to_string(),
                status: "missing_package".to_string(),
                reason: "RF-DETR stack environment has not been created.".to_string(),
                install_hint: "pip install \"rfdetr[executorch]>=1.9.0\"".to_string(),
                install_package: Some("rfdetr[executorch]>=1.9.0".to_string()),
            },
            DepCheckResult {
                item: "torch>=2.13".to_string(),
                status: "missing_package".to_string(),
                reason: "RF-DETR stack environment has not been created.".to_string(),
                install_hint: "pip install \"torch>=2.13\"".to_string(),
                install_package: Some("torch>=2.13".to_string()),
            },
        ]),
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
        validate_install_route_platform(route_id, current_host_context())?;
    }
    if python_path.is_empty() {
        return Err("python_path must not be empty".to_string());
    }
    let python_is_path = python_path.contains('/') || python_path.contains('\\');
    if python_is_path && !Path::new(&python_path).exists() {
        return Err(format!("python executable not found: {}", python_path));
    }
    if let Some(route_id) = route_id.as_deref() {
        let installed_python = probe_python_version(&python_path)?;
        if let Some(result) = route_python_version_result(route_id, &installed_python) {
            return Err(result.reason);
        }
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

    fn host(os: &'static str, arch: &'static str) -> HostContext<'static> {
        HostContext {
            os,
            arch,
            macos_major: None,
        }
    }

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
            validate_install_route_platform("ultralytics.pt.litert", host("macos", "x86_64"))
                .is_ok()
        );
        assert!(
            validate_install_route_platform("ultralytics.pt.litert", host("macos", "aarch64"))
                .is_ok()
        );
        assert!(
            validate_install_route_platform("ultralytics.pt.litert", host("linux", "x86_64"))
                .is_ok()
        );
        assert!(validate_install_route_platform(
            "ultralytics.pt.litert",
            host("windows", "x86_64")
        )
        .is_err());
        assert!(
            validate_install_route_platform("ultralytics.pt.litert", host("linux", "aarch64"))
                .is_err()
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
    fn rfdetr_tflite_route_uses_isolated_extra() {
        let deps = route_deps("rfdetr.pth.tflite").expect("route deps");
        assert_eq!(deps.pip[0].package_name, "rfdetr[tflite]");
        assert_eq!(deps.pip[0].install_hint, "pip install \"rfdetr[tflite]\"");
    }

    #[test]
    fn rfdetr_engine_route_uses_native_tensorrt_extra_without_system_binary() {
        let deps = route_deps("rfdetr.pth.engine").expect("route deps");
        assert_eq!(deps.pip.len(), 1);
        assert_eq!(deps.pip[0].package_name, "rfdetr[tensorrt]");
        assert_eq!(deps.pip[0].install_hint, "pip install \"rfdetr[tensorrt]\"");
        assert!(deps.sys.is_empty());
    }

    #[test]
    fn rfdetr_routes_declare_exact_module_checks() {
        assert_eq!(rfdetr_probe("rfdetr.pth.onnx").modules, &["rfdetr", "onnx"]);
        assert_eq!(
            rfdetr_probe("rfdetr.pth.engine").modules,
            &["rfdetr", "tensorrt"]
        );
        assert_eq!(
            rfdetr_probe("rfdetr.pth.coreml").modules,
            &["rfdetr", "coremltools"]
        );
        assert_eq!(
            rfdetr_probe("rfdetr.pth.tflite").modules,
            &["rfdetr", "tensorflow", "onnx2tf"]
        );
        assert_eq!(
            rfdetr_probe("rfdetr.pth.executorch").modules,
            &["rfdetr", "executorch.exir", "torch"]
        );
    }

    #[test]
    fn executorch_probe_uses_distribution_floors_without_imports() {
        let probe = rfdetr_probe_code("rfdetr.pth.executorch");
        assert!(probe.contains("PathFinder.find_spec"));
        let definition = rfdetr_probe("rfdetr.pth.executorch");
        assert_eq!(
            definition
                .distributions
                .iter()
                .map(|distribution| (distribution.name, distribution.required))
                .collect::<Vec<_>>(),
            vec![("rfdetr", "1.9.0"), ("torch", "2.13")]
        );
        assert!(!probe.contains("import rfdetr"));
        assert!(!probe.contains("import torch"));
        assert!(!probe.contains("import executorch"));
    }

    fn available_test_python() -> Option<&'static str> {
        ["python3", "python"].into_iter().find(|python| {
            Command::new(python)
                .args(["-c", "pass"])
                .status()
                .map(|status| status.success())
                .unwrap_or(false)
        })
    }

    #[test]
    fn probe_does_not_import_framework_packages() {
        let python = available_test_python().expect("python3 or python required");
        let code = rfdetr_probe_code("rfdetr.pth.executorch");
        let code = format!(
            "exec({code:?})\nassert 'executorch' not in __import__('sys').modules\nassert 'torch' not in __import__('sys').modules\nassert 'rfdetr' not in __import__('sys').modules",
        );
        probe(python, &code).expect("probe must leave framework modules absent");
    }

    #[test]
    fn malformed_probe_rows_fail_closed() {
        for output in [
            "not json",
            r#"{"modules":[],"distributions":[]}"#,
            r#"{"modules":[{"name":"rfdetr","present":true},{"name":"rfdetr","present":true}],"distributions":[]}"#,
            r#"{"modules":[{"name":"rfdetr","present":true}],"distributions":[]}"#,
        ] {
            let result = parse_rfdetr_probe_output("rfdetr.pth.onnx", output);
            assert!(
                result.iter().all(|row| row.status != "ready"),
                "output unexpectedly ready: {output}"
            );
            assert!(result.iter().all(|row| !row.reason.is_empty()));
        }
    }

    #[test]
    fn malformed_executorch_probe_returns_two_installable_rows() {
        let result = parse_rfdetr_probe_output("rfdetr.pth.executorch", "not json");
        assert_eq!(result.len(), 2);
        assert!(result.iter().all(|row| row.status == "missing_package"));
        assert_eq!(result[0].item, "rfdetr[executorch]>=1.9.0");
        assert_eq!(result[1].item, "torch>=2.13");
        assert_eq!(result[1].install_hint, "pip install \"torch>=2.13\"");
        assert_eq!(result[1].install_package.as_deref(), Some("torch>=2.13"));
    }

    #[test]
    fn missing_module_preserves_rfdetr_install_remedy() {
        let result = parse_rfdetr_probe_output(
            "rfdetr.pth.engine",
            r#"{"modules":[{"name":"rfdetr","present":true},{"name":"tensorrt","present":false}],"distributions":[]}"#,
        );
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].status, "missing_package");
        assert_eq!(
            result[0].install_package.as_deref(),
            Some("rfdetr[tensorrt]")
        );
        assert_eq!(result[0].install_hint, "pip install \"rfdetr[tensorrt]\"");
    }

    #[cfg(unix)]
    #[test]
    fn failed_executorch_probe_returns_two_installable_rows() {
        use std::os::unix::fs::PermissionsExt;

        let root = std::env::temp_dir().join(format!("rfdetr-probe-fail-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let python = root.join("python");
        std::fs::write(&python, b"#!/bin/sh\nexit 7\n").unwrap();
        std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755)).unwrap();
        let result = check_rfdetr_probe_dep(python.to_str().unwrap(), "rfdetr.pth.executorch");
        assert_eq!(result.len(), 2);
        assert!(result.iter().all(|row| row.status == "missing_package"));
        assert!(result.iter().all(|row| row.reason.contains("probe failed")));
        assert_eq!(
            result[0].install_package.as_deref(),
            Some("rfdetr[executorch]>=1.9.0")
        );
        assert_eq!(result[1].install_package.as_deref(), Some("torch>=2.13"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rfdetr_probe_launches_one_package_process() {
        let root = std::env::temp_dir().join(format!("rfdetr-probe-count-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let count = root.join("count");
        let python = root.join("python");
        std::fs::write(
            &python,
            format!(
                "#!/bin/sh\nprintf x >> '{}'\nprintf '{{\"modules\":[] ,\"distributions\":[]}}'\n",
                count.display()
            ),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755)).unwrap();
        let result = check_rfdetr_probe_dep(python.to_str().unwrap(), "rfdetr.pth.onnx");
        assert!(result.iter().all(|row| row.status != "ready"));
        assert_eq!(std::fs::read_to_string(&count).unwrap().len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rfdetr_engine_route_package_matches_typescript_metadata() {
        let ts_source = include_str!("../../../src/lib/providers/rfdetr.ts");
        let engine_route = ts_source
            .split("id: \"rfdetr.pth.engine\",")
            .nth(1)
            .expect("TensorRT route in TypeScript metadata");
        let ts_package_name = engine_route
            .split("packageName: \"")
            .nth(1)
            .and_then(|tail| tail.split('\"').next())
            .expect("TensorRT packageName in TypeScript metadata");
        let rust_deps = route_deps("rfdetr.pth.engine").expect("Rust TensorRT route deps");

        assert_eq!(ts_package_name, rust_deps.pip[0].package_name);
    }

    #[test]
    fn rfdetr_coreml_route_package_matches_typescript_metadata() {
        let ts_source = include_str!("../../../src/lib/providers/rfdetr.ts");
        let coreml_route = ts_source
            .split("id: \"rfdetr.pth.coreml\",")
            .nth(1)
            .expect("CoreML route in TypeScript metadata");
        let ts_package_name = coreml_route
            .split("packageName: \"")
            .nth(1)
            .and_then(|tail| tail.split('\"').next())
            .expect("CoreML packageName in TypeScript metadata");
        let rust_deps = route_deps("rfdetr.pth.coreml").expect("Rust CoreML route deps");

        assert_eq!(ts_package_name, "rfdetr[coreml]");
        assert_eq!(ts_package_name, rust_deps.pip[0].package_name);
    }

    #[test]
    fn rfdetr_tflite_route_package_matches_typescript_metadata() {
        let ts_source = include_str!("../../../src/lib/providers/rfdetr.ts");
        let tflite_route = ts_source
            .split("id: \"rfdetr.pth.tflite\",")
            .nth(1)
            .expect("TFLite route in TypeScript metadata");
        let ts_package_name = tflite_route
            .split("packageName: \"")
            .nth(1)
            .and_then(|tail| tail.split('\"').next())
            .expect("TFLite packageName in TypeScript metadata");
        let rust_deps = route_deps("rfdetr.pth.tflite").expect("Rust TFLite route deps");

        assert_eq!(ts_package_name, "rfdetr[tflite]");
        assert_eq!(ts_package_name, rust_deps.pip[0].package_name);
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
    fn absent_rfdetr_tensorrt_stack_returns_tensorrt_extra() {
        let runtime = std::env::temp_dir().join(format!("rfdetr-stack-{}", Uuid::new_v4()));
        let runtime = runtime.to_string_lossy();
        let results = missing_stack_results_if_absent(&runtime, "rfdetr.pth.engine")
            .expect("RF-DETR TensorRT stack results");

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].status, "missing_package");
        assert_eq!(
            results[0].install_package.as_deref(),
            Some("rfdetr[tensorrt]")
        );
        assert!(!stack_venv_dir(&runtime, "rfdetr.pth.engine")
            .unwrap()
            .exists());
    }

    #[test]
    fn absent_rfdetr_executorch_stack_returns_two_exact_install_rows() {
        let runtime = std::env::temp_dir().join(format!("rfdetr-stack-{}", Uuid::new_v4()));
        let runtime = runtime.to_string_lossy();
        let results = missing_stack_results_if_absent(&runtime, "rfdetr.pth.executorch")
            .expect("RF-DETR ExecuTorch stack results");

        assert_eq!(results.len(), 2);
        assert_eq!(results[0].item, "rfdetr[executorch]>=1.9.0");
        assert_eq!(
            results[0].install_package.as_deref(),
            Some("rfdetr[executorch]>=1.9.0")
        );
        assert_eq!(results[1].item, "torch>=2.13");
        assert_eq!(results[1].install_package.as_deref(), Some("torch>=2.13"));
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
        assert!(validate_install_route_platform(
            "ultralytics.pt.edgetpu",
            host("linux", "aarch64")
        )
        .is_err());
    }

    #[test]
    fn dependency_install_rejects_unknown_route() {
        assert!(validate_install_route_platform("unknown.route", host("linux", "x86_64")).is_err());
    }

    #[test]
    fn dependency_install_allows_supported_route_platform() {
        assert!(
            validate_install_route_platform("ultralytics.pt.edgetpu", host("linux", "x86_64"))
                .is_ok()
        );
        assert!(
            validate_install_route_platform("ultralytics.pt.paddle", host("macos", "aarch64"))
                .is_ok()
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
    fn tflite_requires_exactly_python_3_12() {
        assert!(!route_python_version_supported(
            "rfdetr.pth.tflite",
            "3.11.9"
        ));
        assert!(route_python_version_supported(
            "rfdetr.pth.tflite",
            "3.12.12"
        ));
        assert!(!route_python_version_supported(
            "rfdetr.pth.tflite",
            "3.13.12"
        ));
        let result = route_python_version_result("rfdetr.pth.tflite", "3.13.12").unwrap();
        assert_eq!(result.status, "version_too_old");
        assert_eq!(result.install_package, None);
        assert_eq!(
            result.reason,
            "Python 3.13.12 is selected; TFLite requires Python 3.12."
        );
    }

    #[cfg(unix)]
    #[test]
    fn tflite_dependency_check_blocks_3_11_and_3_13_before_creating_stack() {
        use std::os::unix::fs::PermissionsExt;

        for version in ["3.11.9", "3.13.12"] {
            let root =
                std::env::temp_dir().join(format!("rfdetr-tflite-python-{}", Uuid::new_v4()));
            std::fs::create_dir_all(&root).expect("create temp root");
            let python = root.join("python");
            std::fs::write(&python, format!("#!/bin/sh\necho {}\n", version))
                .expect("write fake python");
            std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755))
                .expect("make fake python executable");
            let runtime = root.join("runtime");

            let response = check_dependencies_for_runtime(
                "rfdetr.pth.tflite",
                python.to_str().expect("python path"),
                Some(runtime.to_str().expect("runtime path")),
            )
            .expect("dependency check response");

            assert_eq!(response.results.len(), 1);
            assert_eq!(response.results[0].status, "version_too_old");
            assert_eq!(response.results[0].install_package, None);
            assert!(response.results[0].reason.contains(version));
            assert!(response.results[0].reason.contains("requires Python 3.12"));
            assert!(
                !stack_venv_dir(runtime.to_str().unwrap(), "rfdetr.pth.tflite")
                    .unwrap()
                    .exists()
            );
            std::fs::remove_dir_all(root).expect("remove temp root");
        }
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
    fn executorch_probe_preserves_two_dependency_rows_for_each_state() {
        let modules = r#"[{"name":"rfdetr","present":true},{"name":"executorch.exir","present":true},{"name":"torch","present":true}]"#;
        let rows = |rfdetr: &str, torch: &str| {
            parse_rfdetr_probe_output(
                "rfdetr.pth.executorch",
                &format!(
                    r#"{{"modules":{modules},"distributions":[{{"name":"rfdetr","version":"{rfdetr}"}},{{"name":"torch","version":"{torch}"}}]}}"#
                ),
            )
        };

        let ready = rows("1.9.0", "2.13");
        assert_eq!(ready.len(), 2);
        assert_eq!(ready[0].item, "rfdetr[executorch]>=1.9.0");
        assert_eq!(ready[0].status, "ready");
        assert_eq!(ready[1].item, "torch>=2.13");
        assert_eq!(ready[1].status, "ready");

        let missing_torch = parse_rfdetr_probe_output(
            "rfdetr.pth.executorch",
            &format!(
                r#"{{"modules":{modules},"distributions":[{{"name":"rfdetr","version":"1.9.0"}},{{"name":"torch","version":null}}]}}"#
            ),
        );
        assert_eq!(missing_torch.len(), 2);
        assert_eq!(missing_torch[0].status, "ready");
        assert_eq!(missing_torch[1].status, "version_too_old");
        assert_eq!(missing_torch[1].item, "torch>=2.13");
        assert_eq!(
            missing_torch[1].install_package.as_deref(),
            Some("torch>=2.13")
        );

        let missing_torch_module = parse_rfdetr_probe_output(
            "rfdetr.pth.executorch",
            r#"{"modules":[{"name":"rfdetr","present":true},{"name":"executorch.exir","present":true},{"name":"torch","present":false}],"distributions":[{"name":"rfdetr","version":"1.9.0"},{"name":"torch","version":"2.13"}]}"#,
        );
        assert_eq!(missing_torch_module.len(), 2);
        assert_eq!(missing_torch_module[0].status, "ready");
        assert_eq!(missing_torch_module[1].status, "missing_package");
        assert_eq!(missing_torch_module[1].item, "torch>=2.13");
        assert_eq!(
            missing_torch_module[1].install_hint,
            "pip install \"torch>=2.13\""
        );
        assert_eq!(
            missing_torch_module[1].install_package.as_deref(),
            Some("torch>=2.13")
        );

        let missing_executorch_module = parse_rfdetr_probe_output(
            "rfdetr.pth.executorch",
            r#"{"modules":[{"name":"rfdetr","present":true},{"name":"executorch.exir","present":false},{"name":"torch","present":true}],"distributions":[{"name":"rfdetr","version":"1.9.0"},{"name":"torch","version":"2.13"}]}"#,
        );
        assert_eq!(missing_executorch_module.len(), 2);
        assert_eq!(missing_executorch_module[0].status, "missing_package");
        assert_eq!(
            missing_executorch_module[0].item,
            "rfdetr[executorch]>=1.9.0"
        );
        assert_eq!(missing_executorch_module[1].status, "ready");
        assert_eq!(missing_executorch_module[1].item, "torch>=2.13");

        let old_torch = rows("1.9.0", "2.12.1");
        assert_eq!(old_torch.len(), 2);
        assert_eq!(old_torch[0].status, "ready");
        assert_eq!(old_torch[1].status, "version_too_old");
        assert_eq!(old_torch[1].install_package.as_deref(), Some("torch>=2.13"));

        let both_old = rows("1.8.9", "2.12.1");
        assert_eq!(both_old.len(), 2);
        assert!(both_old.iter().all(|row| row.status == "version_too_old"));
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

    #[test]
    fn distribution_version_probe_only_reads_metadata() {
        let code = distribution_version_probe_code("rfdetr");
        assert!(code.contains("importlib.metadata"));
        assert!(code.contains("version(\"rfdetr\")"));
        assert!(!code.contains("import rfdetr"));
        assert!(!code.contains("torch"));
    }
}
