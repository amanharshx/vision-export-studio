// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, Fragment } from "react";
import {
  withRfDetrDetectedDefaults,
  getRouteOptionsForOpen,
  applyDetectedRouteOptions,
  applyDetectedRouteOptionsToProviderRoutes,
} from "@/features/export/export-workspace";
import type { RfDetrInspectResult, RouteOptionsState } from "@/lib/types";

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

  test("RF-DETR rendered route list does not show TFLite UI", () => {
    const markup = renderToStaticMarkup(
      createElement(
        Fragment,
        null,
        ...routesForProvider("rfdetr").map((route) =>
          createElement("button", { key: route.id }, route.title),
        ),
      ),
    );

    expect(markup).toContain("ONNX");
    expect(markup).toContain("TensorRT via ONNX");
    expect(markup).not.toContain("TFLite");
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
  const sourcePath = "/tmp/model.pth";

  test("returns detected defaults when no saved options", () => {
    const result = getRouteOptionsForOpen(null, "rfdetr.pth.onnx", "rfdetr", rfdInspect512, sourcePath);
    expect(result.options.imgsz).toBe(512);
    expect(result.source).toBe("detected");
    expect(result.sourcePath).toBe(sourcePath);
  });

  test("returns saved options when sourcePath matches and source is user", () => {
    const saved: RouteOptionsState = {
      options: { ...defaultOpts, imgsz: 640, half: true },
      source: "user",
      sourcePath,
    };
    const result = getRouteOptionsForOpen(saved, "rfdetr.pth.onnx", "rfdetr", rfdInspect512, sourcePath);
    expect(result).toBe(saved);
  });

  test("ignores saved options when sourcePath differs", () => {
    const saved: RouteOptionsState = {
      options: { ...defaultOpts, imgsz: 640 },
      source: "user",
      sourcePath: "/tmp/other.pth",
    };
    const result = getRouteOptionsForOpen(saved, "rfdetr.pth.onnx", "rfdetr", rfdInspect512, sourcePath);
    expect(result.options.imgsz).toBe(512);
    expect(result.source).toBe("detected");
    expect(result.sourcePath).toBe(sourcePath);
  });

  test("returns base defaults when no saved and no inspect for non-RF-DETR", () => {
    const result = getRouteOptionsForOpen(null, "ultralytics.pt.onnx", "ultralytics", null, sourcePath);
    expect(result.options.imgsz).toBe(640);
    expect(result.source).toBe("default");
  });
});

describe("applyDetectedRouteOptions", () => {
  const sourcePath = "/tmp/model.pth";
  const routeId = "rfdetr.pth.onnx";

  test("replaces default saved state with detected imgsz", () => {
    const saved: RouteOptionsState = {
      options: { ...defaultOpts, imgsz: 640 },
      source: "default",
      sourcePath,
    };
    const result = applyDetectedRouteOptions(saved, routeId, 512, sourcePath);
    expect(result).not.toBeNull();
    expect(result!.options.imgsz).toBe(512);
    expect(result!.source).toBe("detected");
  });

  test("refreshes detected saved state with new detected imgsz", () => {
    const saved: RouteOptionsState = {
      options: { ...defaultOpts, imgsz: 512, half: true },
      source: "detected",
      sourcePath,
    };
    const result = applyDetectedRouteOptions(saved, routeId, 640, sourcePath);
    expect(result).not.toBeNull();
    expect(result!.options.imgsz).toBe(640);
    expect(result!.options.half).toBe(true);
    expect(result!.source).toBe("detected");
  });

  test("preserves user saved state", () => {
    const saved: RouteOptionsState = {
      options: { ...defaultOpts, imgsz: 640, half: true },
      source: "user",
      sourcePath,
    };
    const result = applyDetectedRouteOptions(saved, routeId, 512, sourcePath);
    expect(result).toBeNull();
  });

  test("creates fresh detected state when no saved state exists", () => {
    const result = applyDetectedRouteOptions(null, routeId, 512, sourcePath);
    expect(result).not.toBeNull();
    expect(result!.options.imgsz).toBe(512);
    expect(result!.source).toBe("detected");
    expect(result!.sourcePath).toBe(sourcePath);
  });

  test("creates fresh detected state when sourcePath differs", () => {
    const saved: RouteOptionsState = {
      options: { ...defaultOpts, imgsz: 640 },
      source: "user",
      sourcePath: "/tmp/other.pth",
    };
    const result = applyDetectedRouteOptions(saved, routeId, 512, sourcePath);
    expect(result).not.toBeNull();
    expect(result!.options.imgsz).toBe(512);
    expect(result!.source).toBe("detected");
    expect(result!.sourcePath).toBe(sourcePath);
  });
});

describe("applyDetectedRouteOptionsToProviderRoutes", () => {
  const sourcePath = "/tmp/model.pth";

  test("fans out detected imgsz across RF-DETR routes while preserving user state", () => {
    const result = applyDetectedRouteOptionsToProviderRoutes(
      {
        "rfdetr.pth.onnx": {
          options: { ...defaultOpts, imgsz: 640 },
          source: "default",
          sourcePath,
        },
        "rfdetr.pth.engine": {
          options: { ...defaultOpts, imgsz: 768, half: true },
          source: "user",
          sourcePath,
        },
      },
      "rfdetr",
      512,
      sourcePath,
    );

    expect(result["rfdetr.pth.onnx"]).toEqual({
      options: { ...defaultOpts, imgsz: 512 },
      source: "detected",
      sourcePath,
    });
    expect(result["rfdetr.pth.engine"]).toEqual({
      options: { ...defaultOpts, imgsz: 768, half: true },
      source: "user",
      sourcePath,
    });
  });
});
