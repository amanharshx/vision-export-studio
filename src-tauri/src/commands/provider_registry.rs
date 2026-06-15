use std::path::Path;

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
    "ultralytics.pt.tflite",
    "ultralytics.pt.engine",
    "ultralytics.pt.rknn",
    "ultralytics.pt.executorch",
    "ultralytics.pt.edgetpu",
    "ultralytics.pt.tfjs",
    "ultralytics.pt.paddle",
    "ultralytics.pt.imx",
    "ultralytics.pt.axelera",
    "ultralytics.pt.saved_model",
    "ultralytics.pt.pb",
];

pub const RFDETR_ROUTES: &[&str] = &["rfdetr.pth.onnx", "rfdetr.pth.engine"];

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

pub enum RfDetrArtifactRule {
    Named {
        extension: &'static str,
        prefix: &'static str,
        exact: &'static str,
    },
}

pub fn rfdetr_artifact_rule(route_id: &str) -> Option<RfDetrArtifactRule> {
    match route_id {
        "rfdetr.pth.onnx" => Some(RfDetrArtifactRule::Named {
            extension: ".onnx",
            prefix: "rfdetr-",
            exact: "inference_model",
        }),
        "rfdetr.pth.engine" => Some(RfDetrArtifactRule::Named {
            extension: ".engine",
            prefix: "rfdetr-",
            exact: "inference_model",
        }),
        _ => None,
    }
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

    #[test]
    fn validates_provider_route_match() {
        assert!(validate_provider_route("ultralytics", "ultralytics.pt.onnx").is_ok());
        assert!(validate_provider_route("rfdetr", "rfdetr.pth.onnx").is_ok());
        assert!(validate_provider_route("rfdetr", "rfdetr.pth.tflite").is_err());
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
    fn validates_source_extension_by_provider() {
        assert!(validate_source_extension(ProviderId::Ultralytics, "/tmp/best.pt").is_ok());
        assert!(validate_source_extension(ProviderId::Ultralytics, "/tmp/best.pth").is_err());
        assert!(validate_source_extension(ProviderId::RfDetr, "/tmp/checkpoint.pth").is_ok());
        assert!(validate_source_extension(ProviderId::RfDetr, "/tmp/checkpoint.pt").is_err());
    }

    #[test]
    fn rfdetr_onnx_expects_named_rule() {
        assert!(matches!(
            rfdetr_artifact_rule("rfdetr.pth.onnx"),
            Some(RfDetrArtifactRule::Named { .. })
        ));
    }

    #[test]
    fn rfdetr_engine_expects_named_rule() {
        assert!(matches!(
            rfdetr_artifact_rule("rfdetr.pth.engine"),
            Some(RfDetrArtifactRule::Named { .. })
        ));
    }

    #[test]
    fn plus_only_manual_classes_are_rejected() {
        assert!(validate_rfdetr_manual_class("RFDETRSmall").is_ok());
        assert!(validate_rfdetr_manual_class("RFDETRXLarge").is_err());
    }
}
