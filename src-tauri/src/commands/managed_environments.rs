use std::collections::HashMap;
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::State;

use crate::commands::setup::load_settings;
use crate::commands::stack_environments::{known_stacks, stack_venv_dir_for_key};

pub const ULTRALYTICS_MANAGED_KEY: &str = "ultralytics-managed";
pub const RFDETR_ALL_KEY: &str = "rfdetr-all";

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ManagedEnvironmentScanStatus {
    Available,
    Unavailable,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct ManagedEnvironmentScanResult {
    pub key: String,
    pub status: ManagedEnvironmentScanStatus,
    pub estimated_logical_bytes: Option<u64>,
    pub size_error: Option<String>,
    pub exists: Option<bool>,
}

type ScanKey = (String, String);

#[derive(Default, Clone)]
pub struct ManagedEnvironments {
    cache: Arc<Mutex<HashMap<ScanKey, u64>>>,
    generations: Arc<Mutex<HashMap<ScanKey, u64>>>,
}

fn normalize_runtime_root(root: &Path) -> Result<PathBuf, String> {
    if root.as_os_str().is_empty() {
        return Err("managed runtime root must not be empty".to_string());
    }
    let absolute = if root.is_absolute() {
        root.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| format!("failed to resolve managed runtime root: {error}"))?
            .join(root)
    };
    Ok(absolute)
}

fn normalized_cache_root(root: &Path) -> Result<PathBuf, String> {
    let normalized = normalize_runtime_root(root)?;
    if let Ok(metadata) = fs::symlink_metadata(&normalized) {
        if metadata.file_type().is_symlink() {
            return Err("managed runtime root must not be a symlink".to_string());
        }
    }
    if normalized.exists() {
        fs::canonicalize(&normalized)
            .map_err(|error| format!("failed to canonicalize managed runtime root: {error}"))
    } else {
        Ok(normalized)
    }
}

fn target_keys(root: &Path, key: &str) -> Result<Vec<String>, String> {
    if key == ULTRALYTICS_MANAGED_KEY {
        return Ok(vec![key.to_string()]);
    }
    if key == RFDETR_ALL_KEY {
        let root = normalize_runtime_root(root)?;
        let mut keys = Vec::new();
        for stack in known_stacks() {
            let target =
                stack_venv_dir_for_key(&root, stack.key).expect("known stack must resolve");
            match fs::symlink_metadata(target) {
                Ok(_) => keys.push(stack.key.to_string()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!("cannot inspect RF-DETR environment: {error}"));
                }
            }
        }
        return Ok(keys);
    }
    if known_stacks().iter().any(|stack| stack.key == key) {
        return Ok(vec![key.to_string()]);
    }
    Err(format!("unknown managed environment key: {key}"))
}

fn resolve_target_path(root: &Path, key: &str) -> Result<Vec<PathBuf>, String> {
    let root = normalize_runtime_root(root)?;
    let targets: Vec<PathBuf> = target_keys(&root, key).map(|keys| {
        keys.into_iter()
            .map(|key| {
                if key == ULTRALYTICS_MANAGED_KEY {
                    root.join(".venv")
                } else {
                    stack_venv_dir_for_key(&root, &key).expect("known stack must resolve")
                }
            })
            .collect()
    })?;
    for target in &targets {
        validate_target_path(&root, target)?;
    }
    Ok(targets)
}

