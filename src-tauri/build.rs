use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=../.git/HEAD");
    if let Some(date) = Command::new("git")
        .args(["log", "-1", "--format=%cs"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .filter(|date| !date.is_empty())
    {
        println!("cargo:rustc-env=VISION_EXPORT_STUDIO_DATE={date}");
    }
    tauri_build::build()
}
