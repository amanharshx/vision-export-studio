import { invoke } from "@tauri-apps/api/core";
import type { ManagedEnvironmentKey, ManagedEnvironmentScanResult } from "@/lib/types";

export function scanManagedEnvironments(
  keys: ManagedEnvironmentKey[],
): Promise<ManagedEnvironmentScanResult[]> {
  return invoke<ManagedEnvironmentScanResult[]>("scan_managed_environments", { keys });
}
