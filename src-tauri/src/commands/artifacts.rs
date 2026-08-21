use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ArtifactKind {
    File,
    Directory,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArtifactDescriptor {
    pub source_path: PathBuf,
    pub kind: ArtifactKind,
    pub format: String,
    pub qualifier: Option<String>,
    pub precision_or_profile: String,
    pub variant: Option<String>,
    pub extension: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Publication {
    pub paths: Vec<PathBuf>,
    pub run: u32,
}

pub fn publish_artifacts(
    checkpoint: &Path,
    destination: &Path,
    descriptors: &[ArtifactDescriptor],
) -> Result<Publication, String> {
    if descriptors.is_empty() {
        return Err("export produced no validated artifacts".to_string());
    }
    if descriptors
        .iter()
        .any(|descriptor| !descriptor.source_path.exists())
    {
        return Err("validated artifact disappeared before publication".to_string());
    }
    fs::create_dir_all(destination)
        .map_err(|error| format!("failed to create export destination: {}", error))?;

    let stem = checkpoint_stem(checkpoint)?;
    let mut run = next_run(destination, &stem, descriptors)?;
    loop {
        let paths = target_paths(destination, &stem, descriptors, run);
        if paths.iter().all(|path| !path.exists()) {
            let current = next_run(destination, &stem, descriptors)?;
            if current > run {
                run = current;
                continue;
            }
            for (descriptor, target) in descriptors.iter().zip(&paths) {
                publish_one(&descriptor.source_path, target, &descriptor.kind)?;
            }
            return Ok(Publication { paths, run });
        }
        run = run.saturating_add(1);
    }
}

fn checkpoint_stem(checkpoint: &Path) -> Result<String, String> {
    checkpoint
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(str::to_string)
        .ok_or_else(|| format!("checkpoint has no valid filename: {}", checkpoint.display()))
}

fn target_paths(
    destination: &Path,
    stem: &str,
    descriptors: &[ArtifactDescriptor],
    run: u32,
) -> Vec<PathBuf> {
    descriptors
        .iter()
        .map(|descriptor| {
            let mut name = format!("{}_{}", stem, descriptor.format);
            if let Some(qualifier) = &descriptor.qualifier {
                name.push('_');
                name.push_str(qualifier);
            }
            name.push('_');
            name.push_str(&descriptor.precision_or_profile);
            if run > 1 {
                name.push('_');
                name.push_str(&run.to_string());
            }
            if let Some(variant) = &descriptor.variant {
                name.push('_');
                name.push_str(variant);
            }
            if let Some(extension) = &descriptor.extension {
                name.push('.');
                name.push_str(extension);
            }
            destination.join(name)
        })
        .collect()
}

fn next_run(
    destination: &Path,
    stem: &str,
    descriptors: &[ArtifactDescriptor],
) -> Result<u32, String> {
    let expected = descriptors
        .iter()
        .filter_map(|descriptor| descriptor.variant.as_deref())
        .collect::<Vec<_>>();
    let family = family_prefix(stem, &descriptors[0]);
    let entries = match fs::read_dir(destination) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(1),
        Err(error) => return Err(format!("failed to scan export destination: {}", error)),
    };
    let mut highest = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Some(run) = parse_family_run(
            name,
            &family,
            &expected,
            descriptors[0].extension.as_deref(),
        ) else {
            continue;
        };
        highest = highest.max(run);
    }
    Ok(if highest == 0 { 1 } else { highest + 1 })
}

fn family_prefix(stem: &str, descriptor: &ArtifactDescriptor) -> String {
    let mut prefix = format!("{}_{}", stem, descriptor.format);
    if let Some(qualifier) = &descriptor.qualifier {
        prefix.push('_');
        prefix.push_str(qualifier);
    }
    prefix.push('_');
    prefix.push_str(&descriptor.precision_or_profile);
    prefix
}

fn parse_family_run(
    name: &str,
    family: &str,
    variants: &[&str],
    extension: Option<&str>,
) -> Option<u32> {
    let without_extension = extension
        .and_then(|extension| name.strip_suffix(&format!(".{}", extension)))
        .unwrap_or(name);
    if !variants.is_empty() {
        let variant = variants
            .iter()
            .find(|variant| without_extension.ends_with(&format!("_{}", variant)))?;
        let suffix = format!("_{}", variant);
        if !without_extension.starts_with(family) {
            return None;
        }
        let run_part = without_extension
            .strip_prefix(family)?
            .strip_suffix(&suffix)?
            .strip_prefix('_')
            .unwrap_or("");
        if run_part.is_empty() {
            return Some(1);
        }
        return run_part.parse().ok();
    }
    let remainder = without_extension.strip_prefix(family)?;
    if remainder.is_empty() {
        return Some(1);
    }
    remainder.strip_prefix('_')?.parse().ok()
}

fn publish_one(source: &Path, target: &Path, kind: &ArtifactKind) -> Result<(), String> {
    if target.exists() {
        return Err(format!(
            "artifact destination already exists: {}",
            target.display()
        ));
    }
    match fs::rename(source, target) {
        Ok(()) => Ok(()),
        Err(rename_error) if matches!(kind, ArtifactKind::Directory) => {
            copy_dir_all(source, target).map_err(|copy_error| {
                format!(
                    "failed to publish directory: {}; rename error: {}",
                    copy_error, rename_error
                )
            })?;
            fs::remove_dir_all(source)
                .map_err(|error| format!("failed to remove staged directory: {}", error))
        }
        Err(rename_error) => {
            fs::copy(source, target).map_err(|copy_error| {
                format!(
                    "failed to publish artifact: {}; rename error: {}",
                    copy_error, rename_error
                )
            })?;
            fs::remove_file(source)
                .map_err(|error| format!("failed to remove source artifact: {}", error))
        }
    }
}

