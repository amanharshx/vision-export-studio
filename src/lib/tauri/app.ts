import { invoke } from "@tauri-apps/api/core";

export interface AppTelemetryContext {
  os: string;
  arch: string;
}

export function getAppTelemetryContext(): Promise<AppTelemetryContext> {
  return invoke<AppTelemetryContext>("get_app_telemetry_context");
}
