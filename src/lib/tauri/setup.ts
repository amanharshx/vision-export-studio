import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "@/lib/types";

export interface ManagedRuntimeRebuildEligibility {
  eligible: boolean;
  current_version: string;
  candidate_version: string | null;
}

export function loadSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("load_settings");
}

export function createRuntimeVenv(runtimeDir: string): Promise<string> {
  return invoke<string>("create_runtime_venv", { runtimeDir });
}

export function getManagedRuntimeRebuildEligibility(): Promise<ManagedRuntimeRebuildEligibility> {
  return invoke<ManagedRuntimeRebuildEligibility>("get_managed_runtime_rebuild_eligibility");
}

export function rebuildManagedRuntime(pythonPath?: string): Promise<string> {
  return invoke<string>("rebuild_managed_runtime", { pythonPath });
}

export function markSetupComplete(runtimeDir: string): Promise<void> {
  return invoke<void>("mark_setup_complete", { runtimeDir });
}

export function savePythonOverride(pythonPathOverride: string | null): Promise<void> {
  return invoke<void>("save_python_override", { pythonPathOverride });
}

export function saveOutputDirOverride(outputDirOverride: string | null): Promise<void> {
  return invoke<void>("save_output_dir_override", { outputDirOverride });
}
