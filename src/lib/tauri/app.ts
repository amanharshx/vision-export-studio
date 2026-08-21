import { invoke } from "@tauri-apps/api/core";
import type { AppArch, AppOS } from "@/lib/platform";

export interface AppTelemetryContext {
  os: AppOS;
  arch: AppArch;
}

export interface HostSupportResult {
  route_id: string;
  status: "supported" | "unsupported" | "error";
  reason?: string;
}

export function getAppTelemetryContext(): Promise<AppTelemetryContext> {
  return invoke<AppTelemetryContext>("get_app_telemetry_context");
}

export function getRoutePlatformSupport(routeIds: string[]): Promise<HostSupportResult[]> {
  return invoke<HostSupportResult[]>("get_route_platform_support", { routeIds });
}
