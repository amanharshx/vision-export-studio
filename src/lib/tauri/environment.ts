import { invoke } from "@tauri-apps/api/core";
import type { EnvironmentInfo } from "@/lib/types";

export function detectEnvironment(pythonPath?: string): Promise<EnvironmentInfo> {
  const payload = pythonPath !== undefined ? { pythonPath } : {};
  return invoke<EnvironmentInfo>("detect_environment", payload);
}
