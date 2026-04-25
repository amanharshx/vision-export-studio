use std::process::Command;

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub name: String,
    pub vram_gb: Option<u32>,
}

#[tauri::command]
pub fn list_gpus() -> Vec<GpuInfo> {
    let mut gpus = try_nvidia_smi().unwrap_or_default();
    if gpus.is_empty() {
        #[cfg(target_os = "macos")]
        {
            gpus = try_system_profiler().unwrap_or_default();
        }
    }
    gpus
}

fn try_nvidia_smi() -> Option<Vec<GpuInfo>> {
    let output = Command::new("nvidia-smi")
        .args([
            "--query-gpu=name,memory.total",
            "--format=csv,noheader,nounits",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    let gpus = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|line| {
            let mut parts = line.splitn(2, ',');
            let name = parts.next().unwrap_or("").trim().to_string();
            let vram_gb = parts
                .next()
                .and_then(|s| s.trim().parse::<u32>().ok())
                .map(|mb| mb / 1024);
            GpuInfo { name, vram_gb }
        })
        .filter(|g| !g.name.is_empty())
        .collect();
    Some(gpus)
}

#[cfg(target_os = "macos")]
fn try_system_profiler() -> Option<Vec<GpuInfo>> {
    let output = Command::new("system_profiler")
        .args(["SPDisplaysDataType", "-json"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    let displays = json.get("SPDisplaysDataType")?.as_array()?;
    let gpus = displays
        .iter()
        .filter_map(|d| {
            let name = d.get("sppci_model")?.as_str()?.to_string();
            // discrete GPU: "spdisplays_vram" = "24 GB"
            // Apple Silicon: "spdisplays_vram_shared" = "19 GB"
            let vram_gb = d
                .get("spdisplays_vram")
                .or_else(|| d.get("spdisplays_vram_shared"))
                .and_then(|v| v.as_str())
                .and_then(|s| s.split_whitespace().next())
                .and_then(|s| s.parse::<u32>().ok());
            Some(GpuInfo { name, vram_gb })
        })
        .collect();
    Some(gpus)
}
