import { invoke } from "@tauri-apps/api/core";
import type {
  ManagedEnvironmentCleanupReport,
  ManagedEnvironmentKey,
  ManagedEnvironmentScanResult,
} from "@/lib/types";

export function scanManagedEnvironments(
  keys: ManagedEnvironmentKey[],
): Promise<ManagedEnvironmentScanResult[]> {
  return invoke<ManagedEnvironmentScanResult[]>("scan_managed_environments", { keys });
}

export function cleanupManagedEnvironments(
  keys: ManagedEnvironmentKey[],
): Promise<ManagedEnvironmentCleanupReport> {
  return invoke<ManagedEnvironmentCleanupReport>("cleanup_managed_environments", { keys });
}
