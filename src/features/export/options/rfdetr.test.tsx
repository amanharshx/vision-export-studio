// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RfDetrOptions, getRfDetrFallbackImgsz } from "./rfdetr";
import { defaultRouteForProvider } from "@/lib/providers";
import type { ExportOptions } from "@/lib/types";

const route = defaultRouteForProvider("rfdetr");

const baseOptions: ExportOptions = {
  imgsz: 512,
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

function render(options: ExportOptions, extra?: Record<string, unknown>) {
  return renderToStaticMarkup(
    createElement(RfDetrOptions, {
      route,
      options,
      onOptionsChange: () => {},
      ...extra,
    }),
  );
}

describe("getRfDetrFallbackImgsz", () => {
  test("returns a divisible standard preset without claiming native", () => {
    expect(getRfDetrFallbackImgsz(32)).toBe(384);
    expect(getRfDetrFallbackImgsz(56)).toBe(560);
    expect(getRfDetrFallbackImgsz(24)).toBe(384);
  });

  test("returns null when constraints are unknown", () => {
    expect(getRfDetrFallbackImgsz(null)).toBeNull();
    expect(getRfDetrFallbackImgsz(undefined)).toBeNull();
  });
});

describe("RfDetrOptions image-size validation", () => {
  test("shows the exact required multiple in the control", () => {
    const html = render(baseOptions, { recommendedImgsz: 512, requiredMultiple: 32 });
    expect(html).toContain("must be divisible by 32");
    expect(html).not.toContain("must be divisible by 16");
  });

  test("aligns the native step base with the multiple", () => {
    const html = render(baseOptions, { recommendedImgsz: null, requiredMultiple: 56 });
    expect(html).toContain('min="112"');
    expect(html).toContain('step="56"');
  });

  test("native size shows no error and no override copy", () => {
    const html = render(baseOptions, { recommendedImgsz: 512, requiredMultiple: 32 });
    expect(html).toContain("Native image size: 512px.");
    expect(html).not.toContain("accuracy may differ");
    expect(html).not.toContain("Reset to native");
  });

  test("divisible non-native override shows honest accuracy copy and reset", () => {
    const html = render(
      { ...baseOptions, imgsz: 640 },
      { recommendedImgsz: 512, requiredMultiple: 32 },
    );
    expect(html).toContain("resizes positional embeddings");
    expect(html).toContain("accuracy may differ");
    expect(html).toContain("Reset to native 512px");
    expect(html).not.toContain("can break ONNX export");
  });

  test("non-divisible value shows an inline error", () => {
    const html = render(
      { ...baseOptions, imgsz: 500 },
      { recommendedImgsz: 512, requiredMultiple: 32 },
    );
    expect(html).toContain("must be divisible by 32");
  });

  test("fallback preset is labeled as fallback, never as native", () => {
    const html = render(
      { ...baseOptions, imgsz: 640 },
      { recommendedImgsz: null, requiredMultiple: 56 },
    );
    expect(html).toContain("Fallback preset: 560px");
    expect(html).toContain("must be divisible by 56");
    expect(html).not.toContain("Native image size");
  });

  test("never claims every non-native size breaks ONNX export", () => {
    const html = render(
      { ...baseOptions, imgsz: 640 },
      { recommendedImgsz: 512, requiredMultiple: 32 },
    );
    expect(html).not.toContain("can break ONNX export");
    expect(html).not.toContain("break ONNX");
  });
});