fn validate_target_path(root: &Path, target: &Path) -> Result<(), String> {
    let root_metadata = match fs::symlink_metadata(root) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("cannot inspect managed runtime root: {error}")),
    };
    if root_metadata
        .as_ref()
        .is_some_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err("managed runtime root must not be a symlink".to_string());
    }
    let relative = target
        .strip_prefix(root)
        .map_err(|_| "managed environment target escaped managed runtime root".to_string())?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(
                "managed environment target contains an invalid path component".to_string(),
            );
        };
        current.push(name);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(format!(
                    "managed environment target contains symlink: {}",
                    current.display()
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => {
                return Err(format!(
                    "cannot inspect managed environment target: {error}"
                ))
            }
        }
    }
    let target_exists = target
        .try_exists()
        .map_err(|error| format!("cannot inspect managed environment target: {error}"))?;
    if target_exists
        && !fs::symlink_metadata(target)
            .map_err(|error| format!("cannot inspect managed environment target: {error}"))?
            .is_dir()
    {
        return Err("managed environment target is not a directory".to_string());
    }
    Ok(())
}
fn scan_logical_size(path: &Path) -> Result<u64, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(format!("cannot inspect {}: {error}", path.display())),
    };
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "managed environment target is a symlink: {}",
            path.display()
        ));
    }
    if metadata.is_file() {
        return Ok(metadata.len());
    }
    if !metadata.is_dir() {
        return Err(format!(
            "cannot size unsupported filesystem entry: {}",
            path.display()
        ));
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o444 == 0 {
        return Err(format!("cannot read {}: permission denied", path.display()));
    }

    let mut total = 0u64;
    let entries =
        fs::read_dir(path).map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| {
            format!("cannot read directory entry in {}: {error}", path.display())
        })?;
        let child = entry.path();
        let child_metadata = match fs::symlink_metadata(&child) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("cannot inspect {}: {error}", child.display())),
        };
        if child_metadata.file_type().is_symlink() {
            continue;
        }
        total = total
            .checked_add(scan_logical_size(&child)?)
            .ok_or_else(|| "managed environment size exceeded u64".to_string())?;
    }
    Ok(total)
}
impl ManagedEnvironments {
    fn cache_key(root: &Path, key: &str) -> Result<(String, String), String> {
        let normalized_root = normalized_cache_root(root)?;
        if key != ULTRALYTICS_MANAGED_KEY && stack_venv_dir_for_key(root, key).is_none() {
            return Err(format!("unknown managed environment key: {key}"));
        }
        Ok((
            normalized_root.to_string_lossy().into_owned(),
            key.to_string(),
        ))
    }

    pub(crate) fn scan_sync(&self, root: &Path, key: &str) -> Result<u64, String> {
        let cache_key = Self::cache_key(root, key)?;
        let generation = self
            .generations
            .lock()
            .map_err(|_| "managed environment generation lock poisoned".to_string())?
            .get(&cache_key)
            .copied()
            .unwrap_or(0);
        if let Some(bytes) = self
            .cache
            .lock()
            .map_err(|_| "managed environment cache lock poisoned".to_string())?
            .get(&cache_key)
            .copied()
        {
            return Ok(bytes);
        }
        let result = (|| {
            let targets = resolve_target_path(root, key)?;
            let mut total = 0u64;
            for target in targets {
                total = total
                    .checked_add(scan_logical_size(&target)?)
                    .ok_or_else(|| "managed environment size exceeded u64".to_string())?;
            }
            Ok(total)
        })();
        if let Ok(bytes) = result {
            if let Ok(generations) = self.generations.lock() {
                let current_generation = generations.get(&cache_key).copied().unwrap_or(generation);
                if generation == current_generation {
                    if let Ok(mut cache) = self.cache.lock() {
                        cache.insert(cache_key.clone(), bytes);
                    }
                }
            }
        }
        result
    }

    pub(crate) fn invalidate<I, S>(&self, root: &Path, keys: I)
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let Ok(normalized_root) = normalized_cache_root(root) else {
            return;
        };
        let root_key = normalized_root.to_string_lossy().into_owned();
        let Ok(mut generations) = self.generations.lock() else {
            return;
        };
        let Ok(mut cache) = self.cache.lock() else {
            return;
        };
        for requested in keys {
            let Ok(actual_keys) = target_keys(root, requested.as_ref()) else {
                continue;
            };
            for key in actual_keys {
                let cache_key = (root_key.clone(), key.clone());
                *generations.entry(cache_key.clone()).or_insert(0) += 1;
                cache.remove(&cache_key);
            }
        }
    }
}

