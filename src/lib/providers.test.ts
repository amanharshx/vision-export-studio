// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import { shouldAutofillRfDetrImgsz } from "@/features/export/export-workspace";

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
