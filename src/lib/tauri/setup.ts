import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "@/lib/types";

export function loadSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("load_settings");
}

export function createRuntimeVenv(runtimeDir: string): Promise<string> {
  return invoke<string>("create_runtime_venv", { runtimeDir });
}

export function installUltralytics(runtimeDir: string): Promise<string> {
  return invoke<string>("install_ultralytics", { runtimeDir });
}

export function markSetupComplete(runtimeDir: string): Promise<void> {
  return invoke<void>("mark_setup_complete", { runtimeDir });
}

export function savePythonOverride(pythonPathOverride: string | null): Promise<void> {
  return invoke<void>("save_python_override", { pythonPathOverride });
}

