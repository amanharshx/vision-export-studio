// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, test } from "bun:test";
import { routesForProvider } from "@/lib/providers";
import type { DepCheckResult } from "@/lib/types";
import {
  getUltralyticsRouteSetupPrimaryAction,
  getUltralyticsRouteSetupStatus,
} from "./ultralytics-route-setup";

import {
  getRfDetrRouteSetupCopy,
  getRfDetrRouteSetupFallbackPackages,
  getRfDetrSetupHostRefusal,
  getRfDetrSetupInstallPackages,
  shouldHideRfDetrExportControls,
} from "./rfdetr-route-setup";

function readyOnnxResults(): DepCheckResult[] {
  return [
    { item: "rfdetr[onnx]", status: "ready", reason: "", install_hint: 'pip install "rfdetr[onnx]"' },
  ];
}

function baseInput(overrides: Partial<Parameters<typeof getUltralyticsRouteSetupStatus>[0]> = {}) {
  return {
    hostStatus: "supported" as const,
    depResults: readyOnnxResults(),
    depCheckLoading: false,
    depCheckError: null as string | null,
    setupActive: false,
    setupFailed: false,
    ...overrides,
  };
}

// The per-route readiness policy is intentionally shared with the
// Ultralytics flow (ready only from the selected route's own check); the
// RF-DETR-specific parts are the stack-scoped fallback, install selection,
// copy, and host refusal below.
describe("shared route readiness policy with RF-DETR inputs", () => {
  test("reports ready only when every dependency is ready", () => {
    expect(getUltralyticsRouteSetupStatus(baseInput())).toBe("ready");
  });

  test("reports checking while the dependency check is running", () => {
    expect(
      getUltralyticsRouteSetupStatus(baseInput({ depCheckLoading: true, depResults: null })),
    ).toBe("checking");
  });

  test("reports not set up when no healthy stack check has run", () => {
    expect(getUltralyticsRouteSetupStatus(baseInput({ depResults: null }))).toBe("not-set-up");
  });

  test("reports not set up for missing selected stack packages", () => {
    expect(
      getUltralyticsRouteSetupStatus(
        baseInput({
          depResults: [
            {
              item: "rfdetr[onnx]",
              status: "missing_package",
              reason: "RF-DETR stack environment has not been created.",
              install_hint: 'pip install "rfdetr[onnx]"',
              install_package: "rfdetr[onnx]",
            },
          ],
        }),
      ),
    ).toBe("not-set-up");
  });

  test("reports setting up while the selected stack install is active", () => {
    expect(
      getUltralyticsRouteSetupStatus(
        baseInput({
          depResults: [
            {
              item: "rfdetr[onnx]",
              status: "missing_package",
              reason: "missing",
              install_hint: 'pip install "rfdetr[onnx]"',
              install_package: "rfdetr[onnx]",
            },
          ],
          setupActive: true,
        }),
      ),
    ).toBe("setting-up");
  });

  test("reports setup incomplete after a failed setup preserves the partial stack", () => {
    expect(
      getUltralyticsRouteSetupStatus(
        baseInput({
          depResults: [
            {
              item: "rfdetr[onnx]",
              status: "missing_package",
              reason: "missing",
              install_hint: 'pip install "rfdetr[onnx]"',
              install_package: "rfdetr[onnx]",
            },
          ],
          setupFailed: true,
        }),
      ),
    ).toBe("setup-incomplete");
  });

  test("keeps shared-stack readiness per route: ONNX ready while ExecuTorch missing", () => {
    const onnxReady = getUltralyticsRouteSetupStatus(baseInput({ depResults: readyOnnxResults() }));
    const executorchMissing = getUltralyticsRouteSetupStatus(
      baseInput({
        depResults: [
          {
            item: "rfdetr[executorch]>=1.9.0",
            status: "missing_package",
            reason: "missing",
            install_hint: 'pip install "rfdetr[executorch]>=1.9.0"',
            install_package: "rfdetr[executorch]>=1.9.0",
          },
          {
            item: "torch>=2.13",
            status: "missing_package",
            reason: "missing",
            install_hint: 'pip install "torch>=2.13"',
            install_package: "torch>=2.13",
          },
        ],
      }),
    );
    expect(onnxReady).toBe("ready");
    expect(executorchMissing).toBe("not-set-up");
  });

  test("reports unavailable for hard platform restrictions before installation", () => {
    expect(getUltralyticsRouteSetupStatus(baseInput({ hostStatus: "unsupported" }))).toBe(
      "unavailable",
    );
  });

  test("reports unavailable when the backend preflight short-circuits on platform", () => {
    expect(
      getUltralyticsRouteSetupStatus(
        baseInput({
          depResults: [
            {
              item: "platform",
              status: "platform_unsupported",
              reason: "TensorRT requires Linux.",
              install_hint: "TensorRT requires Linux.",
            },
          ],
        }),
      ),
    ).toBe("unavailable");
  });

  test("reports manual step required for TFLite Python floor without an install remedy", () => {
    expect(
      getUltralyticsRouteSetupStatus(
        baseInput({
          depResults: [
            {
              item: "Python 3.12",
              status: "version_too_old",
              reason: "Python 3.13.12 is selected; TFLite requires Python 3.12.",
              install_hint:
                "Select Python 3.12, then recreate the RF-DETR TFLite export environment.",
            },
          ],
        }),
      ),
    ).toBe("manual-step-required");
  });

  test("reports check failed when dependency probing errors", () => {
    expect(
      getUltralyticsRouteSetupStatus(baseInput({ depResults: null, depCheckError: "probe crashed" })),
    ).toBe("check-failed");
  });

  test("a ready route stays ready after another route's setup failure", () => {
    expect(getUltralyticsRouteSetupStatus(baseInput({ setupFailed: true }))).toBe("ready");
  });
});

