// Terminal environment-setup analytics for ticket 16.
//
// Replaces the retired one-time global setup events (`setup_started`,
// `setup_completed`, `setup_failed`) with a single terminal event emitted
// once per setup task. The payload is an allowlist only: provider, known
// environment key, route ID, terminal result, and duration. It never carries
// model paths, checkpoint metadata, Python paths, output paths, package
// logs, raw errors, or any stable user/model identifier. Each retry is its
// own terminal event with its own duration; no session or model ID links
// attempts together.

import type { ProviderId } from "@/lib/types";

export const ENVIRONMENT_SETUP_EVENT = "environment_setup_completed" as const;

export type EnvironmentSetupResult = "success" | "failure";

const KNOWN_ENVIRONMENT_SETUP_KEYS = new Set<string>([
  "ultralytics-managed",
  "rfdetr-default",
  "rfdetr-tensorrt",
  "rfdetr-coreml",
  "rfdetr-tflite",
]);

export function isKnownEnvironmentSetupKey(key: string): boolean {
  return KNOWN_ENVIRONMENT_SETUP_KEYS.has(key);
}

export interface EnvironmentSetupAnalyticsInput {
  provider: ProviderId;
  environmentKey: string;
  routeId: string | null;
  result: EnvironmentSetupResult;
  durationMs: number;
}

export interface EnvironmentSetupAnalyticsProperties {
  provider: ProviderId | "unknown";
  environment_key: string;
  route_id?: string;
  setup_result: EnvironmentSetupResult;
  duration_ms: number;
}

export function buildEnvironmentSetupProperties(
  input: EnvironmentSetupAnalyticsInput,
): EnvironmentSetupAnalyticsProperties {
  const duration_ms = Number.isFinite(input.durationMs)
    ? Math.max(0, Math.round(input.durationMs))
    : 0;
  // Unknown values map to safe fallbacks rather than dropping the event:
  // every started setup emits exactly one terminal event, and the fallbacks
  // preserve measurement without leaking the unexpected value. Results fall
  // back to failure so no path can claim an unverified success.
  const setup_result: EnvironmentSetupResult = input.result === "success" ? "success" : "failure";
  const provider = input.provider === "ultralytics" || input.provider === "rfdetr"
    ? input.provider
    : "unknown";
  const environment_key = isKnownEnvironmentSetupKey(input.environmentKey)
    ? input.environmentKey
    : "unknown";
  const routeId = input.routeId?.trim() ? input.routeId : null;
  return {
    provider,
    environment_key,
    ...(routeId ? { route_id: routeId } : {}),
    setup_result,
    duration_ms,
  };
}
