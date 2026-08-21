use std::path::Path;
#[cfg(target_os = "macos")]
use std::process::Command;
#[cfg(target_os = "macos")]
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderId {
    Ultralytics,
    RfDetr,
}

impl ProviderId {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "ultralytics" => Ok(Self::Ultralytics),
            "rfdetr" => Ok(Self::RfDetr),
            _ => Err(format!("unknown provider_id: {}", value)),
        }
    }
}

pub const ULTRALYTICS_ROUTES: &[&str] = &[
    "ultralytics.pt.torchscript",
    "ultralytics.pt.onnx",
    "ultralytics.pt.openvino",
    "ultralytics.pt.coreml",
    "ultralytics.pt.ncnn",
    "ultralytics.pt.mnn",
    "ultralytics.pt.litert",
    "ultralytics.pt.engine",
    "ultralytics.pt.rknn",
    "ultralytics.pt.executorch",
    "ultralytics.pt.edgetpu",
    "ultralytics.pt.paddle",
    "ultralytics.pt.imx",
    "ultralytics.pt.axelera",
    "ultralytics.pt.saved_model",
    "ultralytics.pt.pb",
];

pub const RFDETR_ROUTES: &[&str] = &[
    "rfdetr.pth.onnx",
    "rfdetr.pth.engine",
    "rfdetr.pth.coreml",
    "rfdetr.pth.tflite",
    "rfdetr.pth.executorch",
];

pub fn validate_provider_route(provider_id: &str, route_id: &str) -> Result<ProviderId, String> {
    let provider = ProviderId::parse(provider_id)?;
    match provider {
        ProviderId::Ultralytics if ULTRALYTICS_ROUTES.contains(&route_id) => Ok(provider),
        ProviderId::RfDetr if RFDETR_ROUTES.contains(&route_id) => Ok(provider),
        _ => Err(format!(
            "route {} does not belong to provider {}",
            route_id, provider_id
        )),
    }
}

pub fn validate_source_extension(provider: ProviderId, source_path: &str) -> Result<(), String> {
    let ext = Path::new(source_path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match (provider, ext.as_str()) {
        (ProviderId::Ultralytics, "pt") => Ok(()),
        (ProviderId::RfDetr, "pth") => Ok(()),
        (ProviderId::Ultralytics, other) => Err(format!(
            "Ultralytics YOLO accepts .pt files only; got .{}",
            other
        )),
        (ProviderId::RfDetr, other) => Err(format!(
            "Roboflow RF-DETR accepts .pth files only; got .{}",
            other
        )),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlatformLock {
    Any,
    Macos,
    Linux,
    LinuxX86_64,
    LinuxWindows,
    MacosLinux,
    MacosLinuxX86_64,
    MacosArm64LinuxWindowsX86_64,
}

fn route_platform_lock(route_id: &str) -> PlatformLock {
    match route_id {
        "ultralytics.pt.engine" | "rfdetr.pth.engine" => PlatformLock::LinuxWindows,
        "rfdetr.pth.coreml" => PlatformLock::Macos,
        "rfdetr.pth.executorch" => PlatformLock::MacosArm64LinuxWindowsX86_64,
        "ultralytics.pt.coreml" => PlatformLock::MacosLinux,
        "ultralytics.pt.litert" => PlatformLock::MacosLinuxX86_64,
        "ultralytics.pt.edgetpu" => PlatformLock::LinuxX86_64,
        "ultralytics.pt.rknn" | "ultralytics.pt.imx" | "ultralytics.pt.axelera" => {
            PlatformLock::Linux
        }
        _ => PlatformLock::Any,
    }
}

fn platform_tags(lock: PlatformLock) -> &'static str {
    match lock {
        PlatformLock::Any => "all platforms",
        PlatformLock::Macos => "macOS",
        PlatformLock::Linux => "Linux",
        PlatformLock::LinuxX86_64 => "Linux x86-64",
        PlatformLock::LinuxWindows => "Linux and Windows",
        PlatformLock::MacosLinux => "macOS and Linux",
        PlatformLock::MacosLinuxX86_64 => "macOS and Linux x86-64",
        PlatformLock::MacosArm64LinuxWindowsX86_64 => {
            "macOS ARM64 14+, Linux x86-64, and Windows x86-64"
        }
    }
}

fn os_label(os: &str) -> &str {
    match os {
        "macos" => "macOS",
        "windows" => "Windows",
        "linux" => "Linux",
        other => other,
    }
}

fn arch_label(arch: &str) -> &str {
    match arch {
        "aarch64" => "ARM64",
        "arm" => "ARM",
        "x86_64" => "x86-64",
        other => other,
    }
}

#[derive(Debug, Clone, Copy)]
pub struct HostContext<'a> {
    pub os: &'a str,
    pub arch: &'a str,
    pub macos_major: Option<u32>,
}

#[cfg(target_os = "macos")]
fn current_macos_major() -> Option<u32> {
    static MACOS_MAJOR: OnceLock<Option<u32>> = OnceLock::new();
    *MACOS_MAJOR.get_or_init(|| {
        Command::new("/usr/bin/sw_vers")
            .arg("-productVersion")
            .output()
            .ok()
            .filter(|output| output.status.success())
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .and_then(|version| version.trim().split('.').next()?.parse().ok())
    })
}

#[cfg(not(target_os = "macos"))]
fn current_macos_major() -> Option<u32> {
    None
}

pub fn current_host_context() -> HostContext<'static> {
    HostContext {
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        macos_major: current_macos_major(),
    }
}

