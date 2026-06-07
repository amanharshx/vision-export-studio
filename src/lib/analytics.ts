import PostHog from "posthog-js/dist/module.no-external";
import { getAppTelemetryContext } from "@/lib/tauri/app";

export type InstallChannel = "github_release" | "source_build" | "unknown";

export type AnalyticsEventName =
  | "app_opened"
  | "first_run"
  | "settings_load_failed"
  | "setup_started"
  | "setup_completed"
  | "setup_failed"
  | "export_started"
  | "export_completed"
  | "export_failed"
  | "export_cancelled";

type AnalyticsValue = string | number | boolean | null | undefined;
export type AnalyticsProperties = Record<string, AnalyticsValue>;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

const DISTINCT_ID_KEY = "analytics.distinct_id";
const FIRST_RUN_KEY = "analytics.first_run_sent";
const FORBIDDEN_KEYS = new Set(["source_path", "output_dir", "python_path", "file_path"]);
const FORBIDDEN_KEY_PATTERNS = ["path", "file", "log", "command", "content"];
const FALLBACK_TELEMETRY_CONTEXT = { os: "unknown", arch: "unknown" };

let initialized = false;
let analyticsEnabled = false;
let initializationStarted = false;
let pendingEvents: Array<{ eventName: AnalyticsEventName; properties: AnalyticsProperties }> = [];

function isDevRuntime(): boolean {
  return Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV);
}

function getStorage(): StorageLike | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.localStorage;
}

function getBuildAppVersion(): string {
  return typeof __APP_VERSION__ === "undefined" ? "unknown" : __APP_VERSION__;
}

function getBuildPostHogKey(): string {
  return typeof __POSTHOG_KEY__ === "undefined" ? "" : __POSTHOG_KEY__;
}

function getBuildPostHogHost(): string {
  return typeof __POSTHOG_HOST__ === "undefined" ? "https://us.i.posthog.com" : __POSTHOG_HOST__;
}

function getBuildInstallChannel(): string {
  return typeof __INSTALL_CHANNEL__ === "undefined" ? "" : __INSTALL_CHANNEL__;
}

function getCommonProperties(): AnalyticsProperties {
  return {
    app_version: getBuildAppVersion(),
    app_env: isDevRuntime() ? "development" : "production",
    install_channel: resolveInstallChannel(getBuildInstallChannel(), isDevRuntime()),
  };
}

function getOrCreateDistinctId(storage: StorageLike | null): string {
  const existing = storage?.getItem(DISTINCT_ID_KEY);
  if (existing) {
    return existing;
  }

  const created = crypto.randomUUID();
  storage?.setItem(DISTINCT_ID_KEY, created);
  return created;
}

export function computeAnalyticsEnabled(input: { dev: boolean }): boolean {
  return !input.dev;
}

export function shouldInitAnalytics(input: { dev: boolean; posthogKey: string }): boolean {
  return computeAnalyticsEnabled({ dev: input.dev }) && Boolean(input.posthogKey);
}

export function shouldQueueAnalyticsCapture(input: {
  initialized: boolean;
  dev: boolean;
  posthogKey: string;
}): boolean {
  return !input.initialized && shouldInitAnalytics({
    dev: input.dev,
    posthogKey: input.posthogKey,
  });
}

export function resolveInstallChannel(raw: string, dev: boolean): InstallChannel {
  if (raw === "github_release" || raw === "source_build" || raw === "unknown") {
    return raw;
  }

  return dev ? "source_build" : "unknown";
}

export function sanitizeAnalyticsProperties(
  properties: AnalyticsProperties = {},
): Record<string, Exclude<AnalyticsValue, undefined>> {
  return Object.fromEntries(
    Object.entries(properties).filter(([key, value]) => {
      if (value === undefined) {
        return false;
      }

      const normalizedKey = key.toLowerCase();
      if (FORBIDDEN_KEYS.has(normalizedKey)) {
        return false;
      }

      return !FORBIDDEN_KEY_PATTERNS.some((pattern) => normalizedKey.includes(pattern));
    }),
  ) as Record<string, Exclude<AnalyticsValue, undefined>>;
}

export function hasSentFirstRun(storage: StorageLike | null = getStorage()): boolean {
  return storage?.getItem(FIRST_RUN_KEY) === "true";
}

export function markFirstRunSent(storage: StorageLike | null = getStorage()): void {
  storage?.setItem(FIRST_RUN_KEY, "true");
}

export async function initAnalytics(): Promise<void> {
  if (initialized || initializationStarted) {
    return;
  }

  const dev = isDevRuntime();
  const posthogKey = getBuildPostHogKey();
  analyticsEnabled = computeAnalyticsEnabled({ dev });
  if (!shouldInitAnalytics({ dev, posthogKey })) {
    initialized = true;
    pendingEvents = [];
    return;
  }

  initializationStarted = true;
  try {
    const telemetryContext = await getAppTelemetryContext().catch(() => FALLBACK_TELEMETRY_CONTEXT);
    const distinctId = getOrCreateDistinctId(getStorage());

    PostHog.init(posthogKey, {
      api_host: getBuildPostHogHost(),
      defaults: "2026-01-30",
      autocapture: false,
      capture_pageview: false,
      disable_session_recording: true,
      before_send: (event) => {
        if (!event) {
          return null;
        }

        event.properties = sanitizeAnalyticsProperties(
          (event.properties ?? {}) as AnalyticsProperties,
        );
        return event;
      },
    });

    PostHog.identify(distinctId);
    PostHog.register({
      ...getCommonProperties(),
      os: telemetryContext.os,
      arch: telemetryContext.arch,
    });

    for (const pendingEvent of pendingEvents) {
      PostHog.capture(pendingEvent.eventName, sanitizeAnalyticsProperties(pendingEvent.properties));
    }

    pendingEvents = [];
    initialized = true;
  } finally {
    initializationStarted = false;
  }
}

export function isAnalyticsEnabled(): boolean {
  return shouldInitAnalytics({
    dev: isDevRuntime(),
    posthogKey: getBuildPostHogKey(),
  });
}

export function captureAnalyticsEvent(
  eventName: AnalyticsEventName,
  properties: AnalyticsProperties = {},
): void {
  const dev = isDevRuntime();
  const posthogKey = getBuildPostHogKey();
  if (shouldQueueAnalyticsCapture({ initialized, dev, posthogKey })) {
    pendingEvents.push({ eventName, properties });
    return;
  }

  if (!shouldInitAnalytics({ dev, posthogKey })) {
    return;
  }

  PostHog.capture(eventName, sanitizeAnalyticsProperties(properties));
}
