use std::time::Duration;

use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    pub version: String,
    pub date: String,
    pub notes: String,
}

pub fn is_update_available(version: &str, current_version: &str) -> bool {
    version != current_version
}

pub fn format_pub_date(date: Option<time::OffsetDateTime>) -> String {
    date.and_then(|value| {
        value
            .format(&time::format_description::well_known::Rfc3339)
            .ok()
    })
    .unwrap_or_default()
}

pub fn progress_percent(downloaded: u64, total: Option<u64>) -> Option<u64> {
    let total = total.filter(|total| *total > 0)?;
    Some((downloaded.saturating_mul(100) / total).min(100))
}

#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    app.updater_builder()
        .version_comparator(|current, release| release.version >= current)
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map(|update| {
            update.map(|update| UpdateInfo {
                available: is_update_available(&update.version, &update.current_version),
                version: update.version,
                date: format_pub_date(update.date),
                notes: update.body.unwrap_or_default(),
            })
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let update = app
        .updater_builder()
        .build()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "No update is available to install.".to_string())?;
    let progress_app = app.clone();
    let mut downloaded = 0u64;
    let mut sent = 0u64;
    update
        .download_and_install(
            move |chunk_length, total| {
                downloaded = downloaded.saturating_add(chunk_length as u64);
                let Some(percent) = progress_percent(downloaded, total) else {
                    return;
                };
                if percent == sent {
                    return;
                }
                sent = percent;
                let _ = progress_app.emit("update-progress", percent);
            },
            || {},
        )
        .await
        .map_err(|error| error.to_string())?;
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::{format_pub_date, is_update_available, progress_percent};

    #[test]
    fn equal_versions_are_not_an_update() {
        assert!(!is_update_available("0.1.13", "0.1.13"));
        assert!(is_update_available("0.1.14", "0.1.13"));
    }

    #[test]
    fn progress_needs_a_known_total() {
        assert_eq!(progress_percent(0, None), None);
        assert_eq!(progress_percent(10, Some(0)), None);
        assert_eq!(progress_percent(0, Some(1000)), Some(0));
        assert_eq!(progress_percent(250, Some(1000)), Some(25));
        assert_eq!(progress_percent(1000, Some(1000)), Some(100));
        assert_eq!(progress_percent(2000, Some(1000)), Some(100));
    }

    #[test]
    fn missing_date_formats_empty() {
        assert_eq!(format_pub_date(None), "");
    }

    #[test]
    fn date_formats_as_rfc3339() {
        let parsed = time::OffsetDateTime::parse(
            "2026-03-14T12:00:00Z",
            &time::format_description::well_known::Rfc3339,
        )
        .expect("fixture date parses");
        assert_eq!(format_pub_date(Some(parsed)), "2026-03-14T12:00:00Z");
    }
}