fn arch_compatible(lock: PlatformLock, os: &str, arch: &str) -> bool {
    match lock {
        PlatformLock::Any => true,
        PlatformLock::Macos => os == "macos",
        PlatformLock::Linux => os == "linux",
        PlatformLock::LinuxX86_64 => os == "linux" && arch == "x86_64",
        PlatformLock::LinuxWindows => os == "linux" || os == "windows",
        PlatformLock::MacosLinux => os == "macos" || os == "linux",
        PlatformLock::MacosLinuxX86_64 => os == "macos" || (os == "linux" && arch == "x86_64"),
        PlatformLock::MacosArm64LinuxWindowsX86_64 => {
            (os == "macos" && arch == "aarch64")
                || ((os == "linux" || os == "windows") && arch == "x86_64")
        }
    }
}

fn architecture_matters(lock: PlatformLock, os: &str) -> bool {
    arch_compatible(lock, os, "x86_64") != arch_compatible(lock, os, "aarch64")
}

pub fn validate_route_platform(route_id: &str, host: HostContext<'_>) -> Result<(), String> {
    let lock = route_platform_lock(route_id);
    let version_compatible = !matches!(lock, PlatformLock::MacosArm64LinuxWindowsX86_64)
        || host.os != "macos"
        || host.arch != "aarch64"
        || match host.macos_major {
            Some(major) => major >= 14,
            None => true,
        };
    let compatible = arch_compatible(lock, host.os, host.arch) && version_compatible;

    if compatible {
        return Ok(());
    }

    if matches!(lock, PlatformLock::MacosArm64LinuxWindowsX86_64)
        && host.os == "macos"
        && host.arch == "aarch64"
        && host.macos_major.is_some_and(|major| major < 14)
    {
        return Err(format!(
            "This format is not supported on macOS {}. RF-DETR ExecuTorch requires macOS 14 or newer.",
            host.macos_major.expect("checked above")
        ));
    }

    let current = if architecture_matters(lock, host.os) {
        format!("{} {}", os_label(host.os), arch_label(host.arch))
    } else {
        os_label(host.os).to_string()
    };
    Err(format!(
        "This format is not supported on {}. Available on {} only.",
        current,
        platform_tags(lock)
    ))
}

