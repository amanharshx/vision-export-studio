// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { routesForProvider } from "@/lib/providers";
import type { ExportOptions, RouteSpec } from "@/lib/types";
import { RKNN_CHIPS, RknnOptions, isRknnInt8OnlyChip } from "./rknn";

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
});

describe("RknnOptions", () => {
  test("INT8-only chip forces INT8 and hides the precision selector", () => {
    const markup = renderRknn(rknnRoute(), { ...baseOptions, chip: "rv1106" });
    expect(markup).toContain("INT8");
    expect(markup.split('data-slot="select-trigger"')).toHaveLength(2);
  });

  test("normal chip keeps the interactive precision selector", () => {
    const markup = renderRknn(rknnRoute(), { ...baseOptions, chip: "rk3588" });
    expect(markup.split('data-slot="select-trigger"')).toHaveLength(3);
  });
});
