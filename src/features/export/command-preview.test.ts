// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import { buildCommandPreview } from "./command-preview";
import type { CommandPreviewInput } from "./command-preview";
import { normalizeOptionsForRoute } from "./options/normalize";

const ultralyticsInput: CommandPreviewInput = {
  providerId: "ultralytics",
  routeId: "ultralytics.pt.onnx",
  targetFormat: "onnx",
  sourcePath: "/tmp/best.pt",
  options: {
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
  },
};

const rfdetrInput: CommandPreviewInput = {
  providerId: "rfdetr",
  routeId: "rfdetr.pth.onnx",
  targetFormat: "onnx",
  sourcePath: "/tmp/checkpoint.pth",
  outputDir: "/tmp/output",
  options: {
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
  },
};

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("buildCommandPreview", () => {
  test("ultralytics ONNX — FP32 emits canonical quantize=32", () => {
    const preview = buildCommandPreview(ultralyticsInput);
    expect(preview).toContain("quantize=32");
    expect(countOccurrences(preview, "quantize=")).toBe(1);
  });

  test("ultralytics ONNX — FP16 emits quantize=16", () => {
    const preview = buildCommandPreview({
      ...ultralyticsInput,
      options: { ...ultralyticsInput.options, precision: "fp16" },
    });
    expect(preview).toContain("quantize=16");
  });

  test("ultralytics LiteRT — W8A32 emits quantize=w8a32", () => {
    const preview = buildCommandPreview({
      ...ultralyticsInput,
      routeId: "ultralytics.pt.litert",
      targetFormat: "litert",
      options: { ...ultralyticsInput.options, precision: "w8a32" },
    });
    expect(preview).toContain("quantize=w8a32");
  });

  test("ultralytics LiteRT — INT8 plus calibration YAML emits data path", () => {
    const preview = buildCommandPreview({
      ...ultralyticsInput,
      routeId: "ultralytics.pt.litert",
      targetFormat: "litert",
      options: {
        ...ultralyticsInput.options,
        precision: "int8",
        calibrationData: "/tmp/calibration.yaml",
      },
    });
    expect(preview).toContain("quantize=8");
    expect(preview).toContain("data=/tmp/calibration.yaml");
  });

  test("ultralytics LiteRT — INT8 without YAML emits no data=", () => {
    const preview = buildCommandPreview({
      ...ultralyticsInput,
      routeId: "ultralytics.pt.litert",
      targetFormat: "litert",
      options: { ...ultralyticsInput.options, precision: "int8" },
    });
    expect(preview).toContain("quantize=8");
    expect(preview).not.toContain("data=");
  });

  test("ultralytics LiteRT — stored calibration YAML not emitted for FP32", () => {
    const preview = buildCommandPreview({
      ...ultralyticsInput,
      routeId: "ultralytics.pt.litert",
      targetFormat: "litert",
      options: {
        ...ultralyticsInput.options,
        precision: "fp32",
        calibrationData: "/tmp/calibration.yaml",
      },
    });
    expect(preview).toContain("quantize=32");
    expect(preview).not.toContain("data=");
  });

  test("ultralytics LiteRT — stored calibration YAML not emitted for W8A32", () => {
    const preview = buildCommandPreview({
      ...ultralyticsInput,
      routeId: "ultralytics.pt.litert",
      targetFormat: "litert",
      options: {
        ...ultralyticsInput.options,
        precision: "w8a32",
        calibrationData: "/tmp/calibration.yaml",
      },
    });
    expect(preview).toContain("quantize=w8a32");
    expect(preview).not.toContain("data=");
  });

  test("ultralytics preview never emits legacy half/int8 flags", () => {
    const preview = buildCommandPreview({
      ...ultralyticsInput,
      options: { ...ultralyticsInput.options, precision: "int8", dynamic: true },
    });
    expect(preview).not.toContain("half=");
    expect(preview).not.toContain("int8=");
  });

  test("ultralytics ONNX — simplify, opset with FP16", () => {
    const preview = buildCommandPreview({
      ...ultralyticsInput,
      options: { ...ultralyticsInput.options, precision: "fp16", simplify: true, opset: 11 },
    });
    expect(preview).toBe(
      "yolo export model=/tmp/best.pt format=onnx imgsz=640 batch=1 quantize=16 simplify=True opset=11",
    );
  });

  test("ultralytics — INT8 with dynamic", () => {
    const preview = buildCommandPreview({
      ...ultralyticsInput,
      options: { ...ultralyticsInput.options, precision: "int8", dynamic: true },
    });
    expect(preview).toBe(
      "yolo export model=/tmp/best.pt format=onnx imgsz=640 batch=1 quantize=8 dynamic=True",
    );
  });

  test("ultralytics — optimize, nms, end2end, keras, workspace", () => {
    const preview = buildCommandPreview({
      ...ultralyticsInput,
      routeId: "ultralytics.pt.engine",
      targetFormat: "engine",
      options: {
        ...ultralyticsInput.options,
        precision: "fp16",
        optimize: true,
        nms: true,
        endToEnd: true,
        keras: true,
        workspace: 4,
      },
    });
    expect(preview).toBe(
      "yolo export model=/tmp/best.pt format=engine imgsz=640 batch=1 quantize=16 optimize=True nms=True end2end=True keras=True workspace=4",
    );
  });

  test("ultralytics — opset omitted when null", () => {
    const preview = buildCommandPreview({
      ...ultralyticsInput,
      options: { ...ultralyticsInput.options, opset: null },
    });
    expect(preview).not.toContain("opset");
  });

  test("ultralytics — workspace omitted when null", () => {
    const preview = buildCommandPreview({
      ...ultralyticsInput,
      options: { ...ultralyticsInput.options, workspace: null },
    });
    expect(preview).not.toContain("workspace");
  });

  test("ultralytics RKNN — includes name=chip with FP16 quantize", () => {
    const preview = buildCommandPreview({
      ...ultralyticsInput,
      routeId: "ultralytics.pt.rknn",
      targetFormat: "rknn",
      options: { ...ultralyticsInput.options, precision: "fp16", chip: "rk3588" },
    });
    expect(preview).toBe(
      "yolo export model=/tmp/best.pt format=rknn imgsz=640 batch=1 quantize=16 name=rk3588",
    );
  });

  test("ultralytics RKNN — omits name when chip empty", () => {
    const preview = buildCommandPreview({
      ...ultralyticsInput,
      routeId: "ultralytics.pt.rknn",
      targetFormat: "rknn",
      options: { ...ultralyticsInput.options, chip: "" },
    });
    expect(preview).not.toContain("name=");
    expect(preview).toContain("quantize=32");
  });

  test("ultralytics RKNN — normalized INT8-only chip emits quantize=8 and lowercase name", () => {
    const options = normalizeOptionsForRoute("ultralytics.pt.rknn", {
      ...ultralyticsInput.options,
      chip: "RV1106B",
      precision: "fp16",
    });
    const preview = buildCommandPreview({
      ...ultralyticsInput,
      routeId: "ultralytics.pt.rknn",
      targetFormat: "rknn",
      options,
    });
    expect(preview).toContain("quantize=8");
    expect(preview).toContain("name=rv1106b");
  });

  test("rfdetr ONNX auto mode — includes output-dir and variant-mode, no quantize", () => {
    const preview = buildCommandPreview({
      ...rfdetrInput,
      rfdetrVariantMode: "auto",
    });
    expect(preview).toBe(
      "python rfdetr_export_helper.py export \\\n" +
      "  --checkpoint /tmp/checkpoint.pth \\\n" +
      "  --route-id rfdetr.pth.onnx \\\n" +
      "  --output-dir /tmp/output \\\n" +
      "  --variant-mode auto \\\n" +
      "  --imgsz 640 \\\n" +
      "  --batch 1",
    );
    expect(preview).not.toContain("quantize=");
  });

  test("rfdetr ONNX manual mode — includes manual-class-symbol", () => {
    const preview = buildCommandPreview({
      ...rfdetrInput,
      options: { ...rfdetrInput.options, opset: 18 },
      rfdetrVariantMode: "manual",
      rfdetrManualClassSymbol: "RFDETRLarge",
    });
    expect(preview).toBe(
      "python rfdetr_export_helper.py export \\\n" +
      "  --checkpoint /tmp/checkpoint.pth \\\n" +
      "  --route-id rfdetr.pth.onnx \\\n" +
      "  --output-dir /tmp/output \\\n" +
      "  --variant-mode manual \\\n" +
      "  --imgsz 640 \\\n" +
      "  --batch 1 \\\n" +
      "  --opset 18 \\\n" +
      "  --manual-class-symbol RFDETRLarge",
    );
  });

  test("rfdetr — opset omitted when null", () => {
    const preview = buildCommandPreview({
      ...rfdetrInput,
      rfdetrVariantMode: "auto",
    });
    expect(preview).not.toContain("--opset");
  });

  test("rfdetr — output-dir fallback when not provided", () => {
    const preview = buildCommandPreview({
      ...rfdetrInput,
      outputDir: undefined,
      rfdetrVariantMode: "auto",
    });
    expect(preview).toContain("--output-dir ...");
  });

  test("rfdetr preview reflects detected native image size", () => {
    const preview = buildCommandPreview({
      ...rfdetrInput,
      options: { ...rfdetrInput.options, imgsz: 512 },
      rfdetrVariantMode: "auto",
    });
    expect(preview).toContain("--imgsz 512");
  });
});