pub fn validate_rfdetr_manual_class(class_symbol: &str) -> Result<(), String> {
    const ALLOWED: &[&str] = &[
        "RFDETRNano",
        "RFDETRSmall",
        "RFDETRMedium",
        "RFDETRLarge",
        "RFDETRBase",
        "RFDETRSegNano",
        "RFDETRSegSmall",
        "RFDETRSegMedium",
        "RFDETRSegLarge",
        "RFDETRSegXLarge",
        "RFDETRSeg2XLarge",
    ];
    if ALLOWED.contains(&class_symbol) {
        Ok(())
    } else if class_symbol == "RFDETRXLarge" || class_symbol == "RFDETR2XLarge" {
        Err(format!(
            "{} requires rfdetr_plus support and is not supported in v1.",
            class_symbol
        ))
    } else {
        Err(format!("unsupported RF-DETR class: {}", class_symbol))
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
    fn validates_provider_route_match() {
        assert!(validate_provider_route("ultralytics", "ultralytics.pt.onnx").is_ok());
        assert!(validate_provider_route("rfdetr", "rfdetr.pth.onnx").is_ok());
        assert!(validate_provider_route("rfdetr", "rfdetr.pth.coreml").is_ok());
        assert!(validate_provider_route("rfdetr", "rfdetr.pth.tflite").is_ok());
        assert!(validate_provider_route("rfdetr", "ultralytics.pt.onnx").is_err());
    }

    #[test]
    fn rejects_unknown_ultralytics_route_suffix() {
        assert!(validate_provider_route("ultralytics", "ultralytics.pt.fake").is_err());
    }

    #[test]
    fn rejects_provider_route_mismatch() {
        assert!(validate_provider_route("rfdetr", "ultralytics.pt.onnx").is_err());
        assert!(validate_provider_route("ultralytics", "rfdetr.pth.onnx").is_err());
    }

    #[test]
    fn litert_route_is_valid_for_ultralytics() {
        assert!(validate_provider_route("ultralytics", "ultralytics.pt.litert").is_ok());
    }

    #[test]
    fn deprecated_tflite_and_tfjs_routes_are_rejected() {
        assert!(validate_provider_route("ultralytics", "ultralytics.pt.tflite").is_err());
        assert!(validate_provider_route("ultralytics", "ultralytics.pt.tfjs").is_err());
    }

    #[test]
    fn litert_export_host_allows_macos_and_linux_x86_64() {
        assert!(validate_route_platform("ultralytics.pt.litert", host("macos", "x86_64")).is_ok());
        assert!(validate_route_platform("ultralytics.pt.litert", host("macos", "aarch64")).is_ok());
        assert!(validate_route_platform("ultralytics.pt.litert", host("linux", "x86_64")).is_ok());
        assert!(
            validate_route_platform("ultralytics.pt.litert", host("windows", "x86_64")).is_err()
        );
        assert!(
            validate_route_platform("ultralytics.pt.litert", host("linux", "aarch64")).is_err()
        );
    }

    #[test]
    fn litert_rejection_names_linux_arm64_and_required_hosts() {
        let error = validate_route_platform("ultralytics.pt.litert", host("linux", "aarch64"))
            .expect_err("Linux ARM64 must be rejected");

        assert!(error.contains("Linux ARM64"));
        assert!(error.contains("macOS and Linux x86-64"));
    }

    #[test]
    fn validates_source_extension_by_provider() {
        assert!(validate_source_extension(ProviderId::Ultralytics, "/tmp/best.pt").is_ok());
        assert!(validate_source_extension(ProviderId::Ultralytics, "/tmp/best.pth").is_err());
        assert!(validate_source_extension(ProviderId::RfDetr, "/tmp/checkpoint.pth").is_ok());
        assert!(validate_source_extension(ProviderId::RfDetr, "/tmp/checkpoint.pt").is_err());
    }

    #[test]
    fn rfdetr_coreml_is_macos_only_with_mlpackage_artifacts() {
        assert!(validate_route_platform("rfdetr.pth.coreml", host("macos", "aarch64")).is_ok());
        assert!(validate_route_platform("rfdetr.pth.coreml", host("linux", "x86_64")).is_err());
    }

    #[test]
    fn rfdetr_executorch_platform_lock_mirrors_frontend_host_pairs() {
        for (os, arch) in [
            ("macos", "aarch64"),
            ("linux", "x86_64"),
            ("windows", "x86_64"),
        ] {
            assert!(validate_route_platform("rfdetr.pth.executorch", host(os, arch)).is_ok());
        }
        for (os, arch) in [
            ("macos", "x86_64"),
            ("linux", "aarch64"),
            ("windows", "aarch64"),
        ] {
            assert!(validate_route_platform("rfdetr.pth.executorch", host(os, arch)).is_err());
        }
    }

    #[test]
    fn rfdetr_executorch_requires_macos_14_but_fails_open_without_version() {
        let error = validate_route_platform(
            "rfdetr.pth.executorch",
            HostContext {
                os: "macos",
                arch: "aarch64",
                macos_major: Some(13),
            },
        )
        .expect_err("macOS 13 must be rejected");
        assert!(error.contains("macOS 14 or newer"));
        assert!(validate_route_platform(
            "rfdetr.pth.executorch",
            HostContext {
                os: "macos",
                arch: "aarch64",
                macos_major: Some(14)
            },
        )
        .is_ok());
        assert!(validate_route_platform("rfdetr.pth.executorch", host("macos", "aarch64")).is_ok());
    }

    #[test]
    fn rfdetr_executorch_intel_macos_errors_name_architecture_even_on_macos_13() {
        for macos_major in [None, Some(13)] {
            let error = validate_route_platform(
                "rfdetr.pth.executorch",
                HostContext {
                    os: "macos",
                    arch: "x86_64",
                    macos_major,
                },
            )
            .expect_err("Intel macOS must be rejected");

            assert!(error.contains("macOS x86-64"));
            assert!(error
                .contains("Available on macOS ARM64 14+, Linux x86-64, and Windows x86-64 only."));
        }
    }

    #[test]
    fn plus_only_manual_classes_are_rejected() {
        assert!(validate_rfdetr_manual_class("RFDETRSmall").is_ok());
        assert!(validate_rfdetr_manual_class("RFDETRXLarge").is_err());
    }

    #[test]
    fn edge_tpu_requires_linux_x86_64() {
        assert!(validate_route_platform("ultralytics.pt.edgetpu", host("linux", "x86_64")).is_ok());
        assert!(
            validate_route_platform("ultralytics.pt.edgetpu", host("linux", "aarch64")).is_err()
        );
        assert!(
            validate_route_platform("ultralytics.pt.edgetpu", host("windows", "x86_64")).is_err()
        );
        assert!(
            validate_route_platform("ultralytics.pt.edgetpu", host("macos", "aarch64")).is_err()
        );
    }

    #[test]
    fn linux_only_routes_allow_arm_linux() {
        assert!(validate_route_platform("ultralytics.pt.rknn", host("linux", "aarch64")).is_ok());
        assert!(validate_route_platform("ultralytics.pt.rknn", host("windows", "x86_64")).is_err());
    }

    #[test]
    fn platform_error_names_current_and_required_platforms() {
        let error = validate_route_platform("ultralytics.pt.edgetpu", host("linux", "aarch64"))
            .expect_err("ARM Linux must be rejected");

        assert!(error.contains("Linux ARM64"));
        assert!(error.contains("Linux x86-64"));
    }
}