describe("shared setup primary action with RF-DETR labels", () => {
  test("offers setup for a new route and retry after failure", () => {
    expect(getUltralyticsRouteSetupPrimaryAction("not-set-up", "Set up ONNX")).toEqual({
      label: "Set up ONNX",
      enabled: true,
    });
    expect(getUltralyticsRouteSetupPrimaryAction("setup-incomplete", "Set up ONNX")).toEqual({
      label: "Retry setup",
      enabled: true,
    });
  });

  test("disables while checking, setting up, unavailable, or manual", () => {
    for (const status of ["checking", "setting-up", "unavailable", "manual-step-required"] as const) {
      expect(getUltralyticsRouteSetupPrimaryAction(status, "Set up ONNX").enabled).toBe(false);
    }
  });
});

describe("getRfDetrRouteSetupFallbackPackages", () => {
  test("ONNX setup installs only the selected route extra", () => {
    const route = routesForProvider("rfdetr").find((item) => item.id === "rfdetr.pth.onnx")!;
    expect(getRfDetrRouteSetupFallbackPackages(route)).toEqual([
      { package: "rfdetr[onnx]", prerelease: false },
    ]);
  });

  test("TensorRT setup installs only its extra", () => {
    const route = routesForProvider("rfdetr").find((item) => item.id === "rfdetr.pth.engine")!;
    expect(getRfDetrRouteSetupFallbackPackages(route)).toEqual([
      { package: "rfdetr[tensorrt]", prerelease: false },
    ]);
  });

  test("CoreML setup installs only its extra", () => {
    const route = routesForProvider("rfdetr").find((item) => item.id === "rfdetr.pth.coreml")!;
    expect(getRfDetrRouteSetupFallbackPackages(route)).toEqual([
      { package: "rfdetr[coreml]", prerelease: false },
    ]);
  });

  test("TFLite setup installs the pinned extra", () => {
    const route = routesForProvider("rfdetr").find((item) => item.id === "rfdetr.pth.tflite")!;
    expect(getRfDetrRouteSetupFallbackPackages(route)).toEqual([
      { package: "rfdetr[tflite]>=1.9.4", prerelease: false },
    ]);
  });

  test("ExecuTorch setup installs all three declared rows including pre-release flatc", () => {
    const route = routesForProvider("rfdetr").find(
      (item) => item.id === "rfdetr.pth.executorch",
    )!;
    const packages = getRfDetrRouteSetupFallbackPackages(route);
    expect(packages.map((item) => item.package)).toEqual([
      "rfdetr[executorch]>=1.9.0",
      "torch>=2.13",
      "flatc",
    ]);
  });
});

describe("getRfDetrSetupInstallPackages", () => {
  test("missing stack always installs the full route fallback", () => {
    const route = routesForProvider("rfdetr").find((item) => item.id === "rfdetr.pth.onnx")!;
    expect(
      getRfDetrSetupInstallPackages(route, { results: null, routeId: null, error: null, pythonPath: null }, { needsWork: true }),
    ).toEqual([{ package: "rfdetr[onnx]", prerelease: false }]);
  });

  test("existing stack installs only missing packages from its own check", () => {
    const route = routesForProvider("rfdetr").find(
      (item) => item.id === "rfdetr.pth.executorch",
    )!;
    expect(
      getRfDetrSetupInstallPackages(
        route,
        {
          results: [
            { item: "rfdetr[executorch]>=1.9.0", status: "ready", reason: "", install_hint: 'pip install "rfdetr[executorch]>=1.9.0"' },
            { item: "torch>=2.13", status: "missing_package", reason: "missing", install_hint: 'pip install "torch>=2.13"', install_package: "torch>=2.13" },
            { item: "flatc", status: "missing_package", reason: "missing", install_hint: "python -m pip install --pre flatc", install_package: "flatc", prerelease: true },
          ],
          routeId: "rfdetr.pth.executorch",
          error: null,
          pythonPath: "/other/python",
        },
        { needsWork: false },
      ),
    ).toEqual([
      { package: "torch>=2.13", prerelease: false },
      { package: "flatc", prerelease: true },
    ]);
  });

  test("a stale check from another route falls back to the full route packages", () => {
    const route = routesForProvider("rfdetr").find((item) => item.id === "rfdetr.pth.onnx")!;
    expect(
      getRfDetrSetupInstallPackages(
        route,
        {
          results: [
            { item: "rfdetr[tensorrt]", status: "missing_package", reason: "missing", install_hint: 'pip install "rfdetr[tensorrt]"', install_package: "rfdetr[tensorrt]" },
          ],
          routeId: "rfdetr.pth.engine",
          error: null,
          pythonPath: "/other/python",
        },
        { needsWork: false },
      ),
    ).toEqual([{ package: "rfdetr[onnx]", prerelease: false }]);
  });
});

