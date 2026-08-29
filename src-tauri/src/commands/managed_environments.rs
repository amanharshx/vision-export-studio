use std::collections::HashMap;
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::State;

use crate::commands::runtime_operations::{RuntimeOperation, RuntimeOperationCoordinator};
use crate::commands::setup::{
    load_settings, normalize_setup_after_managed_runtime_cleanup, SettingsState,
};
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

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ManagedEnvironmentCleanupResult {
    Succeeded {
        key: String,
        estimated_logical_bytes: Option<u64>,
    },
    Failed {
        key: String,
        error: String,
    },
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct ManagedEnvironmentCleanupReport {
    pub results: Vec<ManagedEnvironmentCleanupResult>,
    pub setup_complete: Option<bool>,
    /// Set when environment deletion succeeded but persisting the derived
    /// setup state failed. The successful deletion report is still returned so
    /// the UI can refresh inventory and surface the persistence failure.
    pub setup_error: Option<String>,
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

fn target_path(root: &Path, key: &str) -> Result<PathBuf, String> {
    if key == ULTRALYTICS_MANAGED_KEY {
        return Ok(root.join(".venv"));
    }
    stack_venv_dir_for_key(root, key)
        .ok_or_else(|| format!("unknown managed environment key: {key}"))
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
    if target.exists() {
        let canonical_root = fs::canonicalize(root)
            .map_err(|error| format!("cannot canonicalize managed runtime root: {error}"))?;
        let canonical_target = fs::canonicalize(target)
            .map_err(|error| format!("cannot canonicalize managed environment target: {error}"))?;
        if !canonical_target.starts_with(&canonical_root) {
            return Err("managed environment target is outside managed runtime root".to_string());
        }
        if !fs::symlink_metadata(target)
            .map_err(|error| format!("cannot inspect managed environment target: {error}"))?
            .is_dir()
        {
            return Err("managed environment target is not a directory".to_string());
        }
    }
    Ok(())
}

pub(crate) fn resolve_target_path(root: &Path, key: &str) -> Result<Vec<PathBuf>, String> {
    let normalized_root = normalize_runtime_root(root)?;
    let targets: Vec<PathBuf> = target_keys(root, key)?
        .into_iter()
        .map(|key| target_path(&normalized_root, &key))
        .collect::<Result<_, _>>()?;
    for target in &targets {
        validate_target_path(&normalized_root, target)?;
    }
    Ok(targets)
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

fn make_tree_removable(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("cannot inspect {}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() {
        return Ok(());
    }
    #[cfg(windows)]
    {
        let mut permissions = metadata.permissions();
        permissions.set_readonly(false);
        fs::set_permissions(path, permissions)
            .map_err(|error| format!("cannot prepare {} for removal: {error}", path.display()))?;
    }
    if !metadata.is_dir() {
        return Ok(());
    }
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("cannot prepare {} for removal: {error}", path.display()))?;
    for entry in fs::read_dir(path)
        .map_err(|error| format!("cannot read {} for removal: {error}", path.display()))?
    {
        let entry = entry.map_err(|error| {
            format!("cannot read directory entry in {}: {error}", path.display())
        })?;
        make_tree_removable(&entry.path())?;
    }
    Ok(())
}

impl ManagedEnvironments {
    fn cache_key(root: &Path, key: &str) -> Result<(String, String), String> {
        let normalized_root = normalized_cache_root(root)?;
        target_path(root, key)?;
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
                validate_target_path(&normalize_runtime_root(root)?, &target)?;
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

fn cleanup_sync_with_remover<F>(
    owner: &ManagedEnvironments,
    root: &Path,
    keys: &[String],
    mut remove_target: F,
) -> Result<ManagedEnvironmentCleanupReport, String>
where
    F: FnMut(&Path) -> Result<(), String>,
{
    if keys.is_empty() {
        return Err("managed environment keys must not be empty".to_string());
    }
    let normalized_root = normalize_runtime_root(root)?;
    let mut targets = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for requested in keys {
        for key in target_keys(root, requested)? {
            if !seen.insert(key.clone()) {
                continue;
            }
            let target = target_path(&normalized_root, &key)?;
            validate_target_path(&normalized_root, &target)?;
            targets.push((key, target));
        }
    }

    let mut reports = Vec::new();
    let mut measured = Vec::new();
    for (key, target) in &targets {
        if !target.exists() {
            measured.push((key.clone(), target.clone(), Some(0)));
            continue;
        }
        let estimate = owner.scan_sync(&normalized_root, key).ok();
        measured.push((key.clone(), target.clone(), estimate));
    }
    for (key, target, estimate) in measured {
        let target_existed = target.exists();
        let mut attempted_removal = false;
        let outcome = (|| {
            validate_target_path(&normalized_root, &target)?;
            if target.exists() {
                attempted_removal = true;
                remove_target(&target)?;
                if target.exists() {
                    return Err("managed environment still exists after deletion".to_string());
                }
            }
            Ok::<(), String>(())
        })();
        if attempted_removal || !target_existed {
            // Removal can partially mutate a target before returning an error,
            // and confirmed absence can race with a cached scan; never serve
            // the pre-removal size from the cache afterward.
            owner.invalidate(&normalized_root, [key.as_str()]);
        }
        match outcome {
            Ok(()) => reports.push(ManagedEnvironmentCleanupResult::Succeeded {
                key,
                estimated_logical_bytes: estimate,
            }),
            Err(error) => reports.push(ManagedEnvironmentCleanupResult::Failed { key, error }),
        }
    }
    Ok(ManagedEnvironmentCleanupReport {
        results: reports,
        setup_complete: None,
        setup_error: None,
    })
}

pub(crate) fn cleanup_sync(
    owner: &ManagedEnvironments,
    root: &Path,
    keys: &[String],
) -> Result<ManagedEnvironmentCleanupReport, String> {
    cleanup_sync_with_remover(owner, root, keys, |target| {
        make_tree_removable(target)?;
        fs::remove_dir_all(target)
            .map_err(|error| format!("failed to remove {}: {error}", target.display()))
    })
}

fn cleanup_report_confirms_ultralytics(report: &ManagedEnvironmentCleanupReport) -> bool {
    report.results.iter().any(|result| {
        matches!(
            result,
            ManagedEnvironmentCleanupResult::Succeeded { key, .. }
                if key == ULTRALYTICS_MANAGED_KEY
        )
    })
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

#[tauri::command]
pub async fn cleanup_managed_environments(
    app_handle: tauri::AppHandle,
    owner: State<'_, ManagedEnvironments>,
    settings: State<'_, SettingsState>,
    runtime_operations: State<'_, RuntimeOperationCoordinator>,
    keys: Vec<String>,
) -> Result<ManagedEnvironmentCleanupReport, String> {
    if keys.is_empty() {
        return Err("managed environment keys must not be empty".to_string());
    }
    let root = PathBuf::from(load_settings(app_handle.clone())?.runtime_dir);
    for key in &keys {
        target_keys(&root, key)?;
    }
    let includes_ultralytics = keys.iter().any(|key| key == ULTRALYTICS_MANAGED_KEY);
    let guard = runtime_operations.acquire(RuntimeOperation::Cleanup)?;
    let owner = owner.inner().clone();
    let mut report =
        tauri::async_runtime::spawn_blocking(move || cleanup_sync(&owner, &root, &keys))
            .await
            .map_err(|error| format!("managed environment cleanup task failed: {error}"))??;

    if includes_ultralytics && cleanup_report_confirms_ultralytics(&report) {
        match normalize_setup_after_managed_runtime_cleanup(&app_handle, settings.inner()) {
            Ok(setup_complete) => report.setup_complete = Some(setup_complete),
            // Deletion already succeeded; surface the persistence failure
            // separately instead of discarding the successful deletion report.
            Err(error) => report.setup_error = Some(error),
        }
    }
    drop(guard);
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "vision-export-studio-managed-environments-{label}-{}",
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn fixed_registry_rejects_unknown_lookalike_and_escape_keys() {
        let root = temp_root("registry");
        assert!(resolve_target_path(&root, "ultralytics-managed").is_ok());
        assert!(resolve_target_path(&root, "rfdetr-all").is_ok());
        assert!(resolve_target_path(&root, "rfdetr-default").is_ok());
        assert!(resolve_target_path(&root, "rfdetr-default/").is_err());
        assert!(resolve_target_path(&root, "../.venv").is_err());
        assert!(resolve_target_path(&root, "not-a-managed-environment").is_err());
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

    #[cfg(unix)]
    #[test]
    fn symlinked_runtime_root_is_rejected() {
        let actual = temp_root("actual-root");
        let linked = temp_root("linked-root");
        fs::create_dir_all(&actual).unwrap();
        std::os::unix::fs::symlink(&actual, &linked).unwrap();
        assert!(resolve_target_path(&linked, "ultralytics-managed").is_err());
        let _ = fs::remove_dir_all(actual);
        let _ = fs::remove_file(linked);
    }
    #[test]
    fn missing_scan_is_zero_but_symlink_target_is_unavailable() {
        let root = temp_root("missing");
        assert_eq!(scan_logical_size(&root).unwrap(), 0);
        #[cfg(unix)]
        {
            let target = temp_root("symlink-target");
            fs::create_dir_all(&target).unwrap();
            fs::write(target.join("payload"), b"payload").unwrap();
            let link = temp_root("symlink");
            std::os::unix::fs::symlink(&target, &link).unwrap();
            assert!(scan_logical_size(&link).is_err());
            let _ = fs::remove_dir_all(target);
            let _ = fs::remove_file(link);
        }
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_sync_removes_real_python_venv_with_interpreter_symlinks() {
        let root = temp_root("cleanup-real-venv");
        let target = root.join(".venv");
        fs::create_dir_all(&root).unwrap();
        let status = std::process::Command::new("python3")
            .args(["-m", "venv"])
            .arg(&target)
            .status()
            .expect("python3 must be available for the real venv fixture");
        assert!(status.success(), "python3 -m venv failed: {status}");
        assert!(fs::symlink_metadata(target.join("bin/python"))
            .unwrap()
            .file_type()
            .is_symlink());

        let report = cleanup_sync(
            &ManagedEnvironments::default(),
            &root,
            &[ULTRALYTICS_MANAGED_KEY.to_string()],
        )
        .unwrap();

        assert!(matches!(
            &report.results[0],
            ManagedEnvironmentCleanupResult::Succeeded { key, .. }
                if key == ULTRALYTICS_MANAGED_KEY
        ));
        assert!(!target.exists());
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn successful_sizes_are_cached_and_invalidation_removes_only_affected_keys() {
        let root = temp_root("cache");
        let ultralytics = root.join(".venv");
        let stack = root.join("envs/rfdetr-default/.venv");
        fs::create_dir_all(&ultralytics).unwrap();
        fs::create_dir_all(&stack).unwrap();
        fs::write(ultralytics.join("a"), b"123").unwrap();
        fs::write(stack.join("b"), b"12345").unwrap();
        let owner = ManagedEnvironments::default();
        assert_eq!(owner.scan_sync(&root, "ultralytics-managed").unwrap(), 3);
        fs::write(ultralytics.join("new"), b"6789").unwrap();
        assert_eq!(owner.scan_sync(&root, "ultralytics-managed").unwrap(), 3);
        owner.invalidate(&root, ["ultralytics-managed"]);
        assert_eq!(owner.scan_sync(&root, "ultralytics-managed").unwrap(), 7);
        assert_eq!(owner.scan_sync(&root, "rfdetr-default").unwrap(), 5);
        owner.invalidate(&root, ["ultralytics-managed"]);
        assert_eq!(owner.scan_sync(&root, "rfdetr-default").unwrap(), 5);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn logical_size_does_not_traverse_symlinked_directories() {
        let root = temp_root("size-symlink-directory");
        let outside = temp_root("size-symlink-outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("hidden"), vec![0u8; 128]).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("linked-dir")).unwrap();
        fs::write(root.join("visible"), b"visible").unwrap();
        assert_eq!(scan_logical_size(&root).unwrap(), 7);
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }

    #[cfg(windows)]
    #[test]
    fn make_tree_removable_clears_windows_read_only_attributes() {
        let root = temp_root("readonly-removal");
        let target = root.join("nested");
        fs::create_dir_all(&target).unwrap();
        let file = target.join("readonly.txt");
        fs::write(&file, b"readonly").unwrap();
        let mut permissions = fs::metadata(&file).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&file, permissions).unwrap();

        make_tree_removable(&root).unwrap();

        assert!(!fs::metadata(&file).unwrap().permissions().readonly());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cleanup_sync_deletes_known_target_and_preserves_unrelated_content() {
        let root = temp_root("cleanup-known");
        fs::create_dir_all(root.join(".venv/nested")).unwrap();
        fs::write(root.join(".venv/nested/model"), b"model").unwrap();
        fs::write(root.join("keep.txt"), b"keep").unwrap();

        let report = cleanup_sync(
            &ManagedEnvironments::default(),
            &root,
            &[ULTRALYTICS_MANAGED_KEY.to_string()],
        )
        .unwrap();

        assert_eq!(report.results.len(), 1);
        assert!(matches!(
            &report.results[0],
            ManagedEnvironmentCleanupResult::Succeeded {
                key,
                estimated_logical_bytes: Some(5),
            } if key == ULTRALYTICS_MANAGED_KEY
        ));
        assert!(!root.join(".venv").exists());
        assert!(root.join("keep.txt").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cleanup_sync_with_remover_reports_mixed_results_and_invalidates_failed_cache() {
        let root = temp_root("cleanup-partial-cache");
        let default_target = root.join("envs/rfdetr-default/.venv");
        let coreml_target = root.join("envs/rfdetr-coreml/.venv");
        fs::create_dir_all(&default_target).unwrap();
        fs::create_dir_all(&coreml_target).unwrap();
        fs::write(default_target.join("payload"), b"success").unwrap();
        fs::write(coreml_target.join("payload"), b"survives").unwrap();
        fs::create_dir_all(root.join("envs/rfdetr-default-backup/.venv")).unwrap();
        fs::write(root.join("envs/rfdetr-default-backup/.venv/keep"), b"keep").unwrap();
        fs::write(root.join("lookalike.txt"), b"untouched").unwrap();

        let owner = ManagedEnvironments::default();
        assert_eq!(owner.scan_sync(&root, "rfdetr-default").unwrap(), 7);
        assert_eq!(owner.scan_sync(&root, "rfdetr-coreml").unwrap(), 8);

        let report = cleanup_sync_with_remover(
            &owner,
            &root,
            &["rfdetr-default".to_string(), "rfdetr-coreml".to_string()],
            |target| {
                if target.ends_with(Path::new("envs/rfdetr-coreml/.venv")) {
                    fs::remove_file(target.join("payload")).unwrap();
                    return Err("simulated partial removal".to_string());
                }
                fs::remove_dir_all(target).map_err(|error| error.to_string())
            },
        )
        .unwrap();

        assert!(matches!(
            &report.results[0],
            ManagedEnvironmentCleanupResult::Succeeded { key, estimated_logical_bytes: Some(7) }
                if key == "rfdetr-default"
        ));
        assert!(matches!(
            &report.results[1],
            ManagedEnvironmentCleanupResult::Failed { key, error }
                if key == "rfdetr-coreml" && error == "simulated partial removal"
        ));
        assert!(!default_target.exists());
        assert!(coreml_target.exists());
        assert_eq!(owner.scan_sync(&root, "rfdetr-coreml").unwrap(), 0);
        assert!(root.join("envs/rfdetr-default-backup/.venv/keep").exists());
        assert!(root.join("lookalike.txt").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn single_rfdetr_cleanup_removes_only_exact_venv_and_preserves_backup() {
        let root = temp_root("cleanup-rfdetr-exact");
        let target = root.join("envs/rfdetr-default/.venv");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("payload"), b"payload").unwrap();
        let backup = root.join("envs/rfdetr-default-backup/.venv");
        fs::create_dir_all(&backup).unwrap();
        fs::write(backup.join("keep"), b"keep").unwrap();

        cleanup_sync(
            &ManagedEnvironments::default(),
            &root,
            &["rfdetr-default".to_string()],
        )
        .unwrap();

        assert!(!target.exists());
        assert!(backup.join("keep").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_sync_deletes_target_even_when_size_measurement_fails() {
        use std::os::unix::fs::PermissionsExt;

        let root = temp_root("cleanup-unknown-size");
        let target = root.join(".venv");
        fs::create_dir_all(target.join("unreadable")).unwrap();
        fs::write(target.join("unreadable/payload"), b"payload").unwrap();
        fs::set_permissions(target.join("unreadable"), fs::Permissions::from_mode(0o000)).unwrap();

        let report = cleanup_sync(
            &ManagedEnvironments::default(),
            &root,
            &[ULTRALYTICS_MANAGED_KEY.to_string()],
        )
        .unwrap();

        assert!(matches!(
            &report.results[0],
            ManagedEnvironmentCleanupResult::Succeeded {
                key,
                estimated_logical_bytes: None,
            } if key == ULTRALYTICS_MANAGED_KEY
        ));
        assert!(!target.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn bulk_cleanup_reports_only_existing_known_rfdetr_targets() {
        let root = temp_root("cleanup-bulk");
        fs::create_dir_all(root.join("envs/rfdetr-default/.venv")).unwrap();
        fs::write(root.join("unrelated.txt"), b"unrelated").unwrap();

        let report = cleanup_sync(
            &ManagedEnvironments::default(),
            &root,
            &[RFDETR_ALL_KEY.to_string()],
        )
        .unwrap();

        assert_eq!(report.results.len(), 1);
        assert!(matches!(
            &report.results[0],
            ManagedEnvironmentCleanupResult::Succeeded { key, .. }
                if key == "rfdetr-default"
        ));
        assert!(!root.join("envs/rfdetr-default/.venv").exists());
        assert!(root.join("unrelated.txt").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cleanup_of_externally_absent_target_invalidates_stale_size_cache() {
        let root = temp_root("cleanup-absent-cache");
        let target = root.join("envs/rfdetr-default/.venv");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("payload"), b"cached-size").unwrap();

        let owner = ManagedEnvironments::default();
        assert_eq!(owner.scan_sync(&root, "rfdetr-default").unwrap(), 11);
        fs::remove_dir_all(&target).unwrap();

        let report = cleanup_sync(&owner, &root, &["rfdetr-default".to_string()]).unwrap();
        assert!(matches!(
            &report.results[..],
            [ManagedEnvironmentCleanupResult::Succeeded {
                key,
                estimated_logical_bytes: Some(0),
            }] if key == "rfdetr-default"
        ));
        assert_eq!(owner.scan_sync(&root, "rfdetr-default").unwrap(), 0);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cleanup_preserves_settings_and_export_output_content() {
        let root = temp_root("cleanup-preserves-config");
        fs::create_dir_all(root.join(".venv")).unwrap();
        fs::write(root.join("vision-export-studio-settings.json"), b"settings").unwrap();
        fs::create_dir_all(root.join("exports")).unwrap();
        fs::write(root.join("exports/result.onnx"), b"output").unwrap();

        cleanup_sync(
            &ManagedEnvironments::default(),
            &root,
            &[ULTRALYTICS_MANAGED_KEY.to_string()],
        )
        .unwrap();

        assert!(root.join("vision-export-studio-settings.json").exists());
        assert_eq!(
            fs::read(root.join("exports/result.onnx")).unwrap(),
            b"output"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn bulk_validation_failure_prevents_deleting_any_target() {
        let root = temp_root("cleanup-atomic-validation");
        fs::create_dir_all(root.join("envs/rfdetr-default/.venv")).unwrap();
        let unsafe_target = root.join("envs/rfdetr-tensorrt/.venv");
        fs::create_dir_all(unsafe_target.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(root.join("envs/rfdetr-default/.venv"), &unsafe_target).unwrap();

        assert!(cleanup_sync(
            &ManagedEnvironments::default(),
            &root,
            &[RFDETR_ALL_KEY.to_string()],
        )
        .is_err());
        assert!(root.join("envs/rfdetr-default/.venv").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn failed_ultralytics_cleanup_report_does_not_confirm_setup_normalization() {
        let report = ManagedEnvironmentCleanupReport {
            results: vec![ManagedEnvironmentCleanupResult::Failed {
                key: ULTRALYTICS_MANAGED_KEY.to_string(),
                error: "remove failed".to_string(),
            }],
            setup_complete: None,
            setup_error: None,
        };
        assert!(!cleanup_report_confirms_ultralytics(&report));
    }

    #[test]
    fn cleanup_reports_confirmed_absence_as_success() {
        let root = temp_root("cleanup-absent");
        let report = cleanup_sync(
            &ManagedEnvironments::default(),
            &root,
            &[ULTRALYTICS_MANAGED_KEY.to_string()],
        )
        .unwrap();
        assert!(matches!(
            &report.results[..],
            [ManagedEnvironmentCleanupResult::Succeeded {
                key,
                estimated_logical_bytes: Some(0),
            }] if key == ULTRALYTICS_MANAGED_KEY
        ));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rfdetr_all_preserves_lookalike_siblings() {
        let root = temp_root("cleanup-lookalike");
        fs::create_dir_all(root.join("envs/rfdetr-defaultish/.venv")).unwrap();
        fs::write(root.join("envs/rfdetr-defaultish/.venv/keep"), b"keep").unwrap();
        cleanup_sync(
            &ManagedEnvironments::default(),
            &root,
            &[RFDETR_ALL_KEY.to_string()],
        )
        .unwrap();
        assert!(root.join("envs/rfdetr-defaultish/.venv/keep").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rfdetr_all_propagates_non_not_found_discovery_errors() {
        let root = temp_root("cleanup-discovery-error");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("envs"), b"not a directory").unwrap();
        let error = resolve_target_path(&root, RFDETR_ALL_KEY).unwrap_err();
        assert!(error.contains("managed environment") || error.contains("Not a directory"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn ultralytics_reset_preserves_config_and_persists_setup_state_with_and_without_override() {
        use crate::commands::setup::setup_complete_after_managed_runtime_cleanup;

        let root = temp_root("cleanup-reset-setup-state");
        // Managed runtime plus user config and exported artifacts.
        fs::create_dir_all(root.join(".venv/lib")).unwrap();
        fs::write(root.join(".venv/lib/site.py"), b"runtime").unwrap();
        fs::write(
            root.join("vision-export-studio-settings.json"),
            b"{\"k\":1}",
        )
        .unwrap();
        fs::create_dir_all(root.join("exports")).unwrap();
        fs::write(root.join("exports/model.onnx"), b"artifact").unwrap();

        let report = cleanup_sync(
            &ManagedEnvironments::default(),
            &root,
            &[ULTRALYTICS_MANAGED_KEY.to_string()],
        )
        .unwrap();

        // The managed runtime is removed.
        assert!(matches!(
            &report.results[..],
            [ManagedEnvironmentCleanupResult::Succeeded { key, .. }] if key == ULTRALYTICS_MANAGED_KEY
        ));
        assert!(report.setup_error.is_none());
        assert!(!root.join(".venv").exists());

        // Settings and exported artifacts survive the reset untouched.
        assert_eq!(
            fs::read(root.join("vision-export-studio-settings.json")).unwrap(),
            b"{\"k\":1}"
        );
        assert_eq!(
            fs::read(root.join("exports/model.onnx")).unwrap(),
            b"artifact"
        );

        // After the reset the managed runtime is gone, so setup completion now
        // depends solely on whether an explicit Python override remains.
        let managed_runtime_ready = false;
        assert!(!setup_complete_after_managed_runtime_cleanup(
            managed_runtime_ready,
            None
        ));
        assert!(!setup_complete_after_managed_runtime_cleanup(
            managed_runtime_ready,
            Some("   ")
        ));
        assert!(setup_complete_after_managed_runtime_cleanup(
            managed_runtime_ready,
            Some("/custom/python")
        ));

        let _ = fs::remove_dir_all(root);
    }
}
