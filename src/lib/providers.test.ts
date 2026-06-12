// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import {
  defaultRouteForProvider,
  hasAllowedSourceExtension,
  providers,
  routesForProvider,
} from "./routes";

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
});