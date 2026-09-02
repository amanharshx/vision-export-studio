// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, Fragment } from "react";
import {
  withRfDetrDetectedDefaults,
  getRouteOptionsForOpen,
  applyDetectedRouteOptions,
  applyDetectedRouteOptionsToProviderRoutes,
  getUltralyticsRuntimeDisabledReason,
  shouldShowUltralyticsRuntimeInstallDetails,
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

  test("RF-DETR exposes supported native routes", () => {
    expect(routesForProvider("rfdetr").map((route) => route.id)).toEqual([
      "rfdetr.pth.onnx",
      "rfdetr.pth.engine",
      "rfdetr.pth.coreml",
      "rfdetr.pth.tflite",
      "rfdetr.pth.executorch",
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

  test("RF-DETR TensorRT uses native extra without trtexec", () => {
    const route = routesForProvider("rfdetr").find((item) => item.id === "rfdetr.pth.engine");
    const onnxRoute = routesForProvider("rfdetr").find((item) => item.id === "rfdetr.pth.onnx");

    expect(route?.pipDeps.map((dep) => dep.packageName)).toEqual(["rfdetr[tensorrt]"]);
    expect(route?.sysDeps).toEqual([]);
    expect(route?.intermediates).toEqual(["onnx"]);
    expect(route?.precisionModes).toEqual(["fp32"]);
    expect(route?.defaultPrecision).toBe("fp32");
    expect(onnxRoute?.precisionModes).toEqual(["fp32"]);
    expect(onnxRoute?.defaultPrecision).toBe("fp32");
  });

  test("RF-DETR CoreML is macOS-only and offers FP32 or FP16", () => {
    const route = routesForProvider("rfdetr").find((item) => item.id === "rfdetr.pth.coreml");

    expect(route?.pipDeps.map((dep) => dep.packageName)).toEqual(["rfdetr[coreml]"]);
    expect(route?.platformLock).toBe("macos");
    expect(route?.intermediates).toEqual([]);
    expect(route?.precisionModes).toEqual(["fp32", "fp16"]);
    expect(route?.defaultPrecision).toBe("fp32");
    expect(route?.displayPath).toBe("checkpoint.pth -> rfdetr-small.mlpackage");
    expect(route?.requiresGpu).toBe(false);
    expect(route?.oneWay).toBe(true);
  });

  test("RF-DETR TFLite declares experimental multi-artifact quantization", () => {
    const route = routesForProvider("rfdetr").find((item) => item.id === "rfdetr.pth.tflite");

    expect(route?.pipDeps[0]).toEqual({
      packageName: "rfdetr[tflite]>=1.9.4",
      installHint: 'pip install "rfdetr[tflite]>=1.9.4"',
    });
    expect(route?.platformLock).toBe("any");
    expect(route?.intermediates).toEqual(["onnx"]);
    expect(route?.precisionModes).toEqual(["fp32", "int8"]);
    expect(route?.defaultPrecision).toBe("fp32");
    expect(route?.calibrationRecommendedFor).toEqual([]);
    expect(route?.oneWay).toBe(true);
    expect(route?.lossy).toBe(true);
    expect(route?.notes).toContain("always emits FP32 and FP16");
    expect(route?.notes).toContain("dynamic-range weight-quantized");
    expect(route?.notes).toContain("requires no calibration data");
  });

  test("RF-DETR ExecuTorch fixes XNNPACK semantics and dependency floors", () => {
    const route = routesForProvider("rfdetr").find((item) => item.id === "rfdetr.pth.executorch");

    expect(route?.targetFormat).toBe("executorch");
    expect(route?.title).toBe("ExecuTorch");
    expect(route?.backend).toBe("xnnpack");
    expect(route?.pipDeps.map((dep) => dep.packageName)).toEqual([
      "rfdetr[executorch]>=1.9.0",
      "torch>=2.13",
      "flatc",
    ]);
    expect(route?.platformLock).toBe("macos_arm64_linux_windows_x86_64");
    expect(route?.precisionModes).toEqual(["fp32"]);
    expect(route?.supportsDynamic).toBe(false);
    expect(route?.oneWay).toBe(true);
    expect(route?.experimental).toBe(true);
  });

  test("Ultralytics routes keep Ultralytics base dependency", () => {
    expect(providers.ultralytics.baseDeps.map((dep) => dep.packageName)).toContain("ultralytics");
  });

  test("RF-DETR rendered route list shows TFLite UI", () => {
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
    expect(markup).toContain("TFLite");
  });

  test("LiteRT route exposes LiteRT metadata and drops TFLite/TF.js routes", () => {
    const routes = routesForProvider("ultralytics");
    const litert = routes.find((item) => item.id === "ultralytics.pt.litert");
    expect(litert).toBeDefined();

    expect(litert!.title).toBe("LiteRT");
    expect(litert!.targetFormat).toBe("litert");
    expect(litert!.displayPath).toBe("model.pt → model.tflite");
    expect(litert!.intermediates).toEqual([]);
    expect(litert!.precisionModes).toEqual(["fp32", "int8", "w8a16", "w8a32"]);
    expect(litert!.defaultPrecision).toBe("fp32");
    expect(litert!.requiresGpu).toBe(false);
    expect(litert!.platformLock).toBe("macos_linux_x86_64");
    expect(litert!.pipDeps.map((dep) => dep.packageName)).toEqual([
      "litert-torch>=0.9.0",
      "ai-edge-litert>=2.1.4",
    ]);

    const ids = routes.map((item) => item.id);
    expect(ids).not.toContain("ultralytics.pt.tflite");
    expect(ids).not.toContain("ultralytics.pt.tfjs");
  });
});

describe("route precision matrix", () => {
  const all = routesForProvider("ultralytics");
  const byId = (id: string) => {
    const route = all.find((item) => item.id === id);
    expect(route).toBeDefined();
    return route!;
  };

  test("LiteRT exposes FP32/INT8/W8A16/W8A32 with FP32 default", () => {
    const litert = byId("ultralytics.pt.litert");
    expect(litert.precisionModes).toEqual(["fp32", "int8", "w8a16", "w8a32"]);
    expect(litert.defaultPrecision).toBe("fp32");
  });

  test("LiteRT recommends calibration for INT8 and W8A16", () => {
    const litert = byId("ultralytics.pt.litert");
    expect(litert.calibrationRecommendedFor).toEqual(["int8", "w8a16"]);
  });

  test("TensorRT exposes FP16/FP32/INT8 with FP16 default", () => {
    const engine = byId("ultralytics.pt.engine");
    expect(engine.precisionModes).toEqual(["fp16", "fp32", "int8"]);
    expect(engine.defaultPrecision).toBe("fp16");
  });

  test("TensorRT recommends calibration for INT8", () => {
    const engine = byId("ultralytics.pt.engine");
    expect(engine.calibrationRecommendedFor).toEqual(["int8"]);
  });

  test("every route default precision is a permitted mode", () => {
    for (const route of all) {
      expect(route.precisionModes).toContain(route.defaultPrecision);
    }
  });

  test("calibration-recommended modes are always permitted modes", () => {
    for (const route of all) {
      for (const mode of route.calibrationRecommendedFor) {
        expect(route.precisionModes).toContain(mode);
      }
    }
  });

  test("fixed-precision routes expose a single mode", () => {
    for (const id of [
      "ultralytics.pt.torchscript",
      "ultralytics.pt.executorch",
      "ultralytics.pt.pb",
      "ultralytics.pt.paddle",
      "ultralytics.pt.edgetpu",
      "ultralytics.pt.axelera",
    ]) {
      expect(byId(id).precisionModes.length).toBe(1);
    }
  });

  test("CoreML supports W8A16", () => {
    expect(byId("ultralytics.pt.coreml").precisionModes).toContain("w8a16");
  });

  test("IMX supports W8A16", () => {
    expect(byId("ultralytics.pt.imx").precisionModes).toContain("w8a16");
  });

  test("RKNN does not expose FP32", () => {
    expect(byId("ultralytics.pt.rknn").precisionModes).not.toContain("fp32");
  });

  test("LiteRT does not expose FP16", () => {
    expect(byId("ultralytics.pt.litert").precisionModes).not.toContain("fp16");
  });

  test("EdgeTPU and Axelera are INT8-only", () => {
    expect(byId("ultralytics.pt.edgetpu").precisionModes).toEqual(["int8"]);
    expect(byId("ultralytics.pt.axelera").precisionModes).toEqual(["int8"]);
  });

  test("EdgeTPU and Axelera recommend calibration for INT8", () => {
    for (const id of ["ultralytics.pt.edgetpu", "ultralytics.pt.axelera"]) {
      expect(byId(id).precisionModes).toEqual(["int8"]);
      expect(byId(id).calibrationRecommendedFor).toEqual(["int8"]);
    }
  });
});

const defaultOpts = {
  imgsz: 640,
  batch: 1,
  precision: "fp32",
  calibrationData: null,
  dynamic: false,
  simplify: false,
  optimize: false,
  nms: false,
  endToEnd: false,
  keras: false,
  opset: null,
  workspace: null,
  chip: "rk3588",
} as const;

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
    const routeOpts = { ...defaultOpts, precision: "fp16" as const, simplify: true };
    const result = withRfDetrDetectedDefaults(routeOpts, "rfdetr", rfdInspect512);
    expect(result.imgsz).toBe(512);
    expect(result.precision).toBe("fp16");
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
      options: { ...defaultOpts, imgsz: 640, precision: "fp16" },
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

  test("normalizes saved RKNN options to lowercase chip and INT8-only precision", () => {
    const saved: RouteOptionsState = {
      options: { ...defaultOpts, chip: "RV1106B", precision: "fp16" },
      source: "user",
      sourcePath,
    };
    const result = getRouteOptionsForOpen(saved, "ultralytics.pt.rknn", "ultralytics", null, sourcePath);
    expect(result.options.chip).toBe("rv1106b");
    expect(result.options.precision).toBe("int8");
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
      options: { ...defaultOpts, imgsz: 512, precision: "fp16" },
      source: "detected",
      sourcePath,
    };
    const result = applyDetectedRouteOptions(saved, routeId, 640, sourcePath);
    expect(result).not.toBeNull();
    expect(result!.options.imgsz).toBe(640);
    expect(result!.options.precision).toBe("fp16");
    expect(result!.source).toBe("detected");
  });

  test("preserves user saved state", () => {
    const saved: RouteOptionsState = {
      options: { ...defaultOpts, imgsz: 640, precision: "fp16" },
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
          options: { ...defaultOpts, imgsz: 768, precision: "fp16" },
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
      options: { ...defaultOpts, imgsz: 768, precision: "fp16" },
      source: "user",
      sourcePath,
    });
  });
});

describe("getUltralyticsRuntimeDisabledReason", () => {
  test("suppresses disabled tooltip while ultralytics runtime is installing", () => {
    expect(getUltralyticsRuntimeDisabledReason("installing")).toBeUndefined();
  });

  test("shows disabled tooltip before ultralytics runtime install starts", () => {
    expect(getUltralyticsRuntimeDisabledReason("idle")).toBe(
      "Install the Ultralytics runtime before choosing a YOLO export target.",
    );
  });
});

describe("shouldShowUltralyticsRuntimeInstallDetails", () => {
  test("keeps install details collapsed by default while runtime is installing", () => {
    expect(shouldShowUltralyticsRuntimeInstallDetails("installing", false)).toBe(false);
  });

  test("shows install details when user explicitly opens them during install", () => {
    expect(shouldShowUltralyticsRuntimeInstallDetails("installing", true)).toBe(true);
  });

  test("forces install details open after runtime install failure", () => {
    expect(shouldShowUltralyticsRuntimeInstallDetails("failed", false)).toBe(true);
  });
});
