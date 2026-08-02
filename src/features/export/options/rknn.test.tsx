// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { routesForProvider } from "@/lib/providers";
import type { ExportOptions, RouteSpec } from "@/lib/types";
import { RKNN_CHIPS, RknnOptions, isRknnInt8OnlyChip, normalizeOptionsForRoute } from "./rknn";

const baseOptions: ExportOptions = {
  imgsz: 640,
  batch: 1,
  precision: "fp16",
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

function rknnRoute(): RouteSpec {
  const route = routesForProvider("ultralytics").find(
    (item) => item.id === "ultralytics.pt.rknn",
  );
  expect(route).toBeDefined();
  return route!;
}

function renderRknn(route: RouteSpec, options: ExportOptions): string {
  return renderToStaticMarkup(
    createElement(RknnOptions, {
      route,
      options,
      onOptionsChange: () => {},
    }),
  );
}

describe("RKNN chip list and helpers", () => {
  test("matches the exact upstream Rockchip chip list", () => {
    expect(RKNN_CHIPS).toEqual([
      "rk3588",
      "rk3576",
      "rk3566",
      "rk3568",
      "rk3562",
      "rv1103",
      "rv1106",
      "rv1103b",
      "rv1106b",
      "rk2118",
      "rv1126b",
    ]);
  });

  test("isRknnInt8OnlyChip normalizes trim and case", () => {
    expect(isRknnInt8OnlyChip(" RV1106B ")).toBe(true);
    expect(isRknnInt8OnlyChip("rv1103")).toBe(true);
    expect(isRknnInt8OnlyChip("rk3588")).toBe(false);
  });

  test("normalizeOptionsForRoute normalizes RV1106B to int8", () => {
    const normalized = normalizeOptionsForRoute("ultralytics.pt.rknn", {
      ...baseOptions,
      chip: "RV1106B",
      precision: "fp16",
    });
    expect(normalized.chip).toBe("rv1106b");
    expect(normalized.precision).toBe("int8");
  });

  test("normalizeOptionsForRoute preserves FP16 for normal chips", () => {
    const normalized = normalizeOptionsForRoute("ultralytics.pt.rknn", {
      ...baseOptions,
      chip: "rk3588",
      precision: "fp16",
    });
    expect(normalized.chip).toBe("rk3588");
    expect(normalized.precision).toBe("fp16");
  });

  test("normalizeOptionsForRoute leaves non-RKNN routes untouched", () => {
    const options: ExportOptions = {
      ...baseOptions,
      chip: "RV1106B",
      precision: "fp16",
    };
    const normalized = normalizeOptionsForRoute("ultralytics.pt.onnx", options);
    expect(normalized).toBe(options);
  });
});

describe("RknnOptions", () => {
  test("INT8-only chip with normalized state forces INT8 and hides the precision selector", () => {
    const markup = renderRknn(rknnRoute(), { ...baseOptions, chip: "rv1106", precision: "int8" });
    expect(markup).toContain("INT8");
    expect(markup.split('data-slot="select-trigger"')).toHaveLength(2);
  });

  test("normal chip keeps the interactive precision selector", () => {
    const markup = renderRknn(rknnRoute(), { ...baseOptions, chip: "rk3588" });
    expect(markup.split('data-slot="select-trigger"')).toHaveLength(3);
  });
});
