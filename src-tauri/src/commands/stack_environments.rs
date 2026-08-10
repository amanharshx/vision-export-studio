use std::path::{Path, PathBuf};

use crate::commands::setup::venv_python_at;

pub(crate) struct StackEnvironment {
    pub key: &'static str,
    pub minimum_python: Option<&'static str>,
}

pub(crate) fn stack_for_route(route_id: &str) -> Option<StackEnvironment> {
    match route_id {
        "rfdetr.pth.onnx" | "rfdetr.pth.engine" => Some(StackEnvironment {
            key: "rfdetr-default",
            minimum_python: None,
        }),
        _ => None,
    }
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

pub(crate) fn stack_minimum_python(route_id: &str) -> Option<&'static str> {
    stack_for_route(route_id).and_then(|stack| stack.minimum_python)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfdetr_routes_share_default_stack_and_other_routes_do_not() {
        let onnx = stack_for_route("rfdetr.pth.onnx").unwrap();
        assert_eq!(onnx.key, "rfdetr-default");
        assert_eq!(onnx.minimum_python, None);
        assert_eq!(
            stack_for_route("rfdetr.pth.engine").unwrap().key,
            "rfdetr-default"
        );
        assert!(stack_for_route("ultralytics.pt.onnx").is_none());
        assert!(stack_for_route("unknown.route").is_none());
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
