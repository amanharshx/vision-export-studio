// @ts-expect-error Bun provides this module at test runtime.
import { beforeEach, describe, expect, it } from "bun:test";
import {
  computeAnalyticsEnabled,
  hasSentFirstRun,
  markFirstRunSent,
  resolveInstallChannel,
  sanitizeAnalyticsProperties,
  shouldInitAnalytics,
  shouldQueueAnalyticsCapture,
} from "./analytics";

function createStorage() {
  const data = new Map<string, string>();

  return {
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
  };
}

describe("computeAnalyticsEnabled", () => {
  it("disables analytics in dev", () => {
    expect(computeAnalyticsEnabled({ dev: true })).toBe(false);
  });

  it("enables analytics outside dev", () => {
    expect(computeAnalyticsEnabled({ dev: false })).toBe(true);
  });
});

describe("shouldInitAnalytics", () => {
  it("skips init when dev disables analytics", () => {
    expect(shouldInitAnalytics({ dev: true, posthogKey: "phc_test" })).toBe(false);
  });

  it("skips init when key missing", () => {
    expect(shouldInitAnalytics({ dev: false, posthogKey: "" })).toBe(false);
  });

  it("allows init only when enabled and key present", () => {
    expect(shouldInitAnalytics({ dev: false, posthogKey: "phc_test" })).toBe(true);
  });
});

describe("shouldQueueAnalyticsCapture", () => {
  it("queues while analytics intended enabled and init incomplete", () => {
    expect(
      shouldQueueAnalyticsCapture({
        initialized: false,
        dev: false,
        posthogKey: "phc_test",
      }),
    ).toBe(true);
  });

  it("does not queue after init complete", () => {
    expect(
      shouldQueueAnalyticsCapture({
        initialized: true,
        dev: false,
        posthogKey: "phc_test",
      }),
    ).toBe(false);
  });

  it("does not queue when analytics disabled", () => {
    expect(
      shouldQueueAnalyticsCapture({
        initialized: false,
        dev: true,
        posthogKey: "phc_test",
      }),
    ).toBe(false);
  });
});

describe("resolveInstallChannel", () => {
  it("keeps allowed release channel", () => {
    expect(resolveInstallChannel("github_release", false)).toBe("github_release");
  });

  it("falls back to source_build in dev", () => {
    expect(resolveInstallChannel("", true)).toBe("source_build");
  });

  it("falls back to unknown in prod for invalid values", () => {
    expect(resolveInstallChannel("homebrew", false)).toBe("unknown");
  });
});

describe("sanitizeAnalyticsProperties", () => {
  it("drops forbidden path-like fields", () => {
    expect(
      sanitizeAnalyticsProperties({
        route_id: "ultralytics.pt.onnx",
        source_path: "/Users/aman/Desktop/model.pt",
        output_dir: "/tmp/out",
        python_path: "/usr/bin/python3",
      }),
    ).toEqual({
      route_id: "ultralytics.pt.onnx",
    });
  });

  it("drops undefined values", () => {
    expect(
      sanitizeAnalyticsProperties({
        route_id: "ultralytics.pt.onnx",
        failure_kind: undefined,
      }),
    ).toEqual({
      route_id: "ultralytics.pt.onnx",
    });
  });
});

describe("first run marker", () => {
  let storage: ReturnType<typeof createStorage>;

  beforeEach(() => {
    storage = createStorage();
  });

  it("starts unset", () => {
    expect(hasSentFirstRun(storage)).toBe(false);
  });

  it("persists after mark", () => {
    markFirstRunSent(storage);
    expect(hasSentFirstRun(storage)).toBe(true);
  });
});