fn copy_dir_all(source: &Path, target: &Path) -> std::io::Result<()> {
    fs::create_dir(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if source_path.is_dir() {
            copy_dir_all(&source_path, &target_path)?;
        } else {
            fs::copy(source_path, target_path)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("ves-artifacts-{}-{}", name, uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn file_descriptor(source: &std::path::Path, precision: &str) -> ArtifactDescriptor {
        ArtifactDescriptor {
            source_path: source.to_path_buf(),
            kind: ArtifactKind::File,
            format: "onnx".into(),
            qualifier: None,
            precision_or_profile: precision.into(),
            variant: None,
            extension: Some("onnx".into()),
        }
    }

    #[test]
    fn preserves_exact_checkpoint_stem_and_canonical_suffix_order() {
        let root = temp_dir("stem");
        let source = root.join("Model V2.final.PT");
        fs::write(&source, b"checkpoint").unwrap();
        let upstream = root.join("upstream.onnx");
        fs::write(&upstream, b"artifact").unwrap();
        let mut descriptor = file_descriptor(&upstream, "fp32");
        descriptor.source_path = upstream;
        let publication = publish_artifacts(&source, &root, &[descriptor]).unwrap();
        assert_eq!(
            publication.paths[0].file_name().unwrap(),
            "Model V2.final_onnx_fp32.onnx"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn ignores_legacy_and_unrelated_files_and_uses_highest_visible_run() {
        let root = temp_dir("runs");
        let source = root.join("best.pt");
        fs::write(&source, b"checkpoint").unwrap();
        for name in [
            "best.onnx",
            "best_int8.onnx",
            "best_onnx_fp32.onnx",
            "best_onnx_fp32_3.onnx",
        ] {
            fs::write(root.join(name), b"existing").unwrap();
        }
        let upstream = root.join("new.onnx");
        fs::write(&upstream, b"new").unwrap();
        let publication =
            publish_artifacts(&source, &root, &[file_descriptor(&upstream, "fp32")]).unwrap();
        assert_eq!(publication.run, 4);
        assert!(root.join("best_onnx_fp32_4.onnx").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn allocates_shared_run_for_set_and_reallocates_after_final_collision() {
        let root = temp_dir("set");
        let source = root.join("checkpoint.pth");
        fs::write(&source, b"checkpoint").unwrap();
        let first = root.join("fp32.tflite");
        let second = root.join("fp16.tflite");
        fs::write(&first, b"one").unwrap();
        fs::write(&second, b"two").unwrap();
        let descriptors = vec![
            ArtifactDescriptor {
                source_path: first,
                kind: ArtifactKind::File,
                format: "tflite".into(),
                qualifier: None,
                precision_or_profile: "int8".into(),
                variant: Some("fp32".into()),
                extension: Some("tflite".into()),
            },
            ArtifactDescriptor {
                source_path: second,
                kind: ArtifactKind::File,
                format: "tflite".into(),
                qualifier: None,
                precision_or_profile: "int8".into(),
                variant: Some("fp16".into()),
                extension: Some("tflite".into()),
            },
        ];
        let publication = publish_artifacts(&source, &root, &descriptors).unwrap();
        assert_eq!(publication.run, 1);
        assert!(root.join("checkpoint_tflite_int8_fp32.tflite").exists());
        assert!(root.join("checkpoint_tflite_int8_fp16.tflite").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn incomplete_set_reserves_existing_run() {
        let root = temp_dir("incomplete-set");
        let source = root.join("checkpoint.pth");
        fs::write(&source, b"checkpoint").unwrap();
        fs::write(
            root.join("checkpoint_tflite_int8_2_fp16.tflite"),
            b"existing",
        )
        .unwrap();
        let descriptors = ["fp32", "fp16", "dynamic_range_quant"].map(|variant| {
            let artifact = root.join(format!("{}.tflite", variant));
            fs::write(&artifact, variant.as_bytes()).unwrap();
            ArtifactDescriptor {
                source_path: artifact,
                kind: ArtifactKind::File,
                format: "tflite".into(),
                qualifier: None,
                precision_or_profile: "int8".into(),
                variant: Some(variant.into()),
                extension: Some("tflite".into()),
            }
        });
        let publication = publish_artifacts(&source, &root, &descriptors).unwrap();
        assert_eq!(publication.run, 3);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn preserves_directory_bundle_kind_and_layout() {
        let root = temp_dir("bundle");
        let source = root.join("best.pt");
        fs::write(&source, b"checkpoint").unwrap();
        let bundle = root.join("upstream");
        fs::create_dir_all(bundle.join("variables")).unwrap();
        fs::write(bundle.join("saved_model.pb"), b"model").unwrap();
        fs::write(bundle.join("variables/part"), b"weights").unwrap();
        let descriptor = ArtifactDescriptor {
            source_path: bundle,
            kind: ArtifactKind::Directory,
            format: "saved_model".into(),
            qualifier: None,
            precision_or_profile: "fp32".into(),
            variant: None,
            extension: None,
        };
        let publication = publish_artifacts(&source, &root, &[descriptor]).unwrap();
        assert_eq!(
            publication.paths[0].file_name().unwrap(),
            "best_saved_model_fp32"
        );
        assert!(root.join("best_saved_model_fp32/variables/part").exists());
        let _ = fs::remove_dir_all(root);
    }
}
