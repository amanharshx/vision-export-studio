import { invoke } from "@tauri-apps/api/core";
import type { EnvironmentInfo } from "@/lib/types";

export function detectEnvironment(pythonPath?: string): Promise<EnvironmentInfo> {
  return invoke<EnvironmentInfo>("detect_environment", {
    pythonPath: pythonPath ?? null,
  });
}