pub(crate) fn scan_results(
    owner: &ManagedEnvironments,
    root: &Path,
    keys: &[String],
) -> Result<Vec<ManagedEnvironmentScanResult>, String> {
    if keys.is_empty() {
        return Err("managed environment keys must not be empty".to_string());
    }
    let mut results = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for requested in keys {
        for key in target_keys(root, requested)? {
            if !seen.insert(key.clone()) {
                continue;
            }
            let exists = resolve_target_path(root, &key).ok().and_then(|targets| {
                targets
                    .iter()
                    .map(|target| target.try_exists())
                    .collect::<Result<Vec<_>, _>>()
                    .ok()
                    .map(|results| results.into_iter().all(|exists| exists))
            });
            match owner.scan_sync(root, &key) {
                Ok(bytes) => results.push(ManagedEnvironmentScanResult {
                    key,
                    status: ManagedEnvironmentScanStatus::Available,
                    estimated_logical_bytes: Some(bytes),
                    size_error: None,
                    exists,
                }),
                Err(error) => results.push(ManagedEnvironmentScanResult {
                    key,
                    status: ManagedEnvironmentScanStatus::Unavailable,
                    estimated_logical_bytes: None,
                    size_error: Some(error),
                    exists,
                }),
            }
        }
    }
    Ok(results)
}
#[tauri::command]
pub async fn scan_managed_environments(
    app_handle: tauri::AppHandle,
    owner: State<'_, ManagedEnvironments>,
    keys: Vec<String>,
) -> Result<Vec<ManagedEnvironmentScanResult>, String> {
    let root = PathBuf::from(load_settings(app_handle)?.runtime_dir);
    let owner = owner.inner().clone();
    tauri::async_runtime::spawn_blocking(move || scan_results(&owner, &root, &keys))
        .await
        .map_err(|error| format!("managed environment scan task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    fn temp_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "vision-export-studio-managed-environments-{label}-{}",
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn logical_size_counts_nested_regular_files_without_following_symlinks() {
        let root = temp_root("size");
        fs::create_dir_all(root.join("nested/deeper")).unwrap();
        fs::write(root.join("nested/a.bin"), b"1234").unwrap();
        fs::write(root.join("nested/deeper/b.bin"), b"567890").unwrap();
        fs::write(root.join("outside.bin"), vec![0u8; 100]).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("outside.bin"), root.join("nested/link")).unwrap();
        assert_eq!(scan_logical_size(&root).unwrap(), 110);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn missing_and_empty_environment_both_have_zero_logical_bytes() {
        let root = temp_root("missing-empty");
        assert_eq!(scan_logical_size(&root).unwrap(), 0);
        fs::create_dir_all(&root).unwrap();
        assert_eq!(scan_logical_size(&root).unwrap(), 0);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_directory_is_not_traversed() {
        let root = temp_root("symlink-dir");
        let outside = temp_root("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("hidden"), vec![0u8; 128]).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("linked-dir")).unwrap();
        fs::write(root.join("visible"), b"visible").unwrap();
        assert_eq!(scan_logical_size(&root).unwrap(), 7);
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn successful_sizes_are_cached_and_targeted_invalidation_preserves_other_keys() {
        let root = temp_root("cache");
        let ultralytics = root.join(".venv");
        let stack = root.join("envs/rfdetr-default/.venv");
        fs::create_dir_all(&ultralytics).unwrap();
        fs::create_dir_all(&stack).unwrap();
        fs::write(ultralytics.join("a"), b"123").unwrap();
        fs::write(stack.join("b"), b"12345").unwrap();
        let owner = ManagedEnvironments::default();
        assert_eq!(owner.scan_sync(&root, ULTRALYTICS_MANAGED_KEY).unwrap(), 3);
        fs::write(ultralytics.join("new"), b"6789").unwrap();
        assert_eq!(owner.scan_sync(&root, ULTRALYTICS_MANAGED_KEY).unwrap(), 3);
        owner.invalidate(&root, [ULTRALYTICS_MANAGED_KEY]);
        assert_eq!(owner.scan_sync(&root, ULTRALYTICS_MANAGED_KEY).unwrap(), 7);
        assert_eq!(owner.scan_sync(&root, "rfdetr-default").unwrap(), 5);
        owner.invalidate(&root, [ULTRALYTICS_MANAGED_KEY]);
        assert_eq!(owner.scan_sync(&root, "rfdetr-default").unwrap(), 5);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn failed_scan_never_becomes_zero_size() {
        let root = temp_root("failed");
        fs::create_dir_all(root.join("envs/rfdetr-default/.venv")).unwrap();
        #[cfg(unix)]
        fs::set_permissions(
            root.join("envs/rfdetr-default/.venv"),
            fs::Permissions::from_mode(0o000),
        )
        .unwrap();
        let result = scan_results(
            &ManagedEnvironments::default(),
            &root,
            &["rfdetr-default".to_string()],
        )
        .unwrap();
        #[cfg(unix)]
        assert!(result[0].estimated_logical_bytes.is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn scan_rejects_symlinked_runtime_component_before_reading_outside_root() {
        let root = temp_root("symlink-component");
        let outside = temp_root("symlink-component-outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(outside.join("rfdetr-default/.venv")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("envs")).unwrap();

        let result = scan_results(
            &ManagedEnvironments::default(),
            &root,
            &["rfdetr-default".to_string()],
        )
        .unwrap();
        assert_eq!(result[0].exists, None);
        assert!(result[0].estimated_logical_bytes.is_none());
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }
}
