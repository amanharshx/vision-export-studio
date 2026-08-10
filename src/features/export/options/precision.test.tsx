// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { routesForProvider } from "@/lib/providers";
import type { ExportOptions, RouteSpec } from "@/lib/types";
import {
  CALIBRATION_FALLBACK_WARNING,
  CALIBRATION_SELECTED_LABEL,
  PRECISION_LABELS,
  PrecisionOptions,
} from "./precision";
import { RfDetrOptions } from "./rfdetr";

const baseOptions: ExportOptions = {
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
};

function routeById(id: string): RouteSpec {
  const route = routesForProvider("ultralytics").find((item) => item.id === id);
  expect(route).toBeDefined();
  return route!;
}

function renderPrecision(route: RouteSpec, options: ExportOptions): string {
  return renderToStaticMarkup(
    createElement(PrecisionOptions, {
      route,
      options,
      onOptionsChange: () => {},
    }),
  );
}

describe("PrecisionOptions", () => {
  test("LiteRT renders an interactive selector exposing W8A32", () => {
    const litert = routeById("ultralytics.pt.litert");
    expect(litert.precisionModes.map((mode) => PRECISION_LABELS[mode])).toEqual([
      "FP32",
      "INT8",
      "W8A16",
      "W8A32",
    ]);
    const markup = renderPrecision(litert, { ...baseOptions, precision: "fp32" });
    expect(markup).toContain("data-slot=\"select-trigger\"");
  });

  test("CoreML renders an interactive selector including W8A16", () => {
    const coreml = routeById("ultralytics.pt.coreml");
    expect(coreml.precisionModes.map((mode) => PRECISION_LABELS[mode])).toContain("W8A16");
    const markup = renderPrecision(coreml, { ...baseOptions, precision: "fp16" });
    expect(markup).toContain("data-slot=\"select-trigger\"");
  });

  test("RF-DETR CoreML renders precision but not ONNX opset", () => {
    const route = routesForProvider("rfdetr").find((item) => item.id === "rfdetr.pth.coreml");
    expect(route).toBeDefined();
    const markup = renderToStaticMarkup(
      createElement(RfDetrOptions, {
        route: route!,
        options: { ...baseOptions, precision: "fp32" },
        onOptionsChange: () => {},
      }),
    );

    expect(markup).toContain("data-slot=\"select-trigger\"");
    expect(markup).not.toContain("Opset");
  });

  test("RF-DETR TFLite labels selector Quantization and hides calibration outside INT8", () => {
    const route = routesForProvider("rfdetr").find((item) => item.id === "rfdetr.pth.tflite");
    expect(route).toBeDefined();

    for (const precision of ["fp32", "fp16"] as const) {
      const markup = renderToStaticMarkup(
        createElement(RfDetrOptions, { route: route!, options: { ...baseOptions, precision }, onOptionsChange: () => {} }),
      );
      expect(markup).toContain("Quantization");
      expect(markup).not.toContain("Browse calibration dataset");
    }
  });

  test("RF-DETR TFLite INT8 shows directory calibration and max-images controls", () => {
    const route = routesForProvider("rfdetr").find((item) => item.id === "rfdetr.pth.tflite");
    const markup = renderToStaticMarkup(
      createElement(RfDetrOptions, { route: route!, options: { ...baseOptions, precision: "int8" }, onOptionsChange: () => {} }),
    );

    expect(markup).toContain("Browse calibration directory");
    expect(markup).toContain("Max images");
  });

  test("FP32 hides calibration picker", () => {
    const onnx = routeById("ultralytics.pt.onnx");
    const markup = renderPrecision(onnx, { ...baseOptions, precision: "fp32" });
    expect(markup).not.toContain(CALIBRATION_FALLBACK_WARNING);
    expect(markup).not.toContain("Browse calibration dataset");
  });

  test("LiteRT INT8 shows calibration picker and fallback warning", () => {
    const litert = routeById("ultralytics.pt.litert");
    const markup = renderPrecision(litert, { ...baseOptions, precision: "int8" });
    expect(markup).toContain("Browse calibration dataset");
    expect(markup).toContain(CALIBRATION_FALLBACK_WARNING);
  });

  test("EdgeTPU and Axelera render fixed precision with calibration picker", () => {
    for (const id of ["ultralytics.pt.edgetpu", "ultralytics.pt.axelera"]) {
      const markup = renderPrecision(routeById(id), { ...baseOptions, precision: "int8" });
      expect(markup).not.toContain("data-slot=\"select-trigger\"");
      expect(markup).toContain("Browse calibration dataset");
      expect(markup).toContain(CALIBRATION_FALLBACK_WARNING);
    }
  });

  test("multi-precision route renders an interactive select", () => {
    const onnx = routeById("ultralytics.pt.onnx");
    const markup = renderPrecision(onnx, { ...baseOptions, precision: "fp16" });
    expect(markup).toContain("data-slot=\"select-trigger\"");
  });

  test("TensorRT INT8 shows calibration picker", () => {
    const engine = routeById("ultralytics.pt.engine");
    const markup = renderPrecision(engine, { ...baseOptions, precision: "int8" });
    expect(markup).toContain("Browse calibration dataset");
  });

  test("MNN INT8 hides calibration picker", () => {
    const mnn = routeById("ultralytics.pt.mnn");
    const markup = renderPrecision(mnn, { ...baseOptions, precision: "int8" });
    expect(markup).not.toContain("Browse calibration dataset");
    expect(markup).not.toContain(CALIBRATION_FALLBACK_WARNING);
  });

  test("selected calibration path shows dataset label and clear action", () => {
    const engine = routeById("ultralytics.pt.engine");
    const markup = renderPrecision(engine, {
      ...baseOptions,
      precision: "int8",
      calibrationData: "/tmp/calibration.yaml",
    });
    expect(markup).toContain(CALIBRATION_SELECTED_LABEL);
    expect(markup).toContain("/tmp/calibration.yaml");
    expect(markup).toContain("Clear");
    expect(markup).not.toContain(CALIBRATION_FALLBACK_WARNING);
  });
});
