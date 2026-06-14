// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import { shouldAutofillRfDetrImgsz, withRfDetrDetectedDefaults, getRouteOptionsForOpen } from "@/features/export/export-workspace";
import type { RfDetrInspectResult } from "@/lib/types";

import {
  defaultRouteForProvider,
  hasAllowedSourceExtension,
  providers,
  routesForProvider,
} from "./providers";

describe("provider route registry", () => {
  test("defaults to Ultralytics ONNX", () => {
    expect(defaultRouteForProvider("ultralytics").id).toBe("ultralytics.pt.onnx");
  });

  test("RF-DETR exposes only supported v1 routes", () => {
    expect(routesForProvider("rfdetr").map((route) => route.id)).toEqual([
      "rfdetr.pth.onnx",
      "rfdetr.pth.engine",
      "rfdetr.pth.tflite",
    ]);
  });

  test("provider base dependencies are scoped", () => {
    expect(providers.ultralytics.baseDeps).toEqual([
      { packageName: "ultralytics", installHint: "pip install ultralytics" },
    ]);
    expect(providers.rfdetr.baseDeps).toEqual([]);
  });

  test("provider source extension validation is scoped", () => {
    expect(hasAllowedSourceExtension("/tmp/best.pt", providers.ultralytics)).toBe(true);
    expect(hasAllowedSourceExtension("/tmp/best.pth", providers.ultralytics)).toBe(false);
    expect(hasAllowedSourceExtension("/tmp/checkpoint.pth", providers.rfdetr)).toBe(true);
    expect(hasAllowedSourceExtension("/tmp/checkpoint.pt", providers.rfdetr)).toBe(false);
  });

  test("RF-DETR routes do not include Ultralytics base dependency", () => {
    const provider = providers.rfdetr;
    const route = routesForProvider("rfdetr").find((item) => item.id === "rfdetr.pth.onnx");
    expect(provider.baseDeps.map((dep) => dep.packageName)).not.toContain("ultralytics");
    expect(route?.pipDeps.map((dep) => dep.packageName)).toEqual(["rfdetr[onnx]"]);
  });

  test("Ultralytics routes keep Ultralytics base dependency", () => {
    expect(providers.ultralytics.baseDeps.map((dep) => dep.packageName)).toContain("ultralytics");
  });
});

describe("shouldAutofillRfDetrImgsz", () => {
  test("autofills when no prior autofill", () => {
    expect(shouldAutofillRfDetrImgsz(640, null, "/tmp/model.pth")).toBe(true);
  });

  test("autofills when file changes", () => {
    const lastAuto = { sourcePath: "/tmp/old.pth", imgsz: 512 };
    expect(shouldAutofillRfDetrImgsz(640, lastAuto, "/tmp/new.pth")).toBe(true);
  });

  test("autofills when current value still equals last autofilled value", () => {
    const lastAuto = { sourcePath: "/tmp/model.pth", imgsz: 512 };
    expect(shouldAutofillRfDetrImgsz(512, lastAuto, "/tmp/model.pth")).toBe(true);
  });

  test("does not autofill when user overrode away from autofilled value", () => {
    const lastAuto = { sourcePath: "/tmp/model.pth", imgsz: 512 };
    expect(shouldAutofillRfDetrImgsz(640, lastAuto, "/tmp/model.pth")).toBe(false);
  });
});

const defaultOpts = {
  imgsz: 640,
  batch: 1,
  half: false,
  int8: false,
  dynamic: false,
  simplify: false,
  optimize: false,
  nms: false,
  endToEnd: false,
  keras: false,
  opset: null,
  workspace: null,
  chip: "rk3588",
};

const rfdInspect512: RfDetrInspectResult = {
  success: true,
  class_symbol: "RFDETRSmall",
  family: "detection",
  size: "small",
  requires_plus: false,
  is_legacy: false,
  recommended_imgsz: 512,
  patch_size: 16,
  token_grid: 32,
  error: null,
};

const rfdInspectFailed: RfDetrInspectResult = {
  success: false,
  class_symbol: null,
  family: null,
  size: null,
  requires_plus: false,
  is_legacy: false,
  recommended_imgsz: null,
  patch_size: null,
  token_grid: null,
  error: "failed",
};

describe("withRfDetrDetectedDefaults", () => {
  test("returns base unchanged for non-RF-DETR provider", () => {
    expect(
      withRfDetrDetectedDefaults(defaultOpts, "ultralytics", rfdInspect512),
    ).toEqual(defaultOpts);
  });

  test("returns base unchanged when inspect result is null", () => {
    expect(
      withRfDetrDetectedDefaults(defaultOpts, "rfdetr", null),
    ).toEqual(defaultOpts);
  });

  test("returns base unchanged when inspect failed", () => {
    expect(
      withRfDetrDetectedDefaults(defaultOpts, "rfdetr", rfdInspectFailed),
    ).toEqual(defaultOpts);
  });

  test("injects detected imgsz for RF-DETR with successful inspect", () => {
    const result = withRfDetrDetectedDefaults(defaultOpts, "rfdetr", rfdInspect512);
    expect(result.imgsz).toBe(512);
    expect(result.batch).toBe(defaultOpts.batch);
  });

  test("preserves route-specific overrides while injecting detected imgsz", () => {
    const routeOpts = { ...defaultOpts, half: true, simplify: true };
    const result = withRfDetrDetectedDefaults(routeOpts, "rfdetr", rfdInspect512);
    expect(result.imgsz).toBe(512);
    expect(result.half).toBe(true);
    expect(result.simplify).toBe(true);
  });
});

describe("getRouteOptionsForOpen", () => {
  test("returns detected defaults when no saved options", () => {
    const result = getRouteOptionsForOpen(null, "rfdetr.pth.onnx", "rfdetr", rfdInspect512);
    expect(result.imgsz).toBe(512);
  });

  test("returns saved options when present, ignoring detected defaults", () => {
    const saved = { ...defaultOpts, imgsz: 640, half: true };
    const result = getRouteOptionsForOpen(saved, "rfdetr.pth.onnx", "rfdetr", rfdInspect512);
    expect(result.imgsz).toBe(640);
    expect(result.half).toBe(true);
  });

  test("returns base defaults when no saved and no inspect for non-RF-DETR", () => {
    const result = getRouteOptionsForOpen(null, "ultralytics.pt.onnx", "ultralytics", null);
    expect(result.imgsz).toBe(640);
  });
});