describe("getRfDetrSetupHostRefusal", () => {
  test("refuses with the exact host reason when the route is unsupported", () => {
    expect(
      getRfDetrSetupHostRefusal(
        "rfdetr.pth.engine",
        [{ route_id: "rfdetr.pth.engine", status: "unsupported", reason: "TensorRT requires an NVIDIA GPU." }],
        { results: null, routeId: null, error: null, pythonPath: null },
      ),
    ).toBe("TensorRT requires an NVIDIA GPU.");
  });

  test("refuses when host support errored for the route", () => {
    expect(
      getRfDetrSetupHostRefusal(
        "rfdetr.pth.coreml",
        [{ route_id: "rfdetr.pth.coreml", status: "error", reason: "Host compatibility check failed: boom" }],
        { results: null, routeId: null, error: null, pythonPath: null },
      ),
    ).toBe("Host compatibility check failed: boom");
  });

  test("refuses with the platform row when the backend preflight short-circuited", () => {
    expect(
      getRfDetrSetupHostRefusal(
        "rfdetr.pth.engine",
        [{ route_id: "rfdetr.pth.engine", status: "supported" }],
        {
          results: [
            { item: "platform", status: "platform_unsupported", reason: "TensorRT requires Linux.", install_hint: "TensorRT requires Linux." },
          ],
          routeId: "rfdetr.pth.engine",
          error: null,
          pythonPath: "/tmp/python",
        },
      ),
    ).toBe("TensorRT requires Linux.");
  });

  test("ignores other routes and allows supported routes", () => {
    expect(
      getRfDetrSetupHostRefusal(
        "rfdetr.pth.onnx",
        [{ route_id: "rfdetr.pth.engine", status: "unsupported", reason: "TensorRT requires Linux." }],
        { results: null, routeId: null, error: null, pythonPath: null },
      ),
    ).toBeNull();
    expect(
      getRfDetrSetupHostRefusal(
        "rfdetr.pth.onnx",
        [{ route_id: "rfdetr.pth.onnx", status: "supported" }],
        { results: readyOnnxResults(), routeId: "rfdetr.pth.onnx", error: null, pythonPath: "/tmp/python" },
      ),
    ).toBeNull();
  });
});

describe("shouldHideRfDetrExportControls", () => {
  test("hides options, preview, and export start until the exact route is ready", () => {
    for (const status of ["checking", "not-set-up", "setting-up", "setup-incomplete", "unavailable", "manual-step-required", "check-failed"] as const) {
      expect(shouldHideRfDetrExportControls("rfdetr", status)).toBe(true);
    }
    expect(shouldHideRfDetrExportControls("rfdetr", "ready")).toBe(false);
  });

  test("leaves other providers untouched", () => {
    expect(shouldHideRfDetrExportControls("ultralytics", "not-set-up")).toBe(false);
  });
});

describe("getRfDetrRouteSetupCopy", () => {
  test("names the selected stack without percentages", () => {
    const copy = getRfDetrRouteSetupCopy("not-set-up", "ONNX", "rfdetr-default");
    expect(copy.body).toContain("ONNX");
    expect(copy.body).not.toContain("%");
  });

  test("falls back to the route environment when the stack mapping is unresolved", () => {
    const copy = getRfDetrRouteSetupCopy("not-set-up", "ONNX", null);
    expect(copy.title).toContain("Not set up");
    expect(copy.body).toContain("ONNX");
    expect(copy.body).not.toContain("rfdetr.pth.onnx");
    expect(copy.body).not.toContain("%");
  });

  test("setup-incomplete preserves retry and recreate guidance", () => {
    const copy = getRfDetrRouteSetupCopy("setup-incomplete", "ONNX", "rfdetr-default");
    expect(copy.body).toContain("Retry");
    expect(copy.body).toContain("Recreate");
  });
});
