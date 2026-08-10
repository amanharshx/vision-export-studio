use std::path::{Path, PathBuf};

use crate::commands::deps::probe_python_version;
use crate::commands::setup::load_settings;
use crate::commands::setup::venv_python_at;

#[derive(Clone, Copy)]
pub(crate) struct StackEnvironment {
    pub key: &'static str,
    pub display_name: &'static str,
    pub route_ids: &'static [&'static str],
}

const KNOWN_STACKS: &[StackEnvironment] = &[
    StackEnvironment {
        key: "rfdetr-default",
        display_name: "RF-DETR",
        route_ids: &["rfdetr.pth.onnx"],
    },
    StackEnvironment {
        key: "rfdetr-tensorrt",
        display_name: "RF-DETR TensorRT",
        route_ids: &["rfdetr.pth.engine"],
    },
    StackEnvironment {
        key: "rfdetr-coreml",
        display_name: "RF-DETR CoreML",
        route_ids: &["rfdetr.pth.coreml"],
    },
];

pub(crate) fn known_stacks() -> &'static [StackEnvironment] {
    KNOWN_STACKS
}

pub(crate) fn stack_for_route(route_id: &str) -> Option<&'static StackEnvironment> {
    known_stacks()
        .iter()
        .find(|stack| stack.route_ids.contains(&route_id))
}

pub(crate) fn stack_venv_dir(runtime_dir: &str, route_id: &str) -> Option<PathBuf> {
    stack_for_route(route_id).map(|stack| {
        Path::new(runtime_dir)
            .join("envs")
            .join(stack.key)
            .join(".venv")
    })
}

pub(crate) fn stack_python(runtime_dir: &str, route_id: &str) -> Option<String> {
    stack_venv_dir(runtime_dir, route_id).map(|path| venv_python_at(&path))
}

#[derive(serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum PythonVersion {
    Available { version: String },
    Unavailable,
}

#[derive(serde::Serialize)]
pub struct StackEnvironmentInfo {
    pub key: String,
    pub display_name: String,
    pub python_path: String,
    pub python_version: PythonVersion,
}

pub(crate) fn list_stack_environments_for_runtime(runtime_dir: &str) -> Vec<StackEnvironmentInfo> {
    known_stacks()
        .iter()
        .filter_map(|stack| {
            let python_path = venv_python_at(
                &Path::new(runtime_dir)
                    .join("envs")
                    .join(stack.key)
                    .join(".venv"),
            );
            Path::new(&python_path)
                .exists()
                .then(|| StackEnvironmentInfo {
                    key: stack.key.to_string(),
                    display_name: stack.display_name.to_string(),
                    python_version: probe_python_version(&python_path)
                        .map(|version| PythonVersion::Available { version })
                        .unwrap_or(PythonVersion::Unavailable),
                    python_path,
                })
        })
        .collect()
}

#[tauri::command]
pub async fn list_stack_environments(
    app_handle: tauri::AppHandle,
) -> Result<Vec<StackEnvironmentInfo>, String> {
    let settings = load_settings(app_handle)?;
    Ok(list_stack_environments_for_runtime(&settings.runtime_dir))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    fn temp_runtime_dir() -> PathBuf {
        std::env::temp_dir().join(format!(
            "vision-export-studio-stack-test-{}",
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn known_stacks_map_rfdetr_routes_to_separate_environments() {
        let stacks = known_stacks();
        assert_eq!(stacks.len(), 3);

        for stack in stacks {
            assert!(!stack.key.is_empty());
            assert!(!stack.display_name.is_empty());
            assert!(!stack.route_ids.is_empty());
            for route_id in stack.route_ids {
                assert_eq!(stack_for_route(route_id).unwrap().key, stack.key);
            }
        }

        assert_eq!(
            stack_for_route("rfdetr.pth.onnx").unwrap().key,
            "rfdetr-default"
        );
        assert_eq!(
            stack_for_route("rfdetr.pth.engine").unwrap().key,
            "rfdetr-tensorrt"
        );
        assert_eq!(
            stack_for_route("rfdetr.pth.coreml").unwrap().key,
            "rfdetr-coreml"
        );
        assert!(stack_for_route("ultralytics.pt.onnx").is_none());
        assert!(stack_for_route("unknown.route").is_none());
    }

    #[test]
    fn listing_includes_only_existing_stack_interpreters_and_marks_failed_probe_unavailable() {
        let runtime_dir = temp_runtime_dir();
        assert!(list_stack_environments_for_runtime(runtime_dir.to_str().unwrap()).is_empty());

        let interpreters: Vec<PathBuf> = known_stacks()
            .iter()
            .map(|stack| {
                Path::new(&runtime_dir)
                    .join("envs")
                    .join(stack.key)
                    .join(".venv")
                    .join(if cfg!(windows) {
                        "Scripts/python.exe"
                    } else {
                        "bin/python"
                    })
            })
            .collect();
        for interpreter in &interpreters {
            fs::create_dir_all(interpreter.parent().unwrap()).unwrap();
            fs::File::create(interpreter).unwrap();
            #[cfg(unix)]
            fs::set_permissions(interpreter, fs::Permissions::from_mode(0o0)).unwrap();
        }

        let stacks = list_stack_environments_for_runtime(runtime_dir.to_str().unwrap());

        assert_eq!(stacks.len(), known_stacks().len());
        for ((stack, expected_stack), interpreter) in
            stacks.iter().zip(known_stacks()).zip(interpreters)
        {
            assert_eq!(stack.key, expected_stack.key);
            assert_eq!(stack.display_name, expected_stack.display_name);
            assert_eq!(stack.python_path, interpreter.to_string_lossy());
            assert!(matches!(stack.python_version, PythonVersion::Unavailable));
        }
        fs::remove_dir_all(runtime_dir).unwrap();
    }

    #[test]
    fn stack_python_uses_platform_correct_venv_location() {
        let python = stack_python("/tmp/vision-export-studio", "rfdetr.pth.onnx").unwrap();

        #[cfg(windows)]
        assert_eq!(
            python,
            "/tmp/vision-export-studio/envs/rfdetr-default/.venv/Scripts/python.exe"
        );

        #[cfg(not(windows))]
        assert_eq!(
            python,
            "/tmp/vision-export-studio/envs/rfdetr-default/.venv/bin/python"
        );
    }
}
