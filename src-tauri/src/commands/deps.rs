use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};
use tauri::Emitter;
use uuid::Uuid;

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
        "ultralytics.pt.tflite" => Some(RouteDeps {
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
        "ultralytics.pt.tfjs" => Some(RouteDeps {
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
                PipDep {
                    package_name: "tensorflowjs",
                    install_hint: "pip install tensorflowjs",
                    optional: false,
                },
            ],
            sys: &[SysDep {
                binary_name: "tensorflowjs_converter",
                install_hint: "pip install tensorflowjs",
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
        "rfdetr.pth.tflite" => Some(RouteDeps {
            pip: &[PipDep {
                package_name: "rfdetr",
                install_hint: "pip install \"rfdetr[onnx,tflite]\"",
                optional: false,
            }],
            sys: &[],
        }),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Importable-name mapping
// ---------------------------------------------------------------------------

/// Convert a pip package name to the Python importable name used with
/// importlib.util.find_spec.
fn importable_name(package_name: &str) -> String {
    match package_name {
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

// ---------------------------------------------------------------------------
// check_dependencies command
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn check_dependencies(
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

    // Validate python_path points to an executable that exists on disk.
    // For bare names like "python3" we skip the existence check (they live on PATH).
    let python_is_path = python_path.contains('/') || python_path.contains('\\');
    if python_is_path && !Path::new(&python_path).exists() {
        return Err(format!("python executable not found: {}", python_path));
    }

    // Resolve route deps.
    let deps = route_deps(&route_id).ok_or_else(|| format!("unknown route_id: {}", route_id))?;

    let mut results: Vec<DepCheckResult> = Vec::new();

    // Check ultralytics only for Ultralytics routes.
    if route_id.starts_with("ultralytics.") {
        let ultra_result = check_pip_dep(
            &python_path,
            "ultralytics",
            "pip install ultralytics",
            false,
        );
        results.push(ultra_result);
    }

    // Check route pip deps — RF-DETR routes use probe-based checks for extras.
    if route_id == "rfdetr.pth.onnx" || route_id == "rfdetr.pth.engine" {
        results.push(check_python_probe_dep(
            &python_path,
            "rfdetr[onnx]",
            "import importlib.util; ok = importlib.util.find_spec('rfdetr') is not None and importlib.util.find_spec('onnx') is not None; print(ok)",
            "pip install \"rfdetr[onnx]\"",
            "rfdetr[onnx]",
        ));
    } else if route_id == "rfdetr.pth.tflite" {
        results.push(check_python_probe_dep(
            &python_path,
            "rfdetr[onnx,tflite]",
            "import importlib.util; mods = ['rfdetr', 'onnx', 'onnx2tf', 'ai_edge_litert']; print(all(importlib.util.find_spec(m) is not None for m in mods))",
            "pip install \"rfdetr[onnx,tflite]\"",
            "rfdetr[onnx,tflite]",
        ));
    } else {
        for dep in deps.pip {
            let result = check_pip_dep(
                &python_path,
                dep.package_name,
                dep.install_hint,
                dep.optional,
            );
            results.push(result);
        }
    }

    // Check route sys deps.
    for dep in deps.sys {
        let result = check_sys_dep(&python_path, dep.binary_name, dep.install_hint);
        results.push(result);
    }

    Ok(DepCheckResponse { results })
}

// ---------------------------------------------------------------------------
// Per-dep check helpers
// ---------------------------------------------------------------------------

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
                    install_package: None,
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

/// Accept only characters valid in a PyPI package name.
/// Rejects anything that could be used for argument injection.
fn validate_package_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("package name must not be empty".to_string());
    }
    if !name
        .chars()
        .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.' || c == '[' || c == ']' || c == ',')
    {
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
    packages: Vec<String>,
    python_path: String,
) -> Result<String, String> {
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

    // Build argv: python -m pip install pkg1 pkg2 ...
    let mut cmd = Command::new(&python_path);
    cmd.arg("-m");
    cmd.arg("pip");
    cmd.arg("install");
    for pkg in &packages {
        cmd.arg(pkg);
    }
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
        let _ = stdout_handle.join();
        let _ = stderr_handle.join();

        match child.wait() {
            Ok(status) => {
                if status.success() {
                    let _ = ah_wait.emit(
                        "install:finished",
                        InstallFinishedPayload {
                            session_id: sid_wait,
                        },
                    );
                } else {
                    let code = status.code().unwrap_or(-1);
                    let _ = ah_wait.emit(
                        "install:failed",
                        InstallFailedPayload {
                            session_id: sid_wait,
                            error: format!("pip exited with code {}", code),
                        },
                    );
                }
            }
            Err(e) => {
                let _ = ah_wait.emit(
                    "install:failed",
                    InstallFailedPayload {
                        session_id: sid_wait,
                        error: format!("wait error: {}", e),
                    },
                );
            }
        }
    });

    Ok(session_id)
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
    fn rfdetr_onnx_route_uses_rfdetr_extra_hint() {
        let deps = route_deps("rfdetr.pth.onnx").expect("route deps");
        assert_eq!(deps.pip[0].package_name, "rfdetr");
        assert_eq!(deps.pip[0].install_hint, "pip install \"rfdetr[onnx]\"");
    }

    #[test]
    fn rfdetr_tflite_route_uses_tflite_extra_hint() {
        let deps = route_deps("rfdetr.pth.tflite").expect("route deps");
        assert_eq!(deps.pip[0].install_hint, "pip install \"rfdetr[onnx,tflite]\"");
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
    fn package_validation_allows_safe_extras() {
        assert!(validate_package_name("rfdetr[onnx]").is_ok());
        assert!(validate_package_name("rfdetr[onnx,tflite]").is_ok());
        assert!(validate_package_name("rfdetr[onnx];rm").is_err());
    }
}
