// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import { buildCommandPreview } from "./command-preview";
import type { CommandPreviewInput } from "./command-preview";

const ultralyticsInput: CommandPreviewInput = {
  providerId: "ultralytics",
  routeId: "ultralytics.pt.onnx",
  targetFormat: "onnx",
  sourcePath: "/tmp/best.pt",
  options: {
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
  },
};

describe("buildCommandPreview", () => {
  test("ultralytics ONNX default options — full path, no optional flags", () => {
    const preview = buildCommandPreview(ultralyticsInput);
    expect(preview).toBe("yolo export model=/tmp/best.pt format=onnx imgsz=640 batch=1");
  });

  test("ultralytics ONNX — half, simplify, opset", () => {
    const preview = buildCommandPreview({
      ...ultralyticsInput,
      options: { ...ultralyticsInput.options, half: true, simplify: true, opset: 11 },
    });
    expect(preview).toBe(
      "yolo export model=/tmp/best.pt format=onnx imgsz=640 batch=1 half=True simplify=True opset=11",
    );
  });

  test("ultralytics — int8, dynamic", () => {
    const preview = buildCommandPreview({
      ...ultralyticsInput,
      options: { ...ultralyticsInput.options, int8: true, dynamic: true },
    });
    expect(preview).toBe(
      "yolo export model=/tmp/best.pt format=onnx imgsz=640 batch=1 int8=True dynamic=True",
    );
  });

  test("ultralytics — optimize, nms, end2end, keras, workspace", () => {
    const preview = buildCommandPreview({
      ...ultralyticsInput,
      routeId: "ultralytics.pt.engine",
      targetFormat: "engine",
      options: {
        ...ultralyticsInput.options,
        optimize: true,
        nms: true,
        endToEnd: true,
        keras: true,
        workspace: 4,
      },
    });
    expect(preview).toBe(
      "yolo export model=/tmp/best.pt format=engine imgsz=640 batch=1 optimize=True nms=True end2end=True keras=True workspace=4",
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

  test("ultralytics RKNN — includes name=chip", () => {
    const preview = buildCommandPreview({
      ...ultralyticsInput,
      routeId: "ultralytics.pt.rknn",
      targetFormat: "rknn",
      options: { ...ultralyticsInput.options, chip: "rk3588" },
    });
    expect(preview).toBe(
      "yolo export model=/tmp/best.pt format=rknn imgsz=640 batch=1 name=rk3588",
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
  });

  test("rfdetr ONNX auto mode — includes output-dir and variant-mode", () => {
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
