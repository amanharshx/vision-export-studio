import { invoke } from "@tauri-apps/api/core";
import type { AppArch, AppOS } from "@/lib/platform";

export interface AppTelemetryContext {
  os: AppOS;
  arch: AppArch;
}

export function getAppTelemetryContext(): Promise<AppTelemetryContext> {
  return invoke<AppTelemetryContext>("get_app_telemetry_context");
}
