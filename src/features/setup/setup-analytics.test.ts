// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import {
  buildEnvironmentSetupProperties,
  ENVIRONMENT_SETUP_EVENT,
  isKnownEnvironmentSetupKey,
} from "./setup-analytics";

describe("environment setup analytics vocabulary (ticket 16)", () => {
  test("uses a single terminal event, not global start/completion duplicates", () => {
    expect(ENVIRONMENT_SETUP_EVENT).toBe("environment_setup_completed");
  });

  test("builds success properties with only the allowed fields", () => {
    const props = buildEnvironmentSetupProperties({
      provider: "ultralytics",
      environmentKey: "ultralytics-managed",
      routeId: "ultralytics.pt.onnx",
      result: "success",
      durationMs: 1234,
    });
    expect(props).toEqual({
      provider: "ultralytics",
      environment_key: "ultralytics-managed",
      route_id: "ultralytics.pt.onnx",
      setup_result: "success",
      duration_ms: 1234,
    });
  });

  test("builds failure properties with only the allowed fields", () => {
    const props = buildEnvironmentSetupProperties({
      provider: "rfdetr",
      environmentKey: "rfdetr-default",
      routeId: "rfdetr.pth.onnx",
      result: "failure",
      durationMs: 500,
    });
    expect(props).toEqual({
      provider: "rfdetr",
      environment_key: "rfdetr-default",
      route_id: "rfdetr.pth.onnx",
      setup_result: "failure",
      duration_ms: 500,
    });
  });

  test("omits route_id when the setup has no route", () => {
    const props = buildEnvironmentSetupProperties({
      provider: "ultralytics",
      environmentKey: "ultralytics-managed",
      routeId: null,
      result: "success",
      durationMs: 10,
    });
    expect(props).not.toContainKey("route_id");
    expect(props).toEqual({
      provider: "ultralytics",
      environment_key: "ultralytics-managed",
      setup_result: "success",
      duration_ms: 10,
    });
  });

  test("never emits forbidden model, path, checkpoint, log, or error fields", () => {
    const props = buildEnvironmentSetupProperties({
      provider: "ultralytics",
      environmentKey: "ultralytics-managed",
      routeId: "ultralytics.pt.onnx",
      result: "success",
      durationMs: 10,
    }) as unknown as Record<string, unknown>;
    const keys = Object.keys(props).sort();
    expect(keys).toEqual(
      ["duration_ms", "environment_key", "provider", "route_id", "setup_result"].sort(),
    );
    for (const key of keys) {
      const lower = key.toLowerCase();
      expect(lower).not.toContain("path");
      expect(lower).not.toContain("file");
      expect(lower).not.toContain("log");
      expect(lower).not.toContain("command");
      expect(lower).not.toContain("content");
      expect(lower).not.toContain("model");
      expect(lower).not.toContain("checkpoint");
      expect(lower).not.toContain("metadata");
      expect(lower).not.toContain("error");
      expect(lower).not.toContain("python");
      expect(lower).not.toContain("output");
      expect(lower).not.toContain("session");
    }
    expect(props).not.toContainKey("session_id");
    expect(props).not.toContainKey("python_path");
    expect(props).not.toContainKey("source_path");
    expect(props).not.toContainKey("model_filename");
  });

  test("clamps duration to a non-negative integer", () => {
    const negative = buildEnvironmentSetupProperties({
      provider: "ultralytics",
      environmentKey: "ultralytics-managed",
      routeId: null,
      result: "success",
      durationMs: -50,
    });
    expect(negative?.duration_ms).toBe(0);
    const fractional = buildEnvironmentSetupProperties({
      provider: "ultralytics",
      environmentKey: "ultralytics-managed",
      routeId: null,
      result: "success",
      durationMs: 12.7,
    });
    expect(fractional?.duration_ms).toBe(13);
  });

  test("maps unknown environment keys to unknown instead of leaking them", () => {
    expect(isKnownEnvironmentSetupKey("ultralytics-managed")).toBe(true);
    expect(isKnownEnvironmentSetupKey("rfdetr-default")).toBe(true);
    expect(isKnownEnvironmentSetupKey("rfdetr-tensorrt")).toBe(true);
    expect(isKnownEnvironmentSetupKey("/tmp/evil/.venv")).toBe(false);
    const props = buildEnvironmentSetupProperties({
      provider: "ultralytics",
      environmentKey: "/tmp/evil/.venv",
      routeId: null,
      result: "failure",
      durationMs: 5,
    });
    expect(props?.environment_key).toBe("unknown");
  });

  test("rejects unknown providers instead of emitting them", () => {
    const props = buildEnvironmentSetupProperties({
      // @ts-expect-error testing runtime rejection of an unknown provider.
      provider: "tensorflow",
      environmentKey: "ultralytics-managed",
      routeId: null,
      result: "success",
      durationMs: 5,
    });
    expect(props).toBeNull();
  });
});
