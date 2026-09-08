use std::path::PathBuf;
use std::process::Command;

fn git_dir() -> Option<PathBuf> {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").ok()?;
    let dot_git = PathBuf::from(&manifest).join("../.git");
    let git = if dot_git.join("HEAD").is_file() {
        dot_git
    } else {
        // Linked worktrees keep a pointer file here instead of a directory.
        let content = std::fs::read_to_string(&dot_git).ok()?;
        let dir = PathBuf::from(content.strip_prefix("gitdir:")?.trim());
        if dir.is_absolute() {
            dir
        } else {
            PathBuf::from(&manifest).join("../").join(dir)
        }
    };
    std::fs::canonicalize(&git).ok().or(Some(git))
}

fn watch_git_head() {
    let Some(git) = git_dir() else { return };
    println!("cargo:rerun-if-changed={}/HEAD", git.display());
    // HEAD is usually an unchanged symref line, so also watch the ref it
    // points at. Otherwise new commits never rerun this script and the
    // build date goes stale on incremental builds.
    let Ok(head) = std::fs::read_to_string(git.join("HEAD")) else {
        return;
    };
    let Some(target) = head.strip_prefix("ref:").map(str::trim) else {
        return;
    };
    // Linked worktrees share refs through the common dir.
    let common = std::fs::read_to_string(git.join("commondir"))
        .map(|dir| git.join(dir.trim()))
        .unwrap_or_else(|_| git.clone());
    let ref_path = common.join(target);
    // Watch the loose ref unconditionally: Cargo also reruns when a watched
    // path comes into existence, which covers a packed ref becoming loose
    // on the next commit. Watch packed-refs too when present.
    println!("cargo:rerun-if-changed={}", ref_path.display());
    if common.join("packed-refs").is_file() {
        println!("cargo:rerun-if-changed={}/packed-refs", common.display());
    }
}

fn main() {
    watch_git_head();
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
